import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import {
  resolveBookingTransition,
  type BookingEvent,
  type BookingStatus,
  type TransitionRejection,
} from '@onetappe/domain';
import type { ActionContext } from '../database/action-context.js';
import { setEvent, type Tx } from '../database/transaction.js';
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../common/errors.js';
import { IntegrationOutbox } from '../integrations/integration-outbox.service.js';
import { RequestContext } from '../observability/request-context.js';

export interface LockedBooking {
  readonly id: string;
  readonly bookingCode: string;
  readonly status: BookingStatus;
  readonly customerUserId: string;
  readonly serviceId: string;
  readonly zoneId: string;
  readonly bookingType: 'INSTANT' | 'SCHEDULED';
  readonly scheduledStart: Date;
  readonly scheduledEnd: Date;
  readonly version: number;
}

/**
 * Moves bookings between statuses. The domain state machine gives a clear error before
 * touching the database; the database trigger enforces the same rules and writes the
 * status history row, so neither can be bypassed.
 */
@Injectable()
export class BookingTransitionService {
  constructor(private readonly outbox: IntegrationOutbox) {}

  /** Locks the booking row for the rest of the transaction. */
  async lock(tx: Tx, bookingId: string): Promise<LockedBooking> {
    // Logs written from here on in this request carry the booking id.
    RequestContext.annotate({ bookingId });
    const row = await tx
      .selectFrom('booking')
      .select([
        'id',
        'booking_code',
        'status',
        'customer_user_id',
        'service_id',
        'zone_id',
        'booking_type',
        'scheduled_start',
        'scheduled_end',
        'version',
        sql<string>`current_setting('app.expected_booking', true)`.as('expected'),
      ])
      .where('id', '=', bookingId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new NotFoundError('Booking', bookingId);
    await this.checkExpectedVersion(tx, row);
    return {
      id: row.id,
      bookingCode: row.booking_code,
      status: row.status as BookingStatus,
      customerUserId: row.customer_user_id,
      serviceId: row.service_id,
      zoneId: row.zone_id,
      bookingType: row.booking_type as 'INSTANT' | 'SCHEDULED',
      scheduledStart: row.scheduled_start,
      scheduledEnd: row.scheduled_end,
      version: row.version,
    };
  }

  /**
   * Enforces ActionContext.expectedBookingVersion on the first lock of that booking in the
   * transaction (later locks see this transaction's own changes, so the check is spent).
   */
  private async checkExpectedVersion(
    tx: Tx,
    row: { id: string; booking_code: string; version: number; expected: string | null },
  ): Promise<void> {
    const [bookingId, version] = (row.expected ?? '').split(':');
    if (bookingId !== row.id) return;
    await sql`SELECT set_config('app.expected_booking', '', true)`.execute(tx);
    if (Number(version) !== row.version) {
      throw new ConflictError(
        'STALE_BOOKING',
        `Booking ${row.booking_code} was changed by someone else since you loaded it; refresh and try again`,
        { expectedVersion: Number(version), actualVersion: row.version },
      );
    }
  }

  /**
   * Applies `event` to a booking already locked by `lock`. Returns the new status.
   * `expectedVersion`, when given, protects against acting on a stale screen.
   */
  async apply(
    tx: Tx,
    booking: LockedBooking,
    event: BookingEvent,
    context: ActionContext,
    options: { reason?: string | null; expectedVersion?: number } = {},
  ): Promise<BookingStatus> {
    if (options.expectedVersion !== undefined && options.expectedVersion !== booking.version) {
      throw new BusinessRuleError(
        'STALE_BOOKING',
        `Booking ${booking.bookingCode} changed since it was loaded; refresh and try again`,
        { expectedVersion: options.expectedVersion, actualVersion: booking.version },
      );
    }

    const reason = options.reason?.trim() || context.reason?.trim() || null;
    const result = resolveBookingTransition({
      from: booking.status,
      event,
      source: context.source,
      reason,
    });
    if (!result.ok) throw rejectionToError(booking.bookingCode, result.rejection);

    await setEvent(tx, event, reason);
    await tx
      .updateTable('booking')
      .set({ status: result.transition.to })
      .where('id', '=', booking.id)
      .execute();
    await setEvent(tx, '', context.reason);
    // Every status change is mirrored to the CRM (when configured), after commit.
    await this.outbox.enqueue(tx, 'CRM_BOOKING_SYNC', booking.id, {
      requestId: context.requestId,
    });
    return result.transition.to;
  }
}

function rejectionToError(bookingCode: string, rejection: TransitionRejection): Error {
  switch (rejection.code) {
    case 'EVENT_NOT_ALLOWED_FROM_STATUS':
      return new BusinessRuleError(
        'INVALID_STATUS_TRANSITION',
        `Booking ${bookingCode} is ${rejection.from}; ${rejection.event} is not possible`,
        { from: rejection.from, event: rejection.event },
      );
    case 'SOURCE_NOT_ALLOWED':
      return new ForbiddenError(
        'ACTION_NOT_ALLOWED_FOR_CHANNEL',
        `${rejection.event} cannot be performed from ${rejection.source}`,
      );
    case 'REASON_REQUIRED':
      return new ValidationError('REASON_REQUIRED', `${rejection.event} requires a reason`);
  }
}
