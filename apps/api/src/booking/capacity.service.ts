import { Injectable } from '@nestjs/common';
import type { TimeRange } from '@onetappe/domain';
import { sql } from 'kysely';
import { isPgError, isReservationOverlap, PG } from '../database/database-errors.js';
import { attempt, type Tx } from '../database/transaction.js';

export interface ReservationRequest {
  readonly bookingId: string;
  readonly serviceId: string;
  readonly zoneId: string;
  /** Worker time to block: travel buffer + service + reset buffer. */
  readonly period: TimeRange;
  readonly crewSlot: number;
  /** Instant bookings only go to workers who are online right now. */
  readonly bookingType: 'INSTANT' | 'SCHEDULED';
  readonly status: 'HELD' | 'ALLOCATED';
  /** Required for HELD reservations. */
  readonly holdExpiresAt: Date | null;
  /** Workers not to try again (e.g. they already declined this booking). */
  readonly excludeWorkerIds?: readonly string[];
}

export interface Reservation {
  readonly reservationId: string;
  readonly workerId: string;
}

const MAX_CANDIDATES = 25;

function range(period: TimeRange) {
  return sql<string>`tstzrange(${period.start}, ${period.end}, '[)')`;
}

/**
 * Worker capacity. The candidate query is only a shortlist: the reservation INSERT is
 * the real check. PostgreSQL's exclusion constraint and reservation trigger decide,
 * atomically, whether the worker is free and eligible. If two customers race for the
 * same worker, exactly one INSERT succeeds and the other moves on to the next
 * candidate.
 */
@Injectable()
export class CapacityService {
  /** Eligible workers with a covering shift and no known overlap, least busy first. */
  async findCandidates(
    tx: Tx,
    request: Pick<
      ReservationRequest,
      'serviceId' | 'zoneId' | 'period' | 'excludeWorkerIds' | 'bookingType'
    >,
  ): Promise<string[]> {
    const period = range(request.period);
    const exclude = request.excludeWorkerIds ?? [];

    const rows = await tx
      .selectFrom('worker_profile as w')
      .innerJoin('worker_shift as s', (join) =>
        join
          .onRef('s.worker_id', '=', 'w.user_id')
          .on('s.status', '=', 'PLANNED')
          .on('s.zone_id', '=', request.zoneId)
          .on(sql<boolean>`s.period @> ${period}`),
      )
      .select('w.user_id as workerId')
      .select((eb) =>
        eb
          .selectFrom('worker_reservation as load')
          .select(eb.fn.countAll<number>().as('n'))
          .whereRef('load.worker_id', '=', 'w.user_id')
          .where('load.status', 'in', ['ALLOCATED', 'ACCEPTED'])
          .where(sql<boolean>`load.period && s.period`)
          .as('load'),
      )
      .where('w.status', 'in', ['ACTIVE', 'RESTRICTED'])
      .$if(request.bookingType === 'INSTANT', (qb) =>
        qb.where((eb) =>
          eb.exists(
            eb
              .selectFrom('worker_presence as p')
              .select(sql`1`.as('one'))
              .whereRef('p.worker_id', '=', 'w.user_id')
              .where('p.is_online', '=', true),
          ),
        ),
      )
      .where(
        sql<boolean>`worker_ineligibility_reason(w.user_id, ${request.serviceId}::uuid, ${request.zoneId}::uuid, ${period}) IS NULL`,
      )
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('worker_reservation as r')
              .select(sql`1`.as('one'))
              .whereRef('r.worker_id', '=', 'w.user_id')
              .where('r.status', 'in', ['HELD', 'ALLOCATED', 'ACCEPTED'])
              .where(sql<boolean>`r.period && ${period}`)
              .where(sql<boolean>`NOT (r.status = 'HELD' AND r.hold_expires_at <= now())`),
          ),
        ),
      )
      .$if(exclude.length > 0, (qb) => qb.where('w.user_id', 'not in', exclude))
      .orderBy('load')
      .orderBy('w.worker_code')
      .limit(MAX_CANDIDATES)
      .execute();

    return rows.map((row) => row.workerId);
  }

  /** Reserves one worker for one crew slot, or returns null when nobody is free. */
  async reserve(tx: Tx, request: ReservationRequest): Promise<Reservation | null> {
    const candidates = await this.findCandidates(tx, request);
    for (const workerId of candidates) {
      const result = await attempt(tx, 'reserve_worker', () =>
        this.insertReservation(tx, workerId, request),
      );
      if (result.ok) return { reservationId: result.value, workerId };
      if (!isLostRace(result.error)) throw result.error;
      // Someone else took this worker (or they just became ineligible): try the next.
    }
    return null;
  }

  /** Reserves a specific worker (operations override). Throws if not possible. */
  async reserveWorker(tx: Tx, workerId: string, request: ReservationRequest): Promise<Reservation> {
    const reservationId = await this.insertReservation(tx, workerId, request);
    return { reservationId, workerId };
  }

  async allocateHeld(tx: Tx, bookingId: string): Promise<number> {
    const result = await tx
      .updateTable('worker_reservation')
      .set({ status: 'ALLOCATED' })
      .where('booking_id', '=', bookingId)
      .where('status', '=', 'HELD')
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  async markAccepted(tx: Tx, reservationId: string): Promise<void> {
    await tx
      .updateTable('worker_reservation')
      .set({ status: 'ACCEPTED' })
      .where('id', '=', reservationId)
      .where('status', '=', 'ALLOCATED')
      .executeTakeFirstOrThrow();
  }

  async release(tx: Tx, reservationId: string, reason: string): Promise<void> {
    await tx
      .updateTable('worker_reservation')
      .set({ status: 'RELEASED', released_at: new Date(), release_reason: reason })
      .where('id', '=', reservationId)
      .where('status', 'in', ['HELD', 'ALLOCATED', 'ACCEPTED'])
      .execute();
  }

  private async insertReservation(
    tx: Tx,
    workerId: string,
    request: ReservationRequest,
  ): Promise<string> {
    const row = await tx
      .insertInto('worker_reservation')
      .values({
        booking_id: request.bookingId,
        worker_id: workerId,
        crew_slot: request.crewSlot,
        period: range(request.period),
        status: request.status,
        hold_expires_at: request.holdExpiresAt,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }
}

/** Failures that mean "this worker is no longer available" rather than a bug. */
function isLostRace(error: unknown): boolean {
  return (
    isReservationOverlap(error) || (isPgError(error) && error.code === PG.RESERVATION_NOT_ALLOWED)
  );
}
