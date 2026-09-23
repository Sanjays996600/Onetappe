import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  Actor,
  CurrentPrincipal,
  ForApp,
  RequirePermissions,
  RequireRecentMfa,
} from '../auth/decorators.js';
import type { Principal } from '../auth/principal.js';
import { BookingLifecycleService } from '../booking/booking-lifecycle.service.js';
import { DispatchService } from '../booking/dispatch.service.js';
import { ZodPipe } from '../common/http/zod.pipe.js';
import type { ActionContext } from '../database/action-context.js';
import { BookingCancellationService } from '../payments/booking-cancellation.service.js';
import { AdminBookingService } from './admin-booking.service.js';
import { BookingTraceService } from './booking-trace.service.js';

const reason = z.string().trim().min(5, 'Give a meaningful reason').max(500);
const ReasonBody = z.object({ reason }).strict();
const SearchQuery = z.object({
  status: z
    .string()
    .regex(/^[A-Z_]+$/)
    .optional(),
  code: z
    .string()
    .regex(/^OT\d{8}$/i)
    .optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const ManualBody = z
  .object({
    customer: z
      .object({
        phone: z.string().regex(/^\+91[6-9]\d{9}$/),
        fullName: z.string().trim().min(1).max(120),
      })
      .strict(),
    address: z
      .object({
        houseNumber: z.string().trim().min(1).max(60),
        building: z.string().trim().max(120).nullable().default(null),
        street: z.string().trim().max(160).nullable().default(null),
        landmark: z.string().trim().max(160).nullable().default(null),
        pincode: z.string().regex(/^[1-9]\d{5}$/),
        cityName: z.string().trim().min(1).max(80),
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        accessNotes: z.string().trim().max(500).nullable().default(null),
      })
      .strict(),
    serviceId: z.uuid(),
    serviceOptionId: z.uuid().nullable().default(null),
    bookingType: z.enum(['INSTANT', 'SCHEDULED']),
    startAt: z.iso.datetime({ offset: true }).nullable().default(null),
    taskIds: z.array(z.uuid()).max(30).nullable().default(null),
    notes: z.string().trim().max(1000).nullable().default(null),
    paymentMode: z.enum(['PREPAID', 'PAY_AFTER_SERVICE']),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
    reason,
  })
  .strict();
const AssignBody = z.object({ workerId: z.uuid(), reason }).strict();
const RescheduleBody = z.object({ startAt: z.iso.datetime({ offset: true }), reason }).strict();
const CancelBody = z
  .object({ reason, fault: z.enum(['CUSTOMER', 'COMPANY', 'NO_WORKER']) })
  .strict();

/**
 * Operations on bookings. Every change requires a reason, which is written — with the
 * actor, time, previous and new values — to the booking history and the audit log.
 */
@Controller('admin/bookings')
@ForApp('ADMIN_WEB')
export class AdminBookingController {
  constructor(
    private readonly bookings: AdminBookingService,
    private readonly dispatch: DispatchService,
    private readonly lifecycle: BookingLifecycleService,
    private readonly cancellation: BookingCancellationService,
    private readonly traces: BookingTraceService,
  ) {}

  @Get()
  @RequirePermissions('booking.read')
  search(
    @CurrentPrincipal() principal: Principal,
    @Query(new ZodPipe(SearchQuery)) query: z.infer<typeof SearchQuery>,
  ) {
    return this.bookings.search(principal, {
      status: query.status ?? null,
      code: query.code ?? null,
      from: query.from ? new Date(query.from) : null,
      to: query.to ? new Date(query.to) : null,
      limit: query.limit,
    });
  }

  @Get(':id')
  @RequirePermissions('booking.read')
  detail(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.bookings.detail(principal, id);
  }

  /** Everything that happened to the booking, across the system, with request ids. */
  @Get(':id/trace')
  @RequirePermissions('booking.read')
  trace(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.traces.trace(principal, id);
  }

  @Post()
  @RequirePermissions('booking.create_on_behalf')
  create(
    @CurrentPrincipal() principal: Principal,
    @Actor() actor: ActionContext,
    @Body(new ZodPipe(ManualBody)) body: z.infer<typeof ManualBody>,
  ) {
    return this.bookings.createManual(
      principal,
      { ...actor, reason: body.reason },
      {
        ...body,
        startAt: body.startAt ? new Date(body.startAt) : null,
      },
    );
  }

  @Post(':id/assign')
  @RequirePermissions('booking.assign')
  async assign(
    @CurrentPrincipal() principal: Principal,
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(AssignBody)) body: z.infer<typeof AssignBody>,
  ) {
    await this.bookings.assertCity(principal, id, 'booking.assign');
    await this.dispatch.unassign(
      id,
      'REASSIGNED',
      body.reason,
      { ...actor, reason: body.reason },
      { assignToWorkerId: body.workerId },
    );
    return this.bookings.detail(principal, id);
  }

  /** Failed assignment: try again with whoever is eligible now. */
  @Post(':id/redispatch')
  @RequirePermissions('booking.assign')
  async redispatch(
    @CurrentPrincipal() principal: Principal,
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>,
  ) {
    await this.bookings.assertCity(principal, id, 'booking.assign');
    const result = await this.bookings.redispatch({ ...actor, reason: body.reason }, id);
    return { ...result, booking: await this.bookings.detail(principal, id) };
  }

  @Post(':id/reschedule')
  @RequirePermissions('booking.reschedule')
  async reschedule(
    @CurrentPrincipal() principal: Principal,
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(RescheduleBody)) body: z.infer<typeof RescheduleBody>,
  ) {
    await this.bookings.assertCity(principal, id, 'booking.reschedule');
    await this.lifecycle.reschedule(id, new Date(body.startAt), body.reason, {
      ...actor,
      reason: body.reason,
    });
    return this.bookings.detail(principal, id);
  }

  @Post(':id/cancel')
  @RequirePermissions('booking.cancel')
  async cancel(
    @CurrentPrincipal() principal: Principal,
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(CancelBody)) body: z.infer<typeof CancelBody>,
  ) {
    await this.bookings.assertCity(principal, id, 'booking.cancel');
    const result = await this.cancellation.cancel(id, body.reason, body.fault, {
      ...actor,
      reason: body.reason,
    });
    return { ...result, booking: await this.bookings.detail(principal, id) };
  }

  @Post(':id/customer-no-show')
  @RequirePermissions('booking.mark_no_show')
  async customerNoShow(
    @CurrentPrincipal() principal: Principal,
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>,
  ) {
    await this.bookings.assertCity(principal, id, 'booking.mark_no_show');
    await this.lifecycle.recordFieldEvent(
      id,
      'CUSTOMER_NO_SHOW',
      { ...actor, reason: body.reason },
      body.reason,
    );
    return this.bookings.detail(principal, id);
  }

  /** The assigned worker did not come: they are taken off the job and it is offered again. */
  @Post(':id/worker-no-show')
  @RequirePermissions('booking.mark_no_show', 'booking.assign')
  async workerNoShow(
    @CurrentPrincipal() principal: Principal,
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>,
  ) {
    await this.bookings.assertCity(principal, id, 'booking.mark_no_show');
    const result = await this.dispatch.unassign(id, 'WORKER_NO_SHOW', body.reason, {
      ...actor,
      reason: body.reason,
    });
    return { ...result, booking: await this.bookings.detail(principal, id) };
  }

  @Post(':id/confirm-without-prepayment')
  @RequirePermissions('booking.override')
  @RequireRecentMfa()
  async confirmWithoutPrepayment(
    @CurrentPrincipal() principal: Principal,
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>,
  ) {
    await this.bookings.assertCity(principal, id, 'booking.override');
    const result = await this.dispatch.confirmWithoutPrepayment(id, body.reason, {
      ...actor,
      reason: body.reason,
    });
    return { ...result, booking: await this.bookings.detail(principal, id) };
  }

  @Post(':id/start-override')
  @RequirePermissions('booking.override')
  @RequireRecentMfa()
  async startOverride(
    @CurrentPrincipal() principal: Principal,
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>,
  ) {
    await this.bookings.assertCity(principal, id, 'booking.override');
    await this.lifecycle.startService(
      id,
      { ...actor, reason: body.reason },
      { overrideReason: body.reason },
    );
    return this.bookings.detail(principal, id);
  }

  @Post(':id/hold')
  @HttpCode(200)
  @RequirePermissions('booking.reschedule')
  async hold(
    @CurrentPrincipal() principal: Principal,
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>,
  ) {
    await this.bookings.assertCity(principal, id, 'booking.reschedule');
    await this.bookings.hold({ ...actor, reason: body.reason }, id);
    return this.bookings.detail(principal, id);
  }

  @Post(':id/release-hold')
  @HttpCode(200)
  @RequirePermissions('booking.reschedule', 'booking.assign')
  async releaseHold(
    @CurrentPrincipal() principal: Principal,
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>,
  ) {
    await this.bookings.assertCity(principal, id, 'booking.reschedule');
    const result = await this.bookings.releaseHold({ ...actor, reason: body.reason }, id);
    return { ...result, booking: await this.bookings.detail(principal, id) };
  }
}
