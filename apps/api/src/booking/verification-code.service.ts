import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { BusinessRuleError, ValidationError, type AppError } from '../common/errors.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import type { Tx } from '../database/transaction.js';

export type CodePurpose = 'START' | 'COMPLETE';

const CODE_DIGITS = 4;

/**
 * Start/complete codes that the customer reads out to the worker.
 *
 * The code is derived from a server secret and the booking id (HMAC), so it never has
 * to be stored in clear text: the customer app asks the API to show it, and the worker
 * app submits what the customer says. Only attempt counts are stored, and a booking
 * locks after too many wrong attempts. It is never the payment OTP.
 */
@Injectable()
export class VerificationCodeService {
  constructor(@Inject(ENV) private readonly env: Env) {}

  codeFor(bookingId: string, purpose: CodePurpose): string {
    const digest = createHmac('sha256', this.env.VERIFICATION_CODE_SECRET)
      .update(`${purpose}:${bookingId}`)
      .digest();
    const value = digest.readUInt32BE(0) % 10 ** CODE_DIGITS;
    return value.toString().padStart(CODE_DIGITS, '0');
  }

  /**
   * Checks a submitted code. Returns the error instead of throwing it so the caller can
   * commit the attempt counter before reporting the failure; otherwise a rollback would
   * erase the wrong attempt and allow unlimited guessing.
   */
  async verify(
    tx: Tx,
    bookingId: string,
    purpose: CodePurpose,
    submitted: string,
  ): Promise<{ ok: true } | { ok: false; error: AppError }> {
    if (!/^\d{4}$/.test(submitted)) {
      return {
        ok: false,
        error: new ValidationError('CODE_FORMAT', 'Enter the 4-digit code shown to the customer'),
      };
    }
    const expected = this.codeFor(bookingId, purpose);

    const row = await tx
      .insertInto('booking_verification_code')
      .values({ booking_id: bookingId, purpose, code_hash: hashCode(bookingId, expected) })
      .onConflict((oc) =>
        oc.columns(['booking_id', 'purpose']).doUpdateSet({ booking_id: bookingId }),
      )
      .returning(['attempts', 'max_attempts', 'verified_at'])
      .executeTakeFirstOrThrow();

    if (row.verified_at) return { ok: true };
    if (row.attempts >= row.max_attempts) {
      return {
        ok: false,
        error: new BusinessRuleError(
          'CODE_LOCKED',
          'Too many wrong codes. Please contact support to continue.',
        ),
      };
    }

    const matches = timingSafeEqual(Buffer.from(submitted), Buffer.from(expected));
    await tx
      .updateTable('booking_verification_code')
      .set(matches ? { verified_at: sql<Date>`now()` } : { attempts: sql<number>`attempts + 1` })
      .where('booking_id', '=', bookingId)
      .where('purpose', '=', purpose)
      .execute();

    if (!matches) {
      return {
        ok: false,
        error: new ValidationError('CODE_INCORRECT', 'The code is not correct', {
          attemptsLeft: row.max_attempts - row.attempts - 1,
        }),
      };
    }
    return { ok: true };
  }
}

function hashCode(bookingId: string, code: string): string {
  return createHash('sha256').update(`${bookingId}:${code}`).digest('hex');
}
