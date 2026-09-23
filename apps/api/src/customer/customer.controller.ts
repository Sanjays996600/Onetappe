import { IdempotencyKey, requestHash } from '../common/http/idempotency.js';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { Actor, ForApp } from '../auth/decorators.js';
import { BookingCreationService } from '../booking/booking-creation.service.js';
import { BookingLifecycleService } from '../booking/booking-lifecycle.service.js';
import { AvailabilityService } from '../catalog/availability.service.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { BusinessRuleError, NotFoundError } from '../common/errors.js';
import { ZodPipe } from '../common/http/zod.pipe.js';
import type { ActionContext } from '../database/action-context.js';
import { BookingCancellationService } from '../payments/booking-cancellation.service.js';
import { PaymentService } from '../payments/payment.service.js';
import { SafetyService } from '../support/safety.service.js';
import { SUPPORT_CATEGORIES, SupportService } from '../support/support.service.js';
import { DeviceService } from './device.service.js';
import { CustomerService } from './customer.service.js';
import { LegalService } from '../legal/legal.service.js';

const phone = z.string().regex(/^\+[1-9]\d{7,14}$/, 'Use international format, e.g. +919876543210');
const text = (max: number) => z.string().trim().min(1).max(max);

const ProfileBody = z
  .object({
    fullName: text(120).optional(),
    email: z.email().max(200).nullable().optional(),
    preferredLocale: z.enum(['en', 'hi']).optional(),
    marketingOptIn: z.boolean().optional(),
  })
  .strict();

const AddressBody = z
  .object({
    label: text(40).default('Home'),
    contactName: text(120),
    contactPhone: phone,
    houseNumber: text(60),
    building: z.string().trim().max(120).nullable().optional(),
    street: z.string().trim().max(160).nullable().optional(),
    landmark: z.string().trim().max(160).nullable().optional(),
    pincode: z.string().regex(/^[1-9]\d{5}$/),
    cityName: text(80),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accessNotes: z.string().trim().max(500).nullable().optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();

const LocationQuery = z.object({
  pincode: z.string().regex(/^[1-9]\d{5}$/),
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  locale: z.enum(['en', 'hi']).default('en'),
});

const QuoteBody = z
  .object({
    serviceId: z.uuid(),
    serviceOptionId: z.uuid().nullable().default(null),
    addressId: z.uuid(),
    bookingType: z.enum(['INSTANT', 'SCHEDULED']),
    startAt: z.iso.datetime({ offset: true }).nullable().default(null),
    promoCode: z.string().trim().max(30).nullable().default(null),
  })
  .strict();

const BookingBody = QuoteBody.extend({
  taskIds: z.array(z.uuid()).max(30).nullable().default(null),
  notes: z.string().trim().max(1000).nullable().default(null),
  expectedTotalPaise: z.number().int().nonnegative(),
}).strict();

const AvailabilityQuery = z.object({
  serviceId: z.uuid(),
  serviceOptionId: z.uuid().optional(),
  addressId: z.uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  before: z.iso.datetime({ offset: true }).optional(),
});

const ReasonBody = z.object({ reason: text(500) }).strict();
const RescheduleBody = z
  .object({ startAt: z.iso.datetime({ offset: true }), reason: text(500) })
  .strict();
const RatingBody = z
  .object({
    score: z.number().int().min(1).max(5),
    comment: z.string().trim().max(2000).nullable().default(null),
  })
  .strict();
const SupportBody = z
  .object({
    bookingId: z.uuid().nullable().default(null),
    category: z.enum(SUPPORT_CATEGORIES),
    subject: text(200),
    description: text(5000),
    desiredResolution: z.string().trim().max(1000).nullable().default(null),
  })
  .strict();
const SosBody = z
  .object({
    bookingId: z.uuid().nullable().default(null),
    note: z.string().trim().max(2000).default('SOS raised from the customer app'),
    lat: z.number().min(-90).max(90).nullable().default(null),
    lng: z.number().min(-180).max(180).nullable().default(null),
  })
  .strict();
export const DeviceBody = z
  .object({
    platform: z.enum(['ANDROID', 'IOS', 'WEB']),
    pushToken: z.string().min(10).max(4096),
    appVersion: z.string().max(40).nullable().default(null),
  })
  .strict();

/**
 * Customer app API. Controllers only translate HTTP to service calls: every rule lives in
 * the services, the booking engine and the database.
 */
@Controller('customer')
@ForApp('CUSTOMER_APP')
export class CustomerController {
  constructor(
    private readonly customers: CustomerService,
    private readonly devices: DeviceService,
    private readonly catalog: CatalogService,
    private readonly availability: AvailabilityService,
    private readonly creation: BookingCreationService,
    private readonly lifecycle: BookingLifecycleService,
    private readonly cancellation: BookingCancellationService,
    private readonly payments: PaymentService,
    private readonly support: SupportService,
    private readonly safety: SafetyService,
    private readonly legal: LegalService,
  ) {}

  // ---- Profile & devices ----

  @Get('me')
  me(@Actor() actor: ActionContext) {
    return this.customers.profile(actor.actorUserId ?? '');
  }

  @Patch('me')
  updateMe(
    @Actor() actor: ActionContext,
    @Body(new ZodPipe(ProfileBody)) body: z.infer<typeof ProfileBody>,
  ) {
    return this.customers.updateProfile(actor, body);
  }

  @Post('devices')
  @HttpCode(204)
  async registerDevice(
    @Actor() actor: ActionContext,
    @Body(new ZodPipe(DeviceBody)) body: z.infer<typeof DeviceBody>,
  ) {
    await this.devices.register(actor, 'CUSTOMER_APP', body);
  }

  // ---- Addresses ----

  @Get('addresses')
  addresses(@Actor() actor: ActionContext) {
    return this.customers.addresses(actor.actorUserId ?? '');
  }

  @Post('addresses')
  addAddress(
    @Actor() actor: ActionContext,
    @IdempotencyKey() key: string,
    @Body(new ZodPipe(AddressBody)) body: z.infer<typeof AddressBody>,
  ) {
    return this.customers.addAddress(actor, body, { key, hash: requestHash(body) });
  }

  @Post('addresses/:id/archive')
  @HttpCode(204)
  async archiveAddress(@Actor() actor: ActionContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.customers.archiveAddress(actor, id);
  }

  // ---- Discovery ----

  @Get('serviceability')
  async serviceability(@Query(new ZodPipe(LocationQuery)) query: z.infer<typeof LocationQuery>) {
    const location = await this.catalog.resolve(query);
    return {
      serviceable: location !== null,
      cityId: location?.cityId ?? null,
      zoneId: location?.zoneId ?? null,
    };
  }

  @Get('catalog')
  async catalogue(@Query(new ZodPipe(LocationQuery)) query: z.infer<typeof LocationQuery>) {
    const location = await this.catalog.resolve(query);
    if (!location) return { serviceable: false, categories: [] };
    return { serviceable: true, categories: await this.catalog.catalog(location, query.locale) };
  }

  @Get('services/:id')
  service(@Param('id', ParseUUIDPipe) id: string, @Query('locale') locale?: string) {
    return this.catalog.service(id, locale === 'hi' ? 'hi' : 'en');
  }

  @Post('quotes')
  @HttpCode(200)
  quote(
    @Actor() actor: ActionContext,
    @Body(new ZodPipe(QuoteBody)) body: z.infer<typeof QuoteBody>,
  ) {
    return this.customers.quote(actor, {
      ...body,
      startAt: body.startAt ? new Date(body.startAt) : null,
    });
  }

  @Get('availability')
  async slots(
    @Actor() actor: ActionContext,
    @Query(new ZodPipe(AvailabilityQuery)) query: z.infer<typeof AvailabilityQuery>,
  ) {
    const address = (await this.customers.addresses(actor.actorUserId ?? '')).find(
      (a) => a.id === query.addressId,
    );
    if (!address) throw new NotFoundError('Address', query.addressId);
    const location = await this.catalog.resolve({
      pincode: address.pincode,
      lat: address.lat,
      lng: address.lng,
    });
    if (!location)
      throw new BusinessRuleError(
        'AREA_NOT_SERVICEABLE',
        'This address is not in a service area yet',
      );
    const slots = await this.availability.slots({
      serviceId: query.serviceId,
      serviceOptionId: query.serviceOptionId ?? null,
      location,
      date: query.date,
    });
    return { date: query.date, slots: slots.map((s) => s.toISOString()) };
  }

  // ---- Bookings ----

  @Post('bookings')
  async createBooking(
    @Actor() actor: ActionContext,
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodPipe(BookingBody)) body: z.infer<typeof BookingBody>,
  ) {
    await this.legal.assertAccepted(actor.actorUserId ?? '', 'CUSTOMER_APP');
    const created = await this.creation.create(
      {
        customerUserId: actor.actorUserId ?? '',
        serviceId: body.serviceId,
        serviceOptionId: body.serviceOptionId,
        addressId: body.addressId,
        bookingType: body.bookingType,
        requestedStart: body.startAt ? new Date(body.startAt) : null,
        taskIds: body.taskIds,
        promoCode: body.promoCode,
        customerNotes: body.notes,
        expectedTotalPaise: body.expectedTotalPaise,
        paymentMode: 'PREPAID',
        idempotencyKey,
      },
      actor,
    );
    return {
      ...(await this.customers.booking(actor.actorUserId ?? '', created.id)),
      replayed: created.replayed,
    };
  }

  @Get('bookings')
  bookings(
    @Actor() actor: ActionContext,
    @Query(new ZodPipe(ListQuery)) query: z.infer<typeof ListQuery>,
  ) {
    return this.customers.bookings(actor.actorUserId ?? '', {
      limit: query.limit,
      before: query.before ? new Date(query.before) : null,
    });
  }

  @Get('bookings/:id')
  booking(@Actor() actor: ActionContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.customers.booking(actor.actorUserId ?? '', id);
  }

  @Get('bookings/:id/timeline')
  timeline(@Actor() actor: ActionContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.customers.timeline(actor.actorUserId ?? '', id);
  }

  @Post('bookings/:id/payments')
  async pay(@Actor() actor: ActionContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.customers.assertOwns(actor.actorUserId ?? '', id);
    const payment = await this.payments.initiate(id, actor);
    return { ...payment, payBy: payment.payBy.toISOString() };
  }

  /** "I have paid": the server checks with the gateway; the app's word is never enough. */
  @Post('bookings/:id/payments/:paymentId/refresh')
  @HttpCode(200)
  async refreshPayment(
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
  ) {
    const status = await this.payments.refreshFromGateway(id, paymentId, actor);
    return {
      paymentStatus: status,
      booking: await this.customers.booking(actor.actorUserId ?? '', id),
    };
  }

  @Post('bookings/:id/cancel')
  @HttpCode(200)
  async cancel(
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>,
  ) {
    await this.customers.assertOwns(actor.actorUserId ?? '', id);
    const result = await this.cancellation.cancel(id, body.reason, 'CUSTOMER', actor);
    return { ...result, booking: await this.customers.booking(actor.actorUserId ?? '', id) };
  }

  @Post('bookings/:id/reschedule')
  @HttpCode(200)
  async reschedule(
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(RescheduleBody)) body: z.infer<typeof RescheduleBody>,
  ) {
    await this.customers.assertOwns(actor.actorUserId ?? '', id);
    await this.lifecycle.reschedule(id, new Date(body.startAt), body.reason, actor);
    return this.customers.booking(actor.actorUserId ?? '', id);
  }

  @Get('bookings/:id/start-code')
  startCode(@Actor() actor: ActionContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.customers.startCode(actor.actorUserId ?? '', id);
  }

  @Get('bookings/:id/invoice')
  invoice(@Actor() actor: ActionContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.customers.invoice(actor.actorUserId ?? '', id);
  }

  @Post('bookings/:id/rating')
  @HttpCode(204)
  async rate(
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(RatingBody)) body: z.infer<typeof RatingBody>,
  ) {
    await this.customers.rate(actor, id, body);
  }

  // ---- Support & safety ----

  @Post('support-cases')
  openCase(
    @Actor() actor: ActionContext,
    @IdempotencyKey() key: string,
    @Body(new ZodPipe(SupportBody)) body: z.infer<typeof SupportBody>,
  ) {
    return this.support.open(actor, 'CUSTOMER', body, { key, hash: requestHash(body) });
  }

  @Get('support-cases')
  cases(@Actor() actor: ActionContext) {
    return this.support.listForRaiser(actor.actorUserId ?? '');
  }

  @Post('sos')
  sos(
    @Actor() actor: ActionContext,
    @IdempotencyKey() key: string,
    @Body(new ZodPipe(SosBody)) body: z.infer<typeof SosBody>,
  ) {
    return this.safety.raise(
      actor,
      'CUSTOMER',
      {
        bookingId: body.bookingId,
        category: 'SOS',
        severity: 'CRITICAL',
        summary: body.note,
        lat: body.lat,
        lng: body.lng,
        locationText: null,
      },
      { key, hash: requestHash(body) },
    );
  }

  @Get('notifications')
  notifications(
    @Actor() actor: ActionContext,
    @Query(new ZodPipe(ListQuery)) query: z.infer<typeof ListQuery>,
  ) {
    return this.customers.notifications(actor.actorUserId ?? '', query.limit);
  }
}
