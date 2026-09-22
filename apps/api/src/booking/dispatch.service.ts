import { Inject, Injectable } from '@nestjs/common';
import { reservationPeriod } from '@onetappe/domain';
import { sql, type Kysely } from 'kysely';
import {
  BusinessRuleError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../common/errors.js';
import type { ActionContext } from '../database/action-context.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { inTransaction, type Tx } from '../database/transaction.js';
import { BookingTransitionService, type LockedBooking } from './booking-transition.service.js';
import { BookingNotifier } from './booking-notifier.service.js';
import { CapacityService } from './capacity.service.js';

export interface Offer {
  readonly assignmentId: string;
  readonly workerId: string;
  readonly crewSlot: number;
  readonly expiresAt: Date;
}

export interface DispatchResult {
  readonly offers: readonly Offer[];
  /** Crew slots for which no eligible worker could be found; operations must act. */
  readonly unfilledCrewSlots: readonly number[];
}

/**
 * Turns a confirmed booking into an accepted worker assignment.
 *
 * Capacity is always reserved *before* an offer is made, so an offer is a real,
 * conflict-free slot. When a worker declines or does not answer in time, their
 * reservation is released and the next eligible worker is reserved and offered.
 */
@Injectable()
export class DispatchService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly transitions: BookingTransitionService,
    private readonly capacity: CapacityService,
    private readonly notifier: BookingNotifier,
  ) {}

  /** Payment captured (called by the payments module inside its transaction). */
  async confirmPaidInTx(
    tx: Tx,
    bookingId: string,
    context: ActionContext,
  ): Promise<DispatchResult> {
    const booking = await this.transitions.lock(tx, bookingId);
    await this.transitions.apply(tx, booking, 'PAYMENT_CAPTURED', context);
    await tx
      .updateTable('promotion_redemption')
      .set({ status: 'REDEEMED' })
      .where('booking_id', '=', bookingId)
      .where('status', '=', 'RESERVED')
      .execute();
    await this.notifier.toCustomer(tx, bookingId, 'BOOKING_CONFIRMED');
    return this.allocateAndOffer(tx, { ...booking, status: 'CONFIRMED' }, context);
  }

  /** Operations confirms a pay-after-service or offline-paid booking. */
  async confirmWithoutPrepayment(
    bookingId: string,
    reason: string,
    context: ActionContext,
  ): Promise<DispatchResult> {
    if (context.source !== 'ADMIN') {
      throw new ForbiddenError('ADMIN_ONLY', 'Only operations can confirm without prepayment');
    }
    return inTransaction(this.db, context, async (tx) => {
      const booking = await this.transitions.lock(tx, bookingId);
      await this.transitions.apply(tx, booking, 'CONFIRM_WITHOUT_PREPAYMENT', context, { reason });
      await this.notifier.toCustomer(tx, bookingId, 'BOOKING_CONFIRMED');
      return this.allocateAndOffer(tx, { ...booking, status: 'CONFIRMED' }, context);
    });
  }

  /** Worker (or operations on their behalf) accepts an offer. */
  async accept(assignmentId: string, context: ActionContext): Promise<void> {
    await inTransaction(this.db, context, async (tx) => {
      const { booking, assignment } = await this.lockAssignment(tx, assignmentId, context);
      if (assignment.status !== 'OFFERED') {
        throw new BusinessRuleError('OFFER_NOT_OPEN', `This offer is already ${assignment.status}`);
      }
      await tx
        .updateTable('booking_assignment')
        .set({ status: 'ACCEPTED' })
        .where('id', '=', assignment.id)
        .execute();
      await this.capacity.markAccepted(tx, assignment.reservation_id);

      const accepted = await this.acceptedSlots(tx, booking.id);
      const required = await this.workersRequired(tx, booking.serviceId);
      if (accepted >= required && booking.status === 'CONFIRMED') {
        await this.transitions.apply(tx, booking, 'WORKER_ACCEPTED', context);
        await this.notifier.toCustomer(tx, booking.id, 'WORKER_ASSIGNED', {
          dedupeSuffix: assignment.id,
        });
      }
    });
  }

  /** Worker declines an offer; the next eligible worker is reserved and offered. */
  async reject(
    assignmentId: string,
    reason: string,
    context: ActionContext,
  ): Promise<DispatchResult> {
    if (!reason.trim()) throw new ValidationError('REASON_REQUIRED', 'Please give a reason');
    return inTransaction(this.db, context, async (tx) => {
      const { booking, assignment } = await this.lockAssignment(tx, assignmentId, context);
      if (assignment.status !== 'OFFERED') {
        throw new BusinessRuleError('OFFER_NOT_OPEN', `This offer is already ${assignment.status}`);
      }
      await tx
        .updateTable('booking_assignment')
        .set({ status: 'REJECTED', response_reason: reason.trim() })
        .where('id', '=', assignment.id)
        .execute();
      await this.capacity.release(tx, assignment.reservation_id, 'OFFER_REJECTED');
      return this.allocateAndOffer(tx, booking, context);
    });
  }

  /**
   * Expires unanswered offers and moves each booking on to the next worker.
   * Run by the scheduler with a SYSTEM context. Returns how many offers expired.
   */
  async expireOverdueOffers(context: ActionContext, limit = 50): Promise<number> {
    const overdue = await this.db
      .selectFrom('booking_assignment')
      .select('id')
      .where('status', '=', 'OFFERED')
      .where('offer_expires_at', '<', sql<Date>`now()`)
      .orderBy('offer_expires_at')
      .limit(limit)
      .execute();

    let expired = 0;
    for (const { id } of overdue) {
      const done = await inTransaction(this.db, context, async (tx) => {
        const { booking, assignment } = await this.lockAssignment(tx, id, context);
        // Re-checked under lock: the worker may have answered since we looked.
        const result = await tx
          .updateTable('booking_assignment')
          .set({ status: 'EXPIRED', end_reason: 'NO_RESPONSE' })
          .where('id', '=', id)
          .where('status', '=', 'OFFERED')
          .where('offer_expires_at', '<', sql<Date>`now()`)
          .executeTakeFirst();
        if (Number(result.numUpdatedRows) === 0) return false;
        await this.capacity.release(tx, assignment.reservation_id, 'OFFER_EXPIRED');
        await this.allocateAndOffer(tx, booking, context);
        return true;
      });
      if (done) expired += 1;
    }
    return expired;
  }

  /**
   * Ensures every crew slot of a CONFIRMED booking has a reservation and a live offer.
   * HELD reservations from checkout become ALLOCATED; missing slots are re-reserved,
   * skipping workers who already declined or ignored this booking.
   */
  async allocateAndOffer(
    tx: Tx,
    booking: LockedBooking,
    context: ActionContext,
  ): Promise<DispatchResult> {
    if (booking.status !== 'CONFIRMED') return { offers: [], unfilledCrewSlots: [] };

    await this.capacity.allocateHeld(tx, booking.id);

    const service = await tx
      .selectFrom('service')
      .select([
        'workers_required',
        'duration_minutes',
        'buffer_before_minutes',
        'buffer_after_minutes',
        'offer_timeout_seconds',
      ])
      .where('id', '=', booking.serviceId)
      .executeTakeFirstOrThrow();

    const reservations = await tx
      .selectFrom('worker_reservation')
      .select(['id', 'worker_id', 'crew_slot', 'status'])
      .where('booking_id', '=', booking.id)
      .where('status', 'in', ['ALLOCATED', 'ACCEPTED'])
      .execute();

    const liveAssignments = await tx
      .selectFrom('booking_assignment')
      .select(['crew_slot'])
      .where('booking_id', '=', booking.id)
      .where('status', 'in', ['OFFERED', 'ACCEPTED'])
      .execute();
    const slotsWithLiveAssignment = new Set(liveAssignments.map((a) => a.crew_slot));

    const previouslyTried = await tx
      .selectFrom('booking_assignment')
      .select('worker_id')
      .where('booking_id', '=', booking.id)
      .where('status', 'in', ['REJECTED', 'EXPIRED', 'WITHDRAWN'])
      .execute();
    const exclude = new Set(previouslyTried.map((row) => row.worker_id));
    for (const r of reservations) exclude.add(r.worker_id);

    const durationMinutes = Math.round(
      (booking.scheduledEnd.getTime() - booking.scheduledStart.getTime()) / 60_000,
    );
    const blocked = reservationPeriod(booking.scheduledStart, {
      durationMinutes,
      bufferBeforeMinutes: service.buffer_before_minutes,
      bufferAfterMinutes: service.buffer_after_minutes,
    });

    const offers: Offer[] = [];
    const unfilled: number[] = [];

    for (let slot = 1; slot <= service.workers_required; slot += 1) {
      if (slotsWithLiveAssignment.has(slot)) continue;

      let reservation = reservations.find((r) => r.crew_slot === slot && r.status === 'ALLOCATED');
      if (!reservation) {
        const created = await this.capacity.reserve(tx, {
          bookingId: booking.id,
          serviceId: booking.serviceId,
          zoneId: booking.zoneId,
          period: blocked,
          crewSlot: slot,
          bookingType: booking.bookingType,
          status: 'ALLOCATED',
          holdExpiresAt: null,
          excludeWorkerIds: [...exclude],
        });
        if (!created) {
          unfilled.push(slot);
          continue;
        }
        exclude.add(created.workerId);
        reservation = {
          id: created.reservationId,
          worker_id: created.workerId,
          crew_slot: slot,
          status: 'ALLOCATED',
        };
      }

      const offer = await tx
        .insertInto('booking_assignment')
        .values({
          booking_id: booking.id,
          worker_id: reservation.worker_id,
          reservation_id: reservation.id,
          crew_slot: slot,
          offered_at: sql<Date>`now()`,
          offer_expires_at: sql<Date>`now() + make_interval(secs => ${service.offer_timeout_seconds})`,
          offered_by_user_id: context.actorUserId,
          source: context.source,
        })
        .returning(['id', 'worker_id', 'crew_slot', 'offer_expires_at'])
        .executeTakeFirstOrThrow();
      await this.notifier.toWorker(tx, booking.id, offer.worker_id, 'JOB_OFFER', {
        dedupeSuffix: offer.id,
        extra: { minutes: Math.max(1, Math.round(service.offer_timeout_seconds / 60)) },
      });
      offers.push({
        assignmentId: offer.id,
        workerId: offer.worker_id,
        crewSlot: offer.crew_slot,
        expiresAt: offer.offer_expires_at,
      });
    }

    if (unfilled.length > 0) {
      // Told once per booking; operations sees the booking in the unassigned queue.
      await this.notifier.toCustomer(tx, booking.id, 'NO_WORKER_AVAILABLE');
    }
    return { offers, unfilledCrewSlots: unfilled };
  }

  private async lockAssignment(tx: Tx, assignmentId: string, context: ActionContext) {
    const ref = await tx
      .selectFrom('booking_assignment')
      .select(['booking_id'])
      .where('id', '=', assignmentId)
      .executeTakeFirst();
    if (!ref) throw new NotFoundError('Assignment', assignmentId);

    // Lock order everywhere: booking, then its assignments/reservations.
    const booking = await this.transitions.lock(tx, ref.booking_id);
    const assignment = await tx
      .selectFrom('booking_assignment')
      .selectAll()
      .where('id', '=', assignmentId)
      .forUpdate()
      .executeTakeFirstOrThrow();

    if (context.source === 'WORKER_APP' && context.actorUserId !== assignment.worker_id) {
      throw new ForbiddenError('NOT_YOUR_OFFER', 'This offer belongs to another worker');
    }
    if (
      context.source !== 'WORKER_APP' &&
      context.source !== 'ADMIN' &&
      context.source !== 'SYSTEM'
    ) {
      throw new ForbiddenError(
        'ACTION_NOT_ALLOWED_FOR_CHANNEL',
        'Offers are handled by workers or operations',
      );
    }
    return { booking, assignment };
  }

  private async acceptedSlots(tx: Tx, bookingId: string): Promise<number> {
    const row = await tx
      .selectFrom('booking_assignment')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('booking_id', '=', bookingId)
      .where('status', '=', 'ACCEPTED')
      .executeTakeFirstOrThrow();
    return row.n;
  }

  private async workersRequired(tx: Tx, serviceId: string): Promise<number> {
    const row = await tx
      .selectFrom('service')
      .select('workers_required')
      .where('id', '=', serviceId)
      .executeTakeFirstOrThrow();
    return row.workers_required;
  }
}
