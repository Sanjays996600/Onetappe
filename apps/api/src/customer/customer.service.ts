import { Inject, Injectable } from '@nestjs/common';
import { availableBookingEvents, type BookingStatus } from '@onetappe/domain';
import type { Kysely } from 'kysely';
import { instantStart, validateScheduledStart } from '../booking/booking-schedule.js';
import { VerificationCodeService } from '../booking/verification-code.service.js';
import { Clock } from '../common/clock.js';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '../common/errors.js';
import type { ActionContext } from '../database/action-context.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { inTransaction, type Tx } from '../database/transaction.js';
import { keyReusedError, type IdempotentRequest } from '../common/http/idempotency.js';
import { PricingService } from '../pricing/pricing.service.js';
import { ServiceabilityService } from '../service-area/serviceability.service.js';

export interface AddressInput {
  readonly label: string;
  readonly contactName: string;
  readonly contactPhone: string;
  readonly houseNumber: string;
  readonly building?: string | null;
  readonly street?: string | null;
  readonly landmark?: string | null;
  readonly pincode: string;
  readonly cityName: string;
  readonly lat: number;
  readonly lng: number;
  readonly accessNotes?: string | null;
  readonly isDefault?: boolean;
}

export interface QuoteInput {
  readonly serviceId: string;
  readonly serviceOptionId: string | null;
  readonly addressId: string;
  readonly bookingType: 'INSTANT' | 'SCHEDULED';
  readonly startAt: Date | null;
  readonly promoCode: string | null;
}

const START_CODE_STATUSES: readonly BookingStatus[] = ['ASSIGNED', 'EN_ROUTE', 'ARRIVED'];

/**
 * Customer-facing reads and small writes. Every query is scoped to the signed-in
 * customer; booking changes go through the booking engine services.
 */
@Injectable()
export class CustomerService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly serviceability: ServiceabilityService,
    private readonly pricing: PricingService,
    private readonly codes: VerificationCodeService,
    private readonly clock: Clock,
  ) {}

  // ---- Profile -----------------------------------------------------------

  async profile(userId: string) {
    const user = await this.db
      .selectFrom('app_user as u')
      .innerJoin('customer_profile as c', 'c.user_id', 'u.id')
      .select([
        'u.id',
        'u.full_name',
        'u.email',
        'u.phone_e164',
        'u.preferred_locale',
        'c.marketing_opt_in',
      ])
      .where('u.id', '=', userId)
      .executeTakeFirst();
    if (!user) throw new NotFoundError('Customer', userId);
    const addresses = await this.db
      .selectFrom('address')
      .select('id')
      .where('user_id', '=', userId)
      .where('archived_at', 'is', null)
      .execute();
    return {
      id: user.id,
      fullName: user.full_name,
      email: user.email,
      phone: user.phone_e164,
      preferredLocale: user.preferred_locale,
      marketingOptIn: user.marketing_opt_in,
      profileComplete: Boolean(user.full_name),
      addressCount: addresses.length,
    };
  }

  async updateProfile(
    context: ActionContext,
    input: {
      fullName?: string;
      email?: string | null;
      preferredLocale?: string;
      marketingOptIn?: boolean;
    },
  ) {
    const userId = requireActor(context);
    await inTransaction(this.db, context, async (tx) => {
      const values: { full_name?: string; email?: string | null; preferred_locale?: string } = {};
      if (input.fullName !== undefined) values.full_name = input.fullName.trim();
      if (input.email !== undefined) values.email = input.email?.trim() || null;
      if (input.preferredLocale !== undefined) values.preferred_locale = input.preferredLocale;
      if (Object.keys(values).length > 0) {
        await tx.updateTable('app_user').set(values).where('id', '=', userId).execute();
      }
      if (input.marketingOptIn !== undefined) {
        await tx
          .updateTable('customer_profile')
          .set({ marketing_opt_in: input.marketingOptIn })
          .where('user_id', '=', userId)
          .execute();
      }
    });
    return this.profile(userId);
  }

  // ---- Addresses ---------------------------------------------------------

  async addresses(userId: string) {
    const rows = await this.db
      .selectFrom('address')
      .selectAll()
      .where('user_id', '=', userId)
      .where('archived_at', 'is', null)
      .orderBy('is_default', 'desc')
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map(addressView);
  }

  /** Saves an address; a retry with the same idempotency key returns the saved one. */
  async addAddress(context: ActionContext, input: AddressInput, idempotency: IdempotentRequest) {
    const userId = requireActor(context);
    const location = await this.serviceability.resolve(this.db, {
      pincode: input.pincode,
      lat: input.lat,
      lng: input.lng,
    });
    const row = await inTransaction(this.db, context, async (tx) => {
      // Before any change, so a replay cannot move the default flag again.
      const earlier = await this.addressByKey(tx, userId, idempotency);
      if (earlier) return earlier;
      if (input.isDefault) {
        await tx
          .updateTable('address')
          .set({ is_default: false })
          .where('user_id', '=', userId)
          .where('is_default', '=', true)
          .execute();
      }
      const existing = await tx
        .selectFrom('address')
        .select('id')
        .where('user_id', '=', userId)
        .where('archived_at', 'is', null)
        .limit(1)
        .executeTakeFirst();
      const inserted = await tx
        .insertInto('address')
        .values({
          user_id: userId,
          label: input.label,
          contact_name: input.contactName,
          contact_phone_e164: input.contactPhone,
          house_number: input.houseNumber,
          building: input.building ?? null,
          street: input.street ?? null,
          landmark: input.landmark ?? null,
          pincode: input.pincode,
          city_name: input.cityName,
          lat: String(input.lat),
          lng: String(input.lng),
          access_notes: input.accessNotes ?? null,
          locality_id: location?.localityId ?? null,
          is_default: input.isDefault ?? existing === undefined,
          idempotency_key: idempotency.key,
          request_hash: idempotency.hash,
        })
        .onConflict((oc) => oc.columns(['user_id', 'idempotency_key']).doNothing())
        .returningAll()
        .executeTakeFirst();
      if (inserted) return inserted;
      const winner = await this.addressByKey(tx, userId, idempotency);
      if (!winner) throw new Error('Idempotent address vanished');
      return winner;
    });
    return addressView(row);
  }

  private async addressByKey(tx: Tx, userId: string, idempotency: IdempotentRequest) {
    const row = await tx
      .selectFrom('address')
      .selectAll()
      .where('user_id', '=', userId)
      .where('idempotency_key', '=', idempotency.key)
      .executeTakeFirst();
    if (row && row.request_hash !== idempotency.hash) throw keyReusedError();
    return row ?? null;
  }

  async archiveAddress(context: ActionContext, addressId: string): Promise<void> {
    const userId = requireActor(context);
    await inTransaction(this.db, context, async (tx) => {
      const result = await tx
        .updateTable('address')
        .set({ archived_at: this.clock.now(), is_default: false })
        .where('id', '=', addressId)
        .where('user_id', '=', userId)
        .where('archived_at', 'is', null)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0) throw new NotFoundError('Address', addressId);
    });
  }

  // ---- Quote -------------------------------------------------------------

  async quote(context: ActionContext, input: QuoteInput) {
    const userId = requireActor(context);
    return inTransaction(this.db, context, async (tx) => {
      const address = await tx
        .selectFrom('address')
        .select(['pincode', 'lat', 'lng'])
        .where('id', '=', input.addressId)
        .where('user_id', '=', userId)
        .where('archived_at', 'is', null)
        .executeTakeFirst();
      if (!address) throw new NotFoundError('Address', input.addressId);
      const service = await tx
        .selectFrom('service')
        .selectAll()
        .where('id', '=', input.serviceId)
        .where('is_active', '=', true)
        .executeTakeFirst();
      if (!service) throw new NotFoundError('Service', input.serviceId);
      const location = await this.serviceability.resolve(tx, {
        pincode: address.pincode,
        lat: address.lat,
        lng: address.lng,
        serviceId: service.id,
      });
      if (!location)
        throw new BusinessRuleError(
          'AREA_NOT_SERVICEABLE',
          'This service is not available at the selected address yet',
        );

      const now = this.clock.now();
      const start =
        input.bookingType === 'INSTANT'
          ? instantStart(service, now)
          : validateScheduledStart(service, input.startAt, now);
      const priced = await this.pricing.price(tx, {
        customerUserId: userId,
        serviceId: service.id,
        serviceOptionId: input.serviceOptionId,
        cityId: location.cityId,
        zoneId: location.zoneId,
        bookingType: input.bookingType,
        serviceStart: start,
        timeZone: location.timeZone,
        promoCode: input.promoCode,
        now,
      });
      return {
        startAt: start.toISOString(),
        currency: 'INR',
        lines: priced.quote.lines.map((l) => ({
          type: l.type,
          code: l.code,
          label: l.label,
          amountPaise: l.amountPaise,
        })),
        subtotalPaise: priced.quote.subtotalPaise,
        discountPaise: priced.quote.discountPaise,
        taxPaise: priced.quote.taxPaise,
        totalPaise: priced.quote.totalPaise,
      };
    });
  }

  // ---- Bookings ----------------------------------------------------------

  async bookings(userId: string, options: { limit: number; before: Date | null }) {
    const rows = await this.db
      .selectFrom('booking as b')
      .innerJoin('service as s', 's.id', 'b.service_id')
      .select([
        'b.id',
        'b.booking_code',
        'b.status',
        'b.scheduled_start',
        'b.scheduled_end',
        'b.total_paise',
        'b.created_at',
        's.name as service_name',
      ])
      .where('b.customer_user_id', '=', userId)
      .$if(options.before !== null, (qb) =>
        qb.where('b.created_at', '<', options.before ?? new Date()),
      )
      .orderBy('b.created_at', 'desc')
      .limit(options.limit)
      .execute();
    return {
      items: rows.map((r) => ({
        id: r.id,
        bookingCode: r.booking_code,
        status: r.status,
        serviceName: r.service_name,
        scheduledStart: r.scheduled_start.toISOString(),
        scheduledEnd: r.scheduled_end.toISOString(),
        totalPaise: r.total_paise,
      })),
      nextBefore:
        rows.length === options.limit ? (rows.at(-1)?.created_at.toISOString() ?? null) : null,
    };
  }

  async booking(userId: string, bookingId: string) {
    const b = await this.ownedBooking(userId, bookingId);
    const status = b.status as BookingStatus;

    const [lines, tasks, worker, payments, rating] = await Promise.all([
      this.db
        .selectFrom('booking_price_line')
        .select(['line_type', 'code', 'label', 'amount_paise'])
        .where('booking_id', '=', bookingId)
        .orderBy('line_no')
        .execute(),
      this.db
        .selectFrom('booking_task')
        .select(['name', 'priority', 'status'])
        .where('booking_id', '=', bookingId)
        .orderBy('priority')
        .execute(),
      this.db
        .selectFrom('booking_assignment as a')
        .innerJoin('worker_profile as w', 'w.user_id', 'a.worker_id')
        .innerJoin('app_user as u', 'u.id', 'a.worker_id')
        .select(['u.full_name', 'w.worker_code'])
        .where('a.booking_id', '=', bookingId)
        .where('a.status', 'in', ['ACCEPTED', 'COMPLETED'])
        .executeTakeFirst(),
      this.db
        .selectFrom('payment')
        .select(['id', 'status', 'amount_paise', 'is_duplicate'])
        .where('booking_id', '=', bookingId)
        .orderBy('created_at', 'desc')
        .execute(),
      this.db
        .selectFrom('booking_rating')
        .select(['score', 'comment'])
        .where('booking_id', '=', bookingId)
        .where('rater_role', '=', 'CUSTOMER')
        .executeTakeFirst(),
    ]);

    const paid = payments.some((p) => p.status === 'CAPTURED' && !p.is_duplicate);
    return {
      id: b.id,
      bookingCode: b.booking_code,
      status,
      bookingType: b.booking_type,
      service: { id: b.service_id, name: b.service_name },
      schedule: {
        original: { start: b.original_start.toISOString(), end: b.original_end.toISOString() },
        current: { start: b.scheduled_start.toISOString(), end: b.scheduled_end.toISOString() },
        rescheduleCount: b.reschedule_count,
      },
      address: b.address_snapshot,
      price: {
        currency: b.currency,
        lines: lines.map((l) => ({
          type: l.line_type,
          code: l.code,
          label: l.label,
          amountPaise: l.amount_paise,
        })),
        subtotalPaise: b.subtotal_paise,
        discountPaise: b.discount_paise,
        taxPaise: b.tax_paise,
        totalPaise: b.total_paise,
      },
      payment: {
        mode: b.payment_mode,
        status: paid
          ? 'PAID'
          : b.payment_mode === 'PAY_AFTER_SERVICE'
            ? 'PAY_AFTER_SERVICE'
            : 'UNPAID',
        payBy: b.payment_due_by?.toISOString() ?? null,
      },
      // Workers are introduced by first name and company code only.
      worker: worker
        ? { firstName: worker.full_name?.split(/\s+/)[0] ?? null, workerCode: worker.worker_code }
        : null,
      tasks,
      rating: rating ?? null,
      actions: {
        canPay: status === 'PENDING_PAYMENT' && b.payment_mode === 'PREPAID',
        canCancel: availableBookingEvents(status, 'CUSTOMER_APP').includes('CANCEL'),
        canReschedule: ['PENDING_PAYMENT', 'CONFIRMED', 'ASSIGNED'].includes(status),
        canViewStartCode: START_CODE_STATUSES.includes(status),
        canRate: (status === 'COMPLETED' || status === 'CLOSED') && !rating,
      },
      createdAt: b.created_at.toISOString(),
    };
  }

  /** The booking's status history as the customer sees it (no staff identities). */
  async timeline(userId: string, bookingId: string) {
    await this.ownedBooking(userId, bookingId);
    const history = await this.db
      .selectFrom('booking_status_history')
      .select(['from_status', 'to_status', 'event', 'occurred_at'])
      .where('booking_id', '=', bookingId)
      .orderBy('id')
      .execute();
    const changes = await this.db
      .selectFrom('booking_schedule_change')
      .select(['previous_start', 'new_start', 'occurred_at'])
      .where('booking_id', '=', bookingId)
      .orderBy('id')
      .execute();
    return {
      statuses: history.map((h) => ({
        from: h.from_status,
        to: h.to_status,
        event: h.event,
        at: h.occurred_at.toISOString(),
      })),
      scheduleChanges: changes.map((c) => ({
        from: c.previous_start.toISOString(),
        to: c.new_start.toISOString(),
        at: c.occurred_at.toISOString(),
      })),
    };
  }

  async startCode(userId: string, bookingId: string) {
    const b = await this.ownedBooking(userId, bookingId);
    if (!START_CODE_STATUSES.includes(b.status as BookingStatus)) {
      throw new BusinessRuleError(
        'START_CODE_NOT_AVAILABLE',
        'The start code is shown once a professional is assigned',
      );
    }
    return {
      code: this.codes.codeFor(bookingId, 'START'),
      guidance:
        "Share this code only after you have checked the professional's ID. It is not a payment OTP.",
    };
  }

  async invoice(userId: string, bookingId: string) {
    await this.ownedBooking(userId, bookingId);
    const invoice = await this.db
      .selectFrom('invoice')
      .selectAll()
      .where('booking_id', '=', bookingId)
      .executeTakeFirst();
    if (!invoice) throw new NotFoundError('Invoice', bookingId);
    return {
      invoiceNumber: invoice.invoice_number,
      issuedAt: invoice.issued_at.toISOString(),
      issuer: {
        legalName: invoice.issuer_legal_name,
        gstin: invoice.issuer_gstin,
        address: invoice.issuer_address,
      },
      billedTo: { name: invoice.customer_name, address: invoice.customer_address },
      lines: invoice.lines,
      subtotalPaise: invoice.subtotal_paise,
      discountPaise: invoice.discount_paise,
      taxPaise: invoice.tax_paise,
      totalPaise: invoice.total_paise,
      currency: 'INR',
    };
  }

  async rate(
    context: ActionContext,
    bookingId: string,
    input: { score: number; comment: string | null },
  ) {
    const userId = requireActor(context);
    const b = await this.ownedBooking(userId, bookingId);
    if (b.status !== 'COMPLETED' && b.status !== 'CLOSED') {
      throw new BusinessRuleError(
        'CANNOT_RATE_YET',
        'You can rate the service once it is completed',
      );
    }
    await inTransaction(this.db, context, (tx) =>
      tx
        .insertInto('booking_rating')
        .values({
          booking_id: bookingId,
          rated_by_user_id: userId,
          rater_role: 'CUSTOMER',
          score: input.score,
          comment: input.comment,
        })
        .execute(),
    );
  }

  async notifications(userId: string, limit: number) {
    const rows = await this.db
      .selectFrom('notification as n')
      .innerJoin('notification_template as t', 't.id', 'n.template_id')
      .select([
        'n.id',
        'n.booking_id',
        'n.created_at',
        'n.read_at',
        't.code',
        'n.variables',
        't.title',
        't.body',
      ])
      .where('n.user_id', '=', userId)
      .where('n.channel', '=', 'IN_APP')
      .orderBy('n.created_at', 'desc')
      .limit(limit)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      event: r.code,
      bookingId: r.booking_id,
      title: r.title,
      body: r.body,
      variables: r.variables,
      createdAt: r.created_at.toISOString(),
      read: r.read_at !== null,
    }));
  }

  async assertOwns(userId: string, bookingId: string): Promise<void> {
    await this.ownedBooking(userId, bookingId);
  }

  private async ownedBooking(userId: string, bookingId: string) {
    const b = await this.db
      .selectFrom('booking as b')
      .innerJoin('service as s', 's.id', 'b.service_id')
      .selectAll('b')
      .select('s.name as service_name')
      .where('b.id', '=', bookingId)
      .executeTakeFirst();
    // Someone else's booking looks exactly like a missing one.
    if (!b || b.customer_user_id !== userId) throw new NotFoundError('Booking', bookingId);
    return b;
  }
}

function requireActor(context: ActionContext): string {
  if (!context.actorUserId) throw new ForbiddenError('NOT_AUTHENTICATED', 'Sign in required');
  return context.actorUserId;
}

function addressView(row: {
  id: string;
  label: string;
  contact_name: string;
  contact_phone_e164: string;
  house_number: string;
  building: string | null;
  street: string | null;
  landmark: string | null;
  pincode: string;
  city_name: string;
  lat: string;
  lng: string;
  access_notes: string | null;
  is_default: boolean;
  locality_id: string | null;
}) {
  return {
    id: row.id,
    label: row.label,
    contactName: row.contact_name,
    contactPhone: row.contact_phone_e164,
    houseNumber: row.house_number,
    building: row.building,
    street: row.street,
    landmark: row.landmark,
    pincode: row.pincode,
    cityName: row.city_name,
    lat: Number(row.lat),
    lng: Number(row.lng),
    accessNotes: row.access_notes,
    isDefault: row.is_default,
    serviceable: row.locality_id !== null,
  };
}
