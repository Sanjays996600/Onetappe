import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { Clock } from '../../common/clock.js';
import { RateLimitedError, UnauthorizedError, type AppError } from '../../common/errors.js';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { systemContext } from '../../database/action-context.js';
import { DATABASE } from '../../database/database.module.js';
import type { DB } from '../../database/db.generated.js';
import { inTransaction } from '../../database/transaction.js';
import { hmacSha256Hex, randomDigits, safeEqual } from '../../security/crypto.js';
import { OTP_SENDER, type OtpSender } from './otp-sender.js';

/** OTP rules. Kept together so they are easy to review and tune. */
export const OTP_POLICY = {
  codeLength: 6,
  ttlSeconds: 5 * 60,
  resendCooldownSeconds: 30,
  maxVerifyAttemptsPerCode: 5,
  maxRequestsPerPhonePerHour: 5,
  maxRequestsPerPhonePerDay: 10,
  maxRequestsPerIpPerHour: 20,
  /** Wrong codes across all challenges for one phone before it is locked for an hour. */
  maxFailedVerificationsPerPhonePerHour: 10,
} as const;

export type OtpClientApp = 'CUSTOMER_APP' | 'WORKER_APP';

export interface OtpRequested {
  readonly challengeId: string;
  readonly expiresAt: Date;
  readonly resendAvailableAt: Date;
}

@Injectable()
export class OtpService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    @Inject(OTP_SENDER) private readonly sender: OtpSender,
    @Inject(ENV) private readonly env: Env,
    private readonly clock: Clock,
  ) {}

  /**
   * Issues a code. The response is identical for new and existing numbers, so the
   * endpoint cannot be used to discover who has an account.
   */
  async request(
    phoneE164: string,
    clientApp: OtpClientApp,
    ip: string | null,
    locale: string,
    requestId: string,
  ): Promise<OtpRequested> {
    const code = randomDigits(OTP_POLICY.codeLength);

    const issued = await inTransaction(this.db, systemContext(requestId), async (tx) => {
      // One phone at a time, so parallel requests cannot all pass the cooldown check.
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`otp:${phoneE164}`}))`.execute(tx);
      const now = this.clock.now();

      const recent = await tx
        .selectFrom('otp_challenge')
        .select((eb) => [
          eb.fn.max<Date | null>('created_at').as('last'),
          eb.fn.countAll<number>().filterWhere('created_at', '>', hoursAgo(now, 1)).as('hour'),
          eb.fn.countAll<number>().filterWhere('created_at', '>', hoursAgo(now, 24)).as('day'),
          eb.fn
            .coalesce(
              eb.fn.sum<number>('attempts').filterWhere('created_at', '>', hoursAgo(now, 1)),
              sql<number>`0`,
            )
            .as('failedHour'),
        ])
        .where('phone_e164', '=', phoneE164)
        .where('created_at', '>', hoursAgo(now, 24))
        .executeTakeFirstOrThrow();

      if (recent.failedHour >= OTP_POLICY.maxFailedVerificationsPerPhonePerHour) {
        throw new RateLimitedError(
          'OTP_LOCKED',
          'Too many wrong codes. Try again in an hour.',
          3600,
        );
      }
      if (recent.last) {
        const wait =
          OTP_POLICY.resendCooldownSeconds -
          (now.getTime() - new Date(recent.last).getTime()) / 1000;
        if (wait > 0) {
          throw new RateLimitedError(
            'OTP_COOLDOWN',
            'Please wait before requesting another code.',
            Math.ceil(wait),
          );
        }
      }
      if (
        recent.hour >= OTP_POLICY.maxRequestsPerPhonePerHour ||
        recent.day >= OTP_POLICY.maxRequestsPerPhonePerDay
      ) {
        throw new RateLimitedError(
          'OTP_LIMIT',
          'Too many codes requested for this number. Try later.',
          3600,
        );
      }
      if (ip) {
        const fromIp = await tx
          .selectFrom('otp_challenge')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .where('request_ip', '=', ip)
          .where('created_at', '>', hoursAgo(now, 1))
          .executeTakeFirstOrThrow();
        if (fromIp.n >= OTP_POLICY.maxRequestsPerIpPerHour) {
          throw new RateLimitedError(
            'OTP_LIMIT',
            'Too many requests from this network. Try later.',
            3600,
          );
        }
      }

      // Only the newest code for a phone and app can be used.
      await tx
        .updateTable('otp_challenge')
        .set({ consumed_at: now })
        .where('phone_e164', '=', phoneE164)
        .where('client_app', '=', clientApp)
        .where('consumed_at', 'is', null)
        .execute();

      const expiresAt = new Date(now.getTime() + OTP_POLICY.ttlSeconds * 1000);
      const challenge = await tx
        .insertInto('otp_challenge')
        .values({
          phone_e164: phoneE164,
          purpose: 'LOGIN',
          client_app: clientApp,
          code_hash: 'pending',
          max_attempts: OTP_POLICY.maxVerifyAttemptsPerCode,
          expires_at: expiresAt,
          request_ip: ip,
          created_at: now,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await tx
        .updateTable('otp_challenge')
        .set({ code_hash: this.hash(challenge.id, code) })
        .where('id', '=', challenge.id)
        .execute();

      return {
        challengeId: challenge.id,
        expiresAt,
        resendAvailableAt: new Date(now.getTime() + OTP_POLICY.resendCooldownSeconds * 1000),
      };
    });

    // Sent after commit: a stored challenge without a delivered SMS is harmless, the
    // reverse (an SMS for a code we did not store) would confuse the user.
    await this.sender.send(phoneE164, code, locale);
    return issued;
  }

  /**
   * Checks a code. Every wrong attempt is committed before the failure is reported, so
   * attempt limits cannot be bypassed by the rollback of a failed request.
   * Returns the verified phone number.
   */
  async verify(
    challengeId: string,
    phoneE164: string,
    clientApp: OtpClientApp,
    code: string,
    requestId: string,
  ): Promise<string> {
    const outcome = await inTransaction(
      this.db,
      systemContext(requestId),
      async (tx): Promise<{ ok: true } | { ok: false; error: AppError }> => {
        const challenge = await tx
          .selectFrom('otp_challenge')
          .selectAll()
          .where('id', '=', challengeId)
          .where('phone_e164', '=', phoneE164)
          .where('client_app', '=', clientApp)
          .forUpdate()
          .executeTakeFirst();

        const invalid = {
          ok: false as const,
          error: new UnauthorizedError('OTP_INVALID', 'The code is incorrect or has expired'),
        };
        const now = this.clock.now();
        if (!challenge || challenge.consumed_at || challenge.expires_at <= now) return invalid;
        if (challenge.attempts >= challenge.max_attempts) {
          return {
            ok: false,
            error: new RateLimitedError(
              'OTP_ATTEMPTS_EXCEEDED',
              'Too many wrong codes. Request a new code.',
              0,
            ),
          };
        }

        const matches =
          /^\d{6}$/.test(code) && safeEqual(this.hash(challenge.id, code), challenge.code_hash);
        await tx
          .updateTable('otp_challenge')
          .set(matches ? { consumed_at: now } : { attempts: sql<number>`attempts + 1` })
          .where('id', '=', challenge.id)
          .execute();
        return matches ? { ok: true } : invalid;
      },
    );
    if (!outcome.ok) throw outcome.error;
    return phoneE164;
  }

  private hash(challengeId: string, code: string): string {
    return hmacSha256Hex(this.env.OTP_HASH_SECRET, `${challengeId}:${code}`);
  }
}

function hoursAgo(now: Date, hours: number): Date {
  return new Date(now.getTime() - hours * 3_600_000);
}
