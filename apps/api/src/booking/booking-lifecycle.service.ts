import { Inject, Injectable } from '@nestjs/common';
import {
  RESCHEDULABLE_BOOKING_STATUSES,
  reservationPeriod,
  servicePeriod,
  type BookingStatus,
} from '@onetappe/domain';
import { sql, type Kysely } from 'kysely';
import { Clock } from '../common/clock.js';
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  ValidationError,
  type AppError,
} from '../common/errors.js';
import type { ActionContext } from '../database/action-context.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { asSystem, inTransaction, setEvent, type Tx } from '../database/transaction.js';
import { validateScheduledStart } from './booking-schedule.js';
import { BookingTransitionService, type LockedBooking } from './booking-transition.service.js';
import { CapacityService } from './capacity.service.js';
import { DispatchService } from './dispatch.service.js';
import { VerificationCodeService } from './verification-code.service.js';

/** Field events a worker performs on their accepted job. */
export type FieldEvent = 'START_TRAVEL' | 'MARK_ARRIVED' | 'COMPLETE_SERVICE' | 'CUSTOMER_NO_SHOW';

@Injectable()
export class BookingLifecycleService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly clock: Clock,
    private readonly transitions: BookingTransitionService,
    private readonly capacity: CapacityService,
    private readonly dispatch: DispatchService,
    private readonly codes: VerificationCodeService,
  ) {}

  /** Cancels a booking. The database releases its reservations and open offers. */
  async cancel(bookingId: string, reason: string, context: ActionContext): Promise<void> {
    await inTransaction(this.db, context, async (tx) => {
      const booking = await this.transitions.lock(tx, bookingId);
      this.assertCustomerOwns(booking, context);
      await this.transitions.apply(tx, booking, 'CANCEL', context, { reason });
      await this.releasePromotion(tx, bookingId);
    });
  }

  /**
   * Moves a booking to a new start time. The original promise is kept by the database;
   * every change is recorded. Capacity moves atomically: if no worker is free at the new
   * time, nothing changes.
   */
  async reschedule(
    bookingId: string,
    newStart: Date,
    reason: string,
    context: ActionContext,
  ): Promise<{ scheduledStart: Date; scheduledEnd: Date }> {
    const trimmedReason = reason.trim();
    if (!trimmedReason) throw new ValidationError('REASON_REQUIRED', 'Please give a reason');

    return inTransaction(this.db, context, async (tx) => {
      let booking = await this.transitions.lock(tx, bookingId);
      this.assertCustomerOwns(booking, context);
      if (!RESCHEDULABLE_BOOKING_STATUSES.includes(booking.status)) {
        throw new BusinessRuleError(
          'CANNOT_RESCHEDULE',
          `Booking ${booking.bookingCode} cannot be rescheduled once it is ${booking.status}`,
        );
      }

      const service = await tx
        .selectFrom('service')
        .selectAll()
        .where('id', '=', booking.serviceId)
        .executeTakeFirstOrThrow();
      const start = validateScheduledStart(service, newStart, this.clock.now());
      const durationMinutes = Math.round(
        (booking.scheduledEnd.getTime() - booking.scheduledStart.getTime()) / 60_000,
      );
      const timing = {
        durationMinutes,
        bufferBeforeMinutes: service.buffer_before_minutes,
        bufferAfterMinutes: service.buffer_after_minutes,
      };
      const promise = servicePeriod(start, timing);

      // An accepted worker was committed to the old time only.
      if (booking.status === 'ASSIGNED') {
        const assigned = booking;
        await asSystem(tx, context, (systemContext) =>
          this.transitions.apply(tx, assigned, 'WORKER_UNASSIGNED', systemContext, {
            reason: `Rescheduled: ${trimmedReason}`,
          }),
        );
        booking = { ...booking, status: 'CONFIRMED' };
      }
      // CANCELLED, not WITHDRAWN: the worker did not step away, so they stay eligible
      // for the new time.
      await tx
        .updateTable('booking_assignment')
        .set({ status: 'CANCELLED', end_reason: 'RESCHEDULED' })
        .where('booking_id', '=', booking.id)
        .where('status', 'in', ['OFFERED', 'ACCEPTED'])
        .execute();

      const held = await tx
        .selectFrom('worker_reservation')
        .select(['id', 'worker_id', 'crew_slot', 'hold_expires_at'])
        .where('booking_id', '=', booking.id)
        .where('status', 'in', ['HELD', 'ALLOCATED', 'ACCEPTED'])
        .execute();
      for (const reservation of held) {
        await this.capacity.release(tx, reservation.id, 'RESCHEDULED');
      }

      await setEvent(tx, 'RESCHEDULE', trimmedReason);
      await tx
        .updateTable('booking')
        .set({ scheduled_start: promise.start, scheduled_end: promise.end })
        .where('id', '=', booking.id)
        .execute();
      await setEvent(tx, '', null);

      const moved: LockedBooking = {
        ...booking,
        scheduledStart: promise.start,
        scheduledEnd: promise.end,
      };
      await this.reReserve(tx, moved, service, timing, context);
      return { scheduledStart: promise.start, scheduledEnd: promise.end };
    });
  }

  /**
   * Closes a completed or no-show booking once money is settled and follow-up is done.
   * Called by settlement (SYSTEM) or by operations.
   */
  async close(bookingId: string, context: ActionContext): Promise<void> {
    if (context.source !== 'SYSTEM' && context.source !== 'ADMIN') {
      throw new ForbiddenError(
        'ACTION_NOT_ALLOWED_FOR_CHANNEL',
        'Only settlement or operations can close bookings',
      );
    }
    await inTransaction(this.db, context, async (tx) => {
      const booking = await this.transitions.lock(tx, bookingId);
      await this.transitions.apply(tx, booking, 'CLOSE', context);
    });
  }

  /** Expires bookings whose payment window has passed. Run by the scheduler. */
  async expireUnpaid(context: ActionContext, limit = 100): Promise<number> {
    const due = await this.db
      .selectFrom('booking')
      .select('id')
      .where('status', '=', 'PENDING_PAYMENT')
      .where('payment_due_by', '<', sql<Date>`now()`)
      .orderBy('payment_due_by')
      .limit(limit)
      .execute();

    let expired = 0;
    for (const { id } of due) {
      const done = await inTransaction(this.db, context, async (tx) => {
        const booking = await this.transitions.lock(tx, id);
        if (booking.status !== 'PENDING_PAYMENT') return false;
        await this.transitions.apply(tx, booking, 'HOLD_EXPIRED', context);
        await this.releasePromotion(tx, id);
        return true;
      });
      if (done) expired += 1;
    }
    return expired;
  }

  /** Travel, arrival, completion and customer no-show, reported by the assigned worker. */
  async recordFieldEvent(
    bookingId: string,
    event: FieldEvent,
    context: ActionContext,
    reason: string | null = null,
  ): Promise<BookingStatus> {
    return inTransaction(this.db, context, async (tx) => {
      const booking = await this.transitions.lock(tx, bookingId);
      await this.assertAssignedWorker(tx, booking, context);
      const status = await this.transitions.apply(tx, booking, event, context, {
        reason,
      });
      if (event === 'COMPLETE_SERVICE') {
        await tx
          .updateTable('booking_assignment')
          .set({ status: 'COMPLETED', end_reason: 'SERVICE_COMPLETED' })
          .where('booking_id', '=', bookingId)
          .where('status', '=', 'ACCEPTED')
          .execute();
      }
      return status;
    });
  }

  /**
   * Starts the service after the worker enters the customer's start code. Operations
   * may start without a code only with a written reason (e.g. customer has no phone).
   */
  async startService(
    bookingId: string,
    context: ActionContext,
    verification: { code: string } | { overrideReason: string },
  ): Promise<BookingStatus> {
    const outcome = await inTransaction(
      this.db,
      context,
      async (tx): Promise<{ status: BookingStatus } | { error: AppError }> => {
        const booking = await this.transitions.lock(tx, bookingId);
        await this.assertAssignedWorker(tx, booking, context);
        if (booking.status !== 'ARRIVED') {
          throw new BusinessRuleError(
            'INVALID_STATUS_TRANSITION',
            `Booking ${booking.bookingCode} is ${booking.status}; the service cannot start yet`,
          );
        }

        let reason: string | null = null;
        if ('code' in verification) {
          const result = await this.codes.verify(tx, bookingId, 'START', verification.code);
          // Commit the attempt counter, then report the failure.
          if (!result.ok) return { error: result.error };
        } else {
          if (context.source !== 'ADMIN') {
            throw new ForbiddenError('CODE_REQUIRED', "The customer's start code is required");
          }
          reason = verification.overrideReason.trim();
          if (!reason) throw new ValidationError('REASON_REQUIRED', 'Explain why no code was used');
          reason = `Start code overridden: ${reason}`;
        }

        const status = await this.transitions.apply(tx, booking, 'START_SERVICE', context, {
          reason,
        });
        return { status };
      },
    );
    if ('error' in outcome) throw outcome.error;
    return outcome.status;
  }

  private async reReserve(
    tx: Tx,
    booking: LockedBooking,
    service: { workers_required: number },
    timing: { durationMinutes: number; bufferBeforeMinutes: number; bufferAfterMinutes: number },
    context: ActionContext,
  ): Promise<void> {
    if (booking.status === 'ON_HOLD') return;

    if (booking.status === 'CONFIRMED') {
      const result = await this.dispatch.allocateAndOffer(tx, booking, context);
      if (result.unfilledCrewSlots.length > 0) throw noAvailability(booking.scheduledStart);
      return;
    }

    // PENDING_PAYMENT: hold capacity again until the existing payment deadline.
    const due = await tx
      .selectFrom('booking')
      .select('payment_due_by')
      .where('id', '=', booking.id)
      .executeTakeFirstOrThrow();
    if (!due.payment_due_by || due.payment_due_by <= this.clock.now()) {
      throw new BusinessRuleError(
        'PAYMENT_WINDOW_CLOSED',
        'Payment time has run out; please book again',
      );
    }
    const blocked = reservationPeriod(booking.scheduledStart, timing);
    for (let slot = 1; slot <= service.workers_required; slot += 1) {
      const reservation = await this.capacity.reserve(tx, {
        bookingId: booking.id,
        serviceId: booking.serviceId,
        zoneId: booking.zoneId,
        period: blocked,
        crewSlot: slot,
        bookingType: booking.bookingType,
        status: 'HELD',
        holdExpiresAt: due.payment_due_by,
      });
      if (!reservation) throw noAvailability(booking.scheduledStart);
    }
  }

  private assertCustomerOwns(booking: LockedBooking, context: ActionContext): void {
    if (context.source === 'CUSTOMER_APP' && context.actorUserId !== booking.customerUserId) {
      throw new ForbiddenError('NOT_YOUR_BOOKING', 'This booking belongs to another customer');
    }
    if (context.source === 'WORKER_APP') {
      throw new ForbiddenError('ACTION_NOT_ALLOWED_FOR_CHANNEL', 'Workers cannot change bookings');
    }
  }

  private async assertAssignedWorker(
    tx: Tx,
    booking: LockedBooking,
    context: ActionContext,
  ): Promise<void> {
    if (context.source === 'ADMIN') return;
    if (context.source !== 'WORKER_APP' || !context.actorUserId) {
      throw new ForbiddenError(
        'ACTION_NOT_ALLOWED_FOR_CHANNEL',
        'Only the assigned worker can do this',
      );
    }
    const assigned = await tx
      .selectFrom('booking_assignment')
      .select('id')
      .where('booking_id', '=', booking.id)
      .where('worker_id', '=', context.actorUserId)
      .where('status', '=', 'ACCEPTED')
      .executeTakeFirst();
    if (!assigned) {
      throw new ForbiddenError('NOT_YOUR_JOB', 'You are not the assigned worker for this booking');
    }
  }

  private async releasePromotion(tx: Tx, bookingId: string): Promise<void> {
    await tx
      .updateTable('promotion_redemption')
      .set({ status: 'RELEASED' })
      .where('booking_id', '=', bookingId)
      .where('status', '<>', 'RELEASED')
      .execute();
  }
}

function noAvailability(start: Date): ConflictError {
  return new ConflictError(
    'NO_AVAILABILITY',
    'No verified worker is available at the new time. Your booking has not been changed.',
    { requestedStart: start.toISOString() },
  );
}
