import { Inject, Injectable } from '@nestjs/common';
import {
  reservationPeriod,
  servicePeriod,
  type BookingStatus,
  type ServiceTiming,
} from '@onetappe/domain';
import type { Kysely } from 'kysely';
import { Clock } from '../common/clock.js';
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../common/errors.js';
import type { ActionContext } from '../database/action-context.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { inTransaction, type Tx } from '../database/transaction.js';
import { PricingService } from '../pricing/pricing.service.js';
import {
  ServiceabilityService,
  type ServiceLocation,
} from '../service-area/serviceability.service.js';
import { instantStart, validateScheduledStart } from './booking-schedule.js';
import { CapacityService } from './capacity.service.js';

const MINUTE_MS = 60_000;

export interface CreateBookingInput {
  readonly customerUserId: string;
  readonly serviceId: string;
  readonly serviceOptionId: string | null;
  readonly addressId: string;
  readonly bookingType: 'INSTANT' | 'SCHEDULED';
  /** Required for SCHEDULED bookings. */
  readonly requestedStart: Date | null;
  /** Selected service task ids in priority order; null = the service's defaults. */
  readonly taskIds: readonly string[] | null;
  readonly promoCode: string | null;
  readonly customerNotes: string | null;
  /** The total the customer was shown; if the price changed, booking is refused. */
  readonly expectedTotalPaise: number | null;
  readonly paymentMode: 'PREPAID' | 'PAY_AFTER_SERVICE';
  /** Client-generated key; retrying with the same key returns the same booking. */
  readonly idempotencyKey: string;
}

export interface BookingSummary {
  readonly id: string;
  readonly bookingCode: string;
  readonly status: BookingStatus;
  readonly scheduledStart: Date;
  readonly scheduledEnd: Date;
  readonly totalPaise: number;
  readonly paymentDueBy: Date | null;
  /** True when an earlier request with the same idempotency key created it. */
  readonly replayed: boolean;
}

const IDEMPOTENCY_CONSTRAINT = 'booking_customer_user_id_idempotency_key_key';

@Injectable()
export class BookingCreationService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly clock: Clock,
    private readonly serviceability: ServiceabilityService,
    private readonly pricing: PricingService,
    private readonly capacity: CapacityService,
  ) {}

  /**
   * Creates a booking and holds worker capacity for it in one transaction. Either the
   * booking exists with every crew slot held by an eligible worker, or nothing is saved.
   */
  async create(input: CreateBookingInput, context: ActionContext): Promise<BookingSummary> {
    this.authorise(input, context);

    const existing = await this.findByIdempotencyKey(input);
    if (existing) return existing;

    try {
      return await inTransaction(this.db, context, (tx) => this.createInTx(tx, input, context));
    } catch (error) {
      // A concurrent retry with the same key won the race: return its booking.
      if (
        error instanceof ConflictError &&
        error.details?.['constraint'] === IDEMPOTENCY_CONSTRAINT
      ) {
        const winner = await this.findByIdempotencyKey(input);
        if (winner) return winner;
      }
      throw error;
    }
  }

  private authorise(input: CreateBookingInput, context: ActionContext): void {
    if (context.source === 'CUSTOMER_APP') {
      if (context.actorUserId !== input.customerUserId) {
        throw new ForbiddenError('NOT_YOUR_ACCOUNT', 'Customers can only book for themselves');
      }
      if (input.paymentMode !== 'PREPAID') {
        throw new ForbiddenError('PAYMENT_MODE_NOT_ALLOWED', 'App bookings must be prepaid');
      }
    } else if (context.source !== 'ADMIN') {
      throw new ForbiddenError(
        'BOOKING_SOURCE_NOT_ALLOWED',
        `${context.source} cannot create bookings`,
      );
    }
    if (!context.actorUserId) {
      throw new ForbiddenError('ACTOR_REQUIRED', 'Bookings must be created by an identified user');
    }
  }

  private async createInTx(
    tx: Tx,
    input: CreateBookingInput,
    context: ActionContext,
  ): Promise<BookingSummary> {
    const now = this.clock.now();

    const service = await tx
      .selectFrom('service')
      .selectAll()
      .where('id', '=', input.serviceId)
      .where('is_active', '=', true)
      .executeTakeFirst();
    if (!service) throw new NotFoundError('Service', input.serviceId);

    const option = await this.loadOption(tx, input);
    const timing: ServiceTiming = {
      durationMinutes: option?.duration_minutes ?? service.duration_minutes,
      bufferBeforeMinutes: service.buffer_before_minutes,
      bufferAfterMinutes: service.buffer_after_minutes,
    };

    const address = await tx
      .selectFrom('address')
      .selectAll()
      .where('id', '=', input.addressId)
      .where('user_id', '=', input.customerUserId)
      .where('archived_at', 'is', null)
      .executeTakeFirst();
    if (!address) throw new NotFoundError('Address', input.addressId);

    const location = await this.serviceability.resolve(tx, {
      pincode: address.pincode,
      lat: address.lat,
      lng: address.lng,
      serviceId: service.id,
    });
    if (!location) {
      throw new BusinessRuleError(
        'AREA_NOT_SERVICEABLE',
        'This service is not available at the selected address yet',
      );
    }

    const start =
      input.bookingType === 'INSTANT'
        ? instantStart(service, now)
        : validateScheduledStart(service, input.requestedStart, now);
    const promise = servicePeriod(start, timing);
    const blocked = reservationPeriod(start, timing);

    const priced = await this.pricing.price(tx, {
      customerUserId: input.customerUserId,
      serviceId: service.id,
      serviceOptionId: option?.id ?? null,
      cityId: location.cityId,
      zoneId: location.zoneId,
      bookingType: input.bookingType,
      serviceStart: start,
      timeZone: location.timeZone,
      promoCode: input.promoCode?.trim() || null,
      now,
    });
    if (input.expectedTotalPaise !== null && input.expectedTotalPaise !== priced.quote.totalPaise) {
      throw new ConflictError('PRICE_CHANGED', 'The price has changed; please review it again', {
        expectedTotalPaise: input.expectedTotalPaise,
        currentTotalPaise: priced.quote.totalPaise,
      });
    }

    const paymentDueBy = new Date(now.getTime() + service.payment_hold_minutes * MINUTE_MS);

    const booking = await tx
      .insertInto('booking')
      .values({
        customer_user_id: input.customerUserId,
        source: context.source,
        created_by_user_id: context.actorUserId ?? input.customerUserId,
        service_id: service.id,
        service_option_id: option?.id ?? null,
        city_id: location.cityId,
        zone_id: location.zoneId,
        locality_id: location.localityId,
        address_id: address.id,
        address_snapshot: JSON.stringify(addressSnapshot(address, location)),
        booking_type: input.bookingType,
        // original_* are set from scheduled_* by the database and can never change.
        original_start: promise.start,
        original_end: promise.end,
        scheduled_start: promise.start,
        scheduled_end: promise.end,
        payment_mode: input.paymentMode,
        subtotal_paise: priced.quote.subtotalPaise,
        discount_paise: priced.quote.discountPaise,
        tax_paise: priced.quote.taxPaise,
        total_paise: priced.quote.totalPaise,
        price_rule_id: priced.priceRuleId,
        promotion_id: priced.promotionId,
        payment_due_by: paymentDueBy,
        customer_notes: input.customerNotes?.trim() || null,
        idempotency_key: input.idempotencyKey,
      })
      .returning(['id', 'booking_code', 'status'])
      .executeTakeFirstOrThrow();

    await tx
      .insertInto('booking_price_line')
      .values(
        priced.quote.lines.map((line, index) => ({
          booking_id: booking.id,
          line_no: index + 1,
          line_type: line.type,
          code: line.code,
          label: line.label,
          amount_paise: line.amountPaise,
          source_id: line.sourceId,
        })),
      )
      .execute();

    await this.insertTasks(tx, booking.id, service.id, input.taskIds);

    if (priced.promotionId) {
      await tx
        .insertInto('promotion_redemption')
        .values({
          promotion_id: priced.promotionId,
          user_id: input.customerUserId,
          booking_id: booking.id,
          discount_paise: priced.quote.discountPaise,
        })
        .execute();
    }

    for (let crewSlot = 1; crewSlot <= service.workers_required; crewSlot += 1) {
      const reservation = await this.capacity.reserve(tx, {
        bookingId: booking.id,
        serviceId: service.id,
        zoneId: location.zoneId,
        period: blocked,
        crewSlot,
        status: 'HELD',
        holdExpiresAt: paymentDueBy,
      });
      if (!reservation) {
        throw new ConflictError(
          'NO_AVAILABILITY',
          'No verified worker is available at this time. Please choose another slot.',
          { requestedStart: start.toISOString() },
        );
      }
    }

    return {
      id: booking.id,
      bookingCode: booking.booking_code,
      status: booking.status as BookingStatus,
      scheduledStart: promise.start,
      scheduledEnd: promise.end,
      totalPaise: priced.quote.totalPaise,
      paymentDueBy,
      replayed: false,
    };
  }

  private async loadOption(tx: Tx, input: CreateBookingInput) {
    if (input.serviceOptionId === null) {
      const options = await tx
        .selectFrom('service_option')
        .selectAll()
        .where('service_id', '=', input.serviceId)
        .where('is_active', '=', true)
        .execute();
      if (options.length === 0) return null;
      const fallback = options.find((o) => o.is_default);
      if (!fallback) {
        throw new ValidationError(
          'SERVICE_OPTION_REQUIRED',
          'Please choose an option for this service',
        );
      }
      return fallback;
    }
    const option = await tx
      .selectFrom('service_option')
      .selectAll()
      .where('id', '=', input.serviceOptionId)
      .where('service_id', '=', input.serviceId)
      .where('is_active', '=', true)
      .executeTakeFirst();
    if (!option) throw new NotFoundError('Service option', input.serviceOptionId);
    return option;
  }

  private async insertTasks(
    tx: Tx,
    bookingId: string,
    serviceId: string,
    taskIds: readonly string[] | null,
  ): Promise<void> {
    const tasks = await tx
      .selectFrom('service_task')
      .select(['id', 'name', 'is_default_selected', 'sort_order'])
      .where('service_id', '=', serviceId)
      .where('is_active', '=', true)
      .orderBy('sort_order')
      .execute();

    let chosen: typeof tasks;
    if (taskIds === null) {
      chosen = tasks.filter((t) => t.is_default_selected);
    } else {
      if (new Set(taskIds).size !== taskIds.length) {
        throw new ValidationError('DUPLICATE_TASKS', 'Each task can be chosen once');
      }
      const byId = new Map(tasks.map((t) => [t.id, t]));
      chosen = taskIds.map((id) => {
        const task = byId.get(id);
        if (!task)
          throw new ValidationError('UNKNOWN_TASK', `Task ${id} is not part of this service`);
        return task;
      });
    }
    if (chosen.length === 0) return;

    await tx
      .insertInto('booking_task')
      .values(
        chosen.map((task, index) => ({
          booking_id: bookingId,
          service_task_id: task.id,
          name: task.name,
          priority: index + 1,
        })),
      )
      .execute();
  }

  private async findByIdempotencyKey(input: CreateBookingInput): Promise<BookingSummary | null> {
    const row = await this.db
      .selectFrom('booking')
      .select([
        'id',
        'booking_code',
        'status',
        'scheduled_start',
        'scheduled_end',
        'total_paise',
        'payment_due_by',
      ])
      .where('customer_user_id', '=', input.customerUserId)
      .where('idempotency_key', '=', input.idempotencyKey)
      .executeTakeFirst();
    if (!row) return null;
    return {
      id: row.id,
      bookingCode: row.booking_code,
      status: row.status as BookingStatus,
      scheduledStart: row.scheduled_start,
      scheduledEnd: row.scheduled_end,
      totalPaise: row.total_paise,
      paymentDueBy: row.payment_due_by,
      replayed: true,
    };
  }
}

function addressSnapshot(
  address: {
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
  },
  location: ServiceLocation,
) {
  return {
    addressId: address.id,
    label: address.label,
    contactName: address.contact_name,
    contactPhone: address.contact_phone_e164,
    houseNumber: address.house_number,
    building: address.building,
    street: address.street,
    landmark: address.landmark,
    pincode: address.pincode,
    cityName: address.city_name,
    lat: address.lat,
    lng: address.lng,
    accessNotes: address.access_notes,
    localityId: location.localityId,
  };
}
