import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import { Clock } from '../common/clock.js';
import {
  ForbiddenError,
  RateLimitedError,
  UnauthorizedError,
  ValidationError,
  type AppError,
} from '../common/errors.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import type { ActionContext } from '../database/action-context.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { inTransaction } from '../database/transaction.js';
import {
  DataCipher,
  hashPassword,
  passwordProblems,
  randomToken,
  sha256Hex,
  verifyPassword,
} from '../security/crypto.js';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../security/totp.js';
import type { Principal } from './principal.js';
import { SessionService, type IssuedTokens, type SessionMeta } from './session.service.js';

export const STAFF_LOGIN_POLICY = {
  maxFailedPasswords: 5,
  lockMinutes: 15,
  challengeTtlMinutes: 5,
} as const;

export type StaffLoginStep =
  | { readonly step: 'MFA_VERIFY'; readonly challengeToken: string }
  | {
      readonly step: 'MFA_ENROLL';
      readonly challengeToken: string;
      /** Shown once as a QR code / manual key for the authenticator app. */
      readonly totpSecret: string;
      readonly otpauthUrl: string;
    };

type Outcome<T> = { ok: true; value: T } | { ok: false; error: AppError };

/**
 * Staff sign-in: email + password, then an authenticator (TOTP) code, then a session.
 * Wrong passwords lock the account temporarily; TOTP codes cannot be replayed.
 */
@Injectable()
export class StaffAuthService {
  private readonly cipher: DataCipher;
  private dummyHash: Promise<string> | null = null;

  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    @Inject(ENV) env: Env,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {
    this.cipher = new DataCipher(env.DATA_ENCRYPTION_KEY);
  }

  async login(email: string, password: string, meta: SessionMeta): Promise<StaffLoginStep> {
    const context = this.context(null, meta);
    const outcome = await inTransaction(
      this.db,
      context,
      async (tx): Promise<Outcome<StaffLoginStep>> => {
        const now = this.clock.now();
        const staff = await tx
          .selectFrom('app_user as u')
          .innerJoin('staff_credential as c', 'c.user_id', 'u.id')
          .select([
            'u.id',
            'u.status',
            'c.password_hash',
            'c.failed_attempts',
            'c.locked_until',
            'c.mfa_enrolled_at',
          ])
          .where(sql<boolean>`u.email = ${email.trim()}::citext`)
          .forUpdate()
          .executeTakeFirst();

        const invalid = {
          ok: false as const,
          error: new UnauthorizedError('LOGIN_INVALID', 'Email or password is incorrect'),
        };
        if (!staff) {
          // Same work as a real check, so response time does not reveal valid emails.
          await verifyPassword(password, await this.getDummyHash());
          return invalid;
        }
        if (staff.locked_until && staff.locked_until > now) {
          return {
            ok: false,
            error: new RateLimitedError(
              'ACCOUNT_LOCKED',
              'Too many failed attempts. Try again later.',
              Math.ceil((staff.locked_until.getTime() - now.getTime()) / 1000),
            ),
          };
        }

        const passwordOk = await verifyPassword(password, staff.password_hash);
        if (!passwordOk || staff.status !== 'ACTIVE') {
          const failed = staff.failed_attempts + 1;
          const lock = failed >= STAFF_LOGIN_POLICY.maxFailedPasswords;
          await tx
            .updateTable('staff_credential')
            .set({
              failed_attempts: lock ? 0 : failed,
              locked_until: lock
                ? new Date(now.getTime() + STAFF_LOGIN_POLICY.lockMinutes * 60_000)
                : null,
            })
            .where('user_id', '=', staff.id)
            .execute();
          await this.audit.record(
            { ...context, actorUserId: staff.id },
            {
              action: 'ACCESS_DENIED',
              entityType: 'staff_login',
              entityId: staff.id,
              metadata: { reason: passwordOk ? 'ACCOUNT_INACTIVE' : 'BAD_PASSWORD', locked: lock },
            },
            tx,
          );
          return invalid;
        }

        await tx
          .updateTable('staff_credential')
          .set({ failed_attempts: 0, locked_until: null })
          .where('user_id', '=', staff.id)
          .execute();

        const challengeToken = randomToken();
        const purpose = staff.mfa_enrolled_at ? 'MFA_VERIFY' : 'MFA_ENROLL';
        await tx
          .insertInto('staff_login_challenge')
          .values({
            user_id: staff.id,
            token_hash: sha256Hex(challengeToken),
            purpose,
            expires_at: new Date(now.getTime() + STAFF_LOGIN_POLICY.challengeTtlMinutes * 60_000),
            ip: meta.ip,
          })
          .execute();

        if (purpose === 'MFA_VERIFY')
          return { ok: true, value: { step: 'MFA_VERIFY', challengeToken } };

        const totpSecret = generateTotpSecret();
        await tx
          .updateTable('staff_credential')
          .set({ totp_pending_secret_encrypted: this.cipher.encrypt(totpSecret) })
          .where('user_id', '=', staff.id)
          .execute();
        return {
          ok: true,
          value: {
            step: 'MFA_ENROLL',
            challengeToken,
            totpSecret,
            otpauthUrl: otpauthUrl(totpSecret, email.trim()),
          },
        };
      },
    );
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /** Second factor (or first-time enrolment). Creates the staff session. */
  async completeMfa(
    challengeToken: string,
    code: string,
    meta: SessionMeta,
  ): Promise<IssuedTokens> {
    const outcome = await inTransaction(
      this.db,
      this.context(null, meta),
      async (tx): Promise<Outcome<IssuedTokens>> => {
        const now = this.clock.now();
        const invalid = {
          ok: false as const,
          error: new UnauthorizedError('MFA_INVALID', 'The code is incorrect or has expired'),
        };
        const challenge = await tx
          .selectFrom('staff_login_challenge')
          .selectAll()
          .where('token_hash', '=', sha256Hex(challengeToken))
          .forUpdate()
          .executeTakeFirst();
        if (
          !challenge ||
          challenge.consumed_at ||
          challenge.expires_at <= now ||
          challenge.attempts >= challenge.max_attempts
        ) {
          return invalid;
        }

        const credential = await tx
          .selectFrom('staff_credential')
          .selectAll()
          .where('user_id', '=', challenge.user_id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const encrypted =
          challenge.purpose === 'MFA_ENROLL'
            ? credential.totp_pending_secret_encrypted
            : credential.totp_secret_encrypted;
        if (!encrypted) return invalid;

        const step = verifyTotp(this.cipher.decrypt(encrypted), code, now);
        const replay =
          step !== null &&
          credential.totp_last_used_step !== null &&
          step <= credential.totp_last_used_step;
        if (step === null || replay) {
          await tx
            .updateTable('staff_login_challenge')
            .set({ attempts: sql<number>`attempts + 1` })
            .where('id', '=', challenge.id)
            .execute();
          return invalid;
        }

        await tx
          .updateTable('staff_login_challenge')
          .set({ consumed_at: now })
          .where('id', '=', challenge.id)
          .execute();
        await tx
          .updateTable('staff_credential')
          .set(
            challenge.purpose === 'MFA_ENROLL'
              ? {
                  totp_secret_encrypted: encrypted,
                  totp_pending_secret_encrypted: null,
                  mfa_enrolled_at: now,
                  totp_last_used_step: step,
                }
              : { totp_last_used_step: step },
          )
          .where('user_id', '=', challenge.user_id)
          .execute();

        const tokens = await this.sessions.create(tx, challenge.user_id, 'ADMIN_WEB', meta, {
          mfaVerified: true,
        });
        await this.audit.record(
          this.context(challenge.user_id, meta),
          {
            action: 'LOGIN',
            entityType: 'app_user',
            entityId: challenge.user_id,
            metadata: { app: 'ADMIN_WEB', enrolled: challenge.purpose === 'MFA_ENROLL' },
          },
          tx,
        );
        return { ok: true, value: tokens };
      },
    );
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /** Re-confirms the authenticator before a sensitive action. */
  async stepUp(principal: Principal, code: string, meta: SessionMeta): Promise<void> {
    const ok = await inTransaction(this.db, this.context(principal.userId, meta), async (tx) => {
      const now = this.clock.now();
      const credential = await tx
        .selectFrom('staff_credential')
        .select(['totp_secret_encrypted', 'totp_last_used_step'])
        .where('user_id', '=', principal.userId)
        .forUpdate()
        .executeTakeFirst();
      if (!credential?.totp_secret_encrypted) return false;
      const step = verifyTotp(this.cipher.decrypt(credential.totp_secret_encrypted), code, now);
      if (
        step === null ||
        (credential.totp_last_used_step !== null && step <= credential.totp_last_used_step)
      ) {
        return false;
      }
      await tx
        .updateTable('staff_credential')
        .set({ totp_last_used_step: step })
        .where('user_id', '=', principal.userId)
        .execute();
      await tx
        .updateTable('auth_session')
        .set({ mfa_verified_at: now })
        .where('id', '=', principal.sessionId)
        .execute();
      return true;
    });
    if (!ok) throw new UnauthorizedError('MFA_INVALID', 'The code is incorrect');
  }

  /**
   * The invited person chooses their password. The invitation is single-use and expires;
   * any existing sessions end (this is also the password reset). The authenticator is
   * enrolled at the next sign-in if it is not already.
   */
  async acceptInvitation(token: string, password: string, meta: SessionMeta): Promise<void> {
    const problems = passwordProblems(password);
    if (problems.length > 0) {
      throw new ValidationError('PASSWORD_WEAK', `Choose a password with ${problems.join(', ')}`);
    }
    const hash = await hashPassword(password);
    const accepted = await inTransaction(this.db, this.context(null, meta), async (tx) => {
      const invitation = await tx
        .selectFrom('staff_invitation as i')
        .innerJoin('app_user as u', 'u.id', 'i.user_id')
        .select(['i.id', 'i.user_id', 'u.status'])
        .where('i.token_hash', '=', sha256Hex(token))
        .where('i.accepted_at', 'is', null)
        .where('i.revoked_at', 'is', null)
        .where('i.expires_at', '>', sql<Date>`now()`)
        .forUpdate()
        .executeTakeFirst();
      if (!invitation || invitation.status !== 'ACTIVE') return false;
      await sql`SELECT set_config('app.actor_user_id', ${invitation.user_id}, true)`.execute(tx);
      await tx
        .insertInto('staff_credential')
        .values({ user_id: invitation.user_id, password_hash: hash })
        .onConflict((oc) =>
          oc.column('user_id').doUpdateSet({
            password_hash: hash,
            password_changed_at: new Date(),
            failed_attempts: 0,
            locked_until: null,
          }),
        )
        .execute();
      await tx
        .updateTable('staff_invitation')
        .set({ accepted_at: sql<Date>`now()` })
        .where('id', '=', invitation.id)
        .execute();
      await tx
        .updateTable('auth_session')
        .set({ revoked_at: new Date(), revoke_reason: 'PASSWORD_SET' })
        .where('user_id', '=', invitation.user_id)
        .where('revoked_at', 'is', null)
        .execute();
      return true;
    });
    if (!accepted) {
      throw new UnauthorizedError(
        'INVITATION_INVALID',
        'This invitation link is invalid or has expired; ask an administrator for a new one',
      );
    }
  }

  /** Sets a staff password (used when creating staff accounts). */
  async setPassword(userId: string, password: string, context: ActionContext): Promise<void> {
    const hash = await hashPassword(password);
    await inTransaction(this.db, context, (tx) =>
      tx
        .insertInto('staff_credential')
        .values({ user_id: userId, password_hash: hash })
        .onConflict((oc) =>
          oc.column('user_id').doUpdateSet({
            password_hash: hash,
            password_changed_at: new Date(),
            failed_attempts: 0,
            locked_until: null,
          }),
        )
        .execute(),
    );
  }

  private context(actorUserId: string | null, meta: SessionMeta): ActionContext {
    return { actorUserId, actorRole: 'STAFF', source: 'ADMIN', requestId: meta.requestId };
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= hashPassword(randomToken());
    return this.dummyHash;
  }
}

export function assertStaff(principal: Principal): void {
  if (principal.app !== 'ADMIN_WEB') throw new ForbiddenError('WRONG_APP', 'Staff only');
}
