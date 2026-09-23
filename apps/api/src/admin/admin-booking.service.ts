import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import {
  citiesFor,
  hasPermission,
  hasPermissionInCity,
  type Principal,
} from '../auth/principal.js';
import { BookingCreationService } from '../booking/booking-creation.service.js';
import { BookingTransitionService } from '../booking/booking-transition.service.js';
import { DispatchService, type DispatchResult } from '../booking/dispatch.service.js';
import { ForbiddenError, NotFoundError } from '../common/errors.js';
import { maskName, maskPhone } from '../common/pii.js';
import type { ActionContext } from '../database/action-context.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { inTransaction } from '../database/transaction.js';
import { ServiceabilityService } from '../service-area/serviceability.service.js';

export interface BookingSearch {
  readonly status: string | null;
  readonly code: string | null;
  readonly from: Date | null;
  readonly to: Date | null;
  readonly limit: number;
}

export interface ManualBookingInput {
  readonly customer: { readonly phone: string; readonly fullName: string };
  readonly address: {
    readonly houseNumber: string;
    readonly building: string | null;
    readonly street: string | null;
    readonly landmark: string | null;
    readonly pincode: string;
    readonly cityName: string;
    readonly lat: number;
    readonly lng: number;
    readonly accessNotes: string | null;
  };
  readonly serviceId: string;
  readonly serviceOptionId: string | null;
  readonly bookingType: 'INSTANT' | 'SCHEDULED';
  readonly startAt: Date | null;
  readonly taskIds: readonly string[] | null;
  readonly notes: string | null;
  readonly paymentMode: 'PREPAID' | 'PAY_AFTER_SERVICE';
  readonly idempotencyKey: string;
}

/**
 * Operations views of bookings. Personal details are masked here; the reveal endpoints
 * are the only way to see them in full, and every reveal is audited.
 */
@Injectable()
export class AdminBookingService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly creation: BookingCreationService,
    private readonly serviceability: ServiceabilityService,
    private readonly transitions: BookingTransitionService,
    private readonly dispatch: DispatchService,
  ) {}

  /** Failed assignment: offer the job again to whoever is eligible now. */
  async redispatch(context: ActionContext, bookingId: string): Promise<DispatchResult> {
    return inTransaction(this.db, context, async (tx) => {
      const booking = await this.transitions.lock(tx, bookingId);
      return this.dispatch.allocateAndOffer(tx, booking, context);
    });
  }

  /** Pauses a confirmed booking; its worker capacity is released by the database. */
  async hold(context: ActionContext, bookingId: string): Promise<void> {
    await inTransaction(this.db, context, async (tx) => {
      const booking = await this.transitions.lock(tx, bookingId);
      await this.transitions.apply(tx, booking, 'PLACE_ON_HOLD', context);
    });
  }

  async releaseHold(context: ActionContext, bookingId: string): Promise<DispatchResult> {
    return inTransaction(this.db, context, async (tx) => {
      const booking = await this.transitions.lock(tx, bookingId);
      await this.transitions.apply(tx, booking, 'RELEASE_HOLD', context);
      return this.dispatch.allocateAndOffer(tx, { ...booking, status: 'CONFIRMED' }, context);
    });
  }

  async search(principal: Principal, filter: BookingSearch) {
    const cities = citiesFor(principal, 'booking.read');
    if (cities !== null && cities.size === 0) return [];
    const rows = await this.db
      .selectFrom('booking as b')
      .innerJoin('service as s', 's.id', 'b.service_id')
      .innerJoin('locality as l', 'l.id', 'b.locality_id')
      .innerJoin('app_user as c', 'c.id', 'b.customer_user_id')
      .select([
        'b.id',
        'b.booking_code',
        'b.status',
        'b.source',
        'b.scheduled_start',
        'b.original_start',
        'b.total_paise',
        'b.city_id',
        's.name as service',
        'l.name as locality',
        'l.pincode',
        'c.full_name',
        'c.phone_e164',
      ])
      .$if(cities !== null, (qb) => qb.where('b.city_id', 'in', [...(cities ?? [])]))
      .$if(filter.status !== null, (qb) => qb.where('b.status', '=', filter.status ?? ''))
      .$if(filter.code !== null, (qb) =>
        qb.where('b.booking_code', '=', (filter.code ?? '').toUpperCase()),
      )
      .$if(filter.from !== null, (qb) =>
        qb.where('b.scheduled_start', '>=', filter.from ?? new Date(0)),
      )
      .$if(filter.to !== null, (qb) => qb.where('b.scheduled_start', '<', filter.to ?? new Date(0)))
      .orderBy('b.scheduled_start', 'desc')
      .limit(filter.limit)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      bookingCode: r.booking_code,
      status: r.status,
      source: r.source,
      service: r.service,
      locality: r.locality,
      pincode: r.pincode,
      scheduledStart: r.scheduled_start.toISOString(),
      originalStart: r.original_start.toISOString(),
      totalPaise: r.total_paise,
      customer: { name: maskName(r.full_name), phone: maskPhone(r.phone_e164) },
    }));
  }

  /** Full operational timeline of a booking. Money and personal data follow permissions. */
  async detail(principal: Principal, bookingId: string) {
    const b = await this.db
      .selectFrom('booking as b')
      .innerJoin('service as s', 's.id', 'b.service_id')
      .innerJoin('locality as l', 'l.id', 'b.locality_id')
      .innerJoin('app_user as c', 'c.id', 'b.customer_user_id')
      .selectAll('b')
      .select(['s.name as service', 'l.name as locality', 'c.full_name', 'c.phone_e164'])
      .where('b.id', '=', bookingId)
      .executeTakeFirst();
    if (!b || !hasPermissionInCity(principal, 'booking.read', b.city_id))
      throw new NotFoundError('Booking', bookingId);

    const [statusHistory, scheduleChanges, assignments, reservations, payments, refunds] =
      await Promise.all([
        this.db
          .selectFrom('booking_status_history as h')
          .leftJoin('app_user as u', 'u.id', 'h.actor_user_id')
          .select([
            'h.from_status',
            'h.to_status',
            'h.event',
            'h.source',
            'h.actor_role',
            'h.reason',
            'h.occurred_at',
            'h.actor_user_id',
            'u.full_name as actor_name',
          ])
          .where('h.booking_id', '=', bookingId)
          .orderBy('h.id')
          .execute(),
        this.db
          .selectFrom('booking_schedule_change')
          .selectAll()
          .where('booking_id', '=', bookingId)
          .orderBy('id')
          .execute(),
        this.db
          .selectFrom('booking_assignment as a')
          .innerJoin('worker_profile as w', 'w.user_id', 'a.worker_id')
          .innerJoin('app_user as u', 'u.id', 'a.worker_id')
          .select([
            'a.id',
            'a.status',
            'a.crew_slot',
            'a.offered_at',
            'a.offer_expires_at',
            'a.responded_at',
            'a.response_reason',
            'a.ended_at',
            'a.end_reason',
            'a.source',
            'w.worker_code',
            'u.full_name',
          ])
          .where('a.booking_id', '=', bookingId)
          .orderBy('a.offered_at')
          .execute(),
        this.db
          .selectFrom('worker_reservation')
          .select(['id', 'worker_id', 'status', 'release_reason', 'created_at', 'released_at'])
          .where('booking_id', '=', bookingId)
          .orderBy('created_at')
          .execute(),
        this.db
          .selectFrom('payment')
          .selectAll()
          .where('booking_id', '=', bookingId)
          .orderBy('created_at')
          .execute(),
        this.db
          .selectFrom('refund')
          .selectAll()
          .where('booking_id', '=', bookingId)
          .orderBy('created_at')
          .execute(),
      ]);

    const address = b.address_snapshot as Record<string, unknown>;
    const seeMoney = hasPermission(principal, 'payment.read');
    const seeRefunds = hasPermission(principal, 'refund.read');
    return {
      id: b.id,
      bookingCode: b.booking_code,
      status: b.status,
      /** Send back as expectedVersion with any change, so concurrent edits are detected. */
      version: b.version,
      source: b.source,
      bookingType: b.booking_type,
      service: b.service,
      cityId: b.city_id,
      locality: b.locality,
      schedule: {
        original: { start: b.original_start.toISOString(), end: b.original_end.toISOString() },
        current: { start: b.scheduled_start.toISOString(), end: b.scheduled_end.toISOString() },
        rescheduleCount: b.reschedule_count,
      },
      customer: {
        id: b.customer_user_id,
        name: maskName(b.full_name),
        phone: maskPhone(b.phone_e164),
      },
      address: { locality: b.locality, pincode: address['pincode'], cityName: address['cityName'] },
      totalPaise: b.total_paise,
      paymentMode: b.payment_mode,
      timeline: statusHistory.map((h) => ({
        from: h.from_status,
        to: h.to_status,
        event: h.event,
        source: h.source,
        actor: h.actor_user_id
          ? { id: h.actor_user_id, name: h.actor_name, role: h.actor_role }
          : null,
        reason: h.reason,
        at: h.occurred_at.toISOString(),
      })),
      scheduleChanges: scheduleChanges.map((c) => ({
        from: { start: c.previous_start.toISOString(), end: c.previous_end.toISOString() },
        to: { start: c.new_start.toISOString(), end: c.new_end.toISOString() },
        source: c.source,
        actorUserId: c.actor_user_id,
        reason: c.reason,
        at: c.occurred_at.toISOString(),
      })),
      assignments: assignments.map((a) => ({
        id: a.id,
        worker: { code: a.worker_code, name: maskName(a.full_name) },
        status: a.status,
        crewSlot: a.crew_slot,
        offeredAt: a.offered_at.toISOString(),
        offerExpiresAt: a.offer_expires_at.toISOString(),
        respondedAt: a.responded_at?.toISOString() ?? null,
        responseReason: a.response_reason,
        endedAt: a.ended_at?.toISOString() ?? null,
        endReason: a.end_reason,
        source: a.source,
      })),
      reservations: reservations.map((r) => ({
        id: r.id,
        workerId: r.worker_id,
        status: r.status,
        releaseReason: r.release_reason,
      })),
      payments: payments.map((p) =>
        seeMoney
          ? {
              id: p.id,
              provider: p.provider,
              status: p.status,
              amountPaise: p.amount_paise,
              isDuplicate: p.is_duplicate,
              providerOrderId: p.provider_order_id,
              providerPaymentId: p.provider_payment_id,
              capturedAt: p.captured_at?.toISOString() ?? null,
              failureReason: p.failure_reason,
            }
          : { id: p.id, status: p.status },
      ),
      refunds: seeRefunds
        ? refunds.map((r) => ({
            id: r.id,
            status: r.status,
            amountPaise: r.amount_paise,
            reasonCode: r.reason_code,
            requestedBy: r.requested_by,
            decidedBy: r.decided_by,
            decisionPolicy: r.decision_policy,
          }))
        : null,
    };
  }

  /**
   * Books on behalf of a customer: the phone number identifies (or creates) the customer,
   * the address is saved to their account, and the normal booking engine does the rest.
   */
  async createManual(principal: Principal, context: ActionContext, input: ManualBookingInput) {
    const location = await this.serviceability.resolve(this.db, {
      pincode: input.address.pincode,
      lat: input.address.lat,
      lng: input.address.lng,
      serviceId: input.serviceId,
    });
    if (location && !hasPermissionInCity(principal, 'booking.create_on_behalf', location.cityId)) {
      throw new ForbiddenError('CITY_NOT_ALLOWED', 'You cannot create bookings in this city');
    }
    const { customerId, addressId } = await inTransaction(this.db, context, async (tx) => {
      await tx
        .insertInto('app_user')
        .values({ phone_e164: input.customer.phone, full_name: input.customer.fullName })
        .onConflict((oc) => oc.column('phone_e164').doNothing())
        .execute();
      const user = await tx
        .selectFrom('app_user')
        .select(['id', 'status', 'full_name'])
        .where('phone_e164', '=', input.customer.phone)
        .executeTakeFirstOrThrow();
      if (user.status !== 'ACTIVE')
        throw new ForbiddenError('ACCOUNT_DISABLED', 'This customer account is not active');
      if (!user.full_name)
        await tx
          .updateTable('app_user')
          .set({ full_name: input.customer.fullName })
          .where('id', '=', user.id)
          .execute();
      await tx
        .insertInto('customer_profile')
        .values({ user_id: user.id })
        .onConflict((oc) => oc.column('user_id').doNothing())
        .execute();
      const address = await tx
        .insertInto('address')
        .values({
          user_id: user.id,
          label: 'Booked by support',
          contact_name: input.customer.fullName,
          contact_phone_e164: input.customer.phone,
          house_number: input.address.houseNumber,
          building: input.address.building,
          street: input.address.street,
          landmark: input.address.landmark,
          pincode: input.address.pincode,
          city_name: input.address.cityName,
          lat: String(input.address.lat),
          lng: String(input.address.lng),
          access_notes: input.address.accessNotes,
          locality_id: location?.localityId ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return { customerId: user.id, addressId: address.id };
    });

    const booking = await this.creation.create(
      {
        customerUserId: customerId,
        serviceId: input.serviceId,
        serviceOptionId: input.serviceOptionId,
        addressId,
        bookingType: input.bookingType,
        requestedStart: input.startAt,
        taskIds: input.taskIds,
        promoCode: null,
        customerNotes: input.notes,
        expectedTotalPaise: null,
        paymentMode: input.paymentMode,
        idempotencyKey: input.idempotencyKey || randomUUID(),
      },
      context,
    );
    return this.detail(principal, booking.id);
  }

  /** Throws unless the staff member may act on this booking's city with `permission`. */
  async assertCity(principal: Principal, bookingId: string, permission: string): Promise<void> {
    const row = await this.db
      .selectFrom('booking')
      .select('city_id')
      .where('id', '=', bookingId)
      .executeTakeFirst();
    if (!row || !hasPermissionInCity(principal, permission, row.city_id))
      throw new NotFoundError('Booking', bookingId);
  }
}
