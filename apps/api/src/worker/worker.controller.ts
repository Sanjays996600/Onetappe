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
import { BookingLifecycleService } from '../booking/booking-lifecycle.service.js';
import { DispatchService } from '../booking/dispatch.service.js';
import { ZodPipe } from '../common/http/zod.pipe.js';
import { DeviceBody } from '../customer/customer.controller.js';
import { DeviceService } from '../customer/device.service.js';
import type { ActionContext } from '../database/action-context.js';
import { SAFETY_CATEGORIES, SafetyService } from '../support/safety.service.js';
import { SUPPORT_CATEGORIES, SupportService } from '../support/support.service.js';
import { WORKER_UPLOADED_TYPES } from './worker-onboarding.service.js';
import { WorkerService } from './worker.service.js';
import { LegalService } from '../legal/legal.service.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const phone = z.string().regex(/^\+[1-9]\d{7,14}$/);

const ProfileBody = z
  .object({
    fullName: text(120).optional(),
    dateOfBirth: z.iso.date().optional(),
    gender: z.enum(['FEMALE', 'MALE', 'OTHER', 'UNDISCLOSED']).optional(),
    languages: z
      .array(z.string().regex(/^[a-z]{2,3}$/))
      .max(10)
      .optional(),
    emergencyContactName: text(120).optional(),
    emergencyContactPhone: phone.optional(),
    homeAddress: z
      .object({
        houseNumber: text(60),
        street: z.string().trim().max(160).nullable().default(null),
        landmark: z.string().trim().max(160).nullable().default(null),
        pincode: z.string().regex(/^[1-9]\d{5}$/),
        cityName: text(80),
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
      })
      .strict()
      .optional(),
  })
  .strict();

const UploadBody = z
  .object({ verificationType: z.enum(WORKER_UPLOADED_TYPES), contentType: z.string().max(100) })
  .strict();
const SubmitBody = z
  .object({
    verificationType: z.enum(WORKER_UPLOADED_TYPES),
    documentId: z.uuid(),
    // Never a full ID number: last characters only.
    referenceLast4: z
      .string()
      .regex(/^[A-Za-z0-9]{4}$/)
      .nullable()
      .default(null),
  })
  .strict();
const PresenceBody = z
  .object({
    online: z.boolean(),
    lat: z.number().min(-90).max(90).nullable().default(null),
    lng: z.number().min(-180).max(180).nullable().default(null),
  })
  .strict();
const ReasonBody = z.object({ reason: text(500) }).strict();
const StartBody = z
  .object({ code: z.string().regex(/^\d{4}$/, 'Enter the 4-digit code') })
  .strict();
const LimitQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) });
const SupportBody = z
  .object({
    bookingId: z.uuid().nullable().default(null),
    category: z.enum(SUPPORT_CATEGORIES),
    subject: text(200),
    description: text(5000),
  })
  .strict();
const SosBody = z
  .object({
    bookingId: z.uuid().nullable().default(null),
    category: z.enum(SAFETY_CATEGORIES).default('SOS'),
    note: z.string().trim().max(2000).default('SOS raised from the worker app'),
    lat: z.number().min(-90).max(90).nullable().default(null),
    lng: z.number().min(-180).max(180).nullable().default(null),
  })
  .strict();

/**
 * Worker app API. The app's buttons are only hints: each action is re-validated by the
 * booking state machine, the assignment check and the database.
 */
@Controller('worker')
@ForApp('WORKER_APP')
export class WorkerController {
  constructor(
    private readonly workers: WorkerService,
    private readonly devices: DeviceService,
    private readonly dispatch: DispatchService,
    private readonly lifecycle: BookingLifecycleService,
    private readonly support: SupportService,
    private readonly safety: SafetyService,
    private readonly legal: LegalService,
  ) {}

  @Get('me')
  me(@Actor() actor: ActionContext) {
    return this.workers.profile(actor.actorUserId ?? '');
  }

  @Patch('me')
  update(
    @Actor() actor: ActionContext,
    @Body(new ZodPipe(ProfileBody)) body: z.infer<typeof ProfileBody>,
  ) {
    return this.workers.updateProfile(actor, body);
  }

  @Post('devices')
  @HttpCode(204)
  async device(
    @Actor() actor: ActionContext,
    @Body(new ZodPipe(DeviceBody)) body: z.infer<typeof DeviceBody>,
  ) {
    await this.devices.register(actor, 'WORKER_APP', body);
  }

  @Get('me/verifications')
  verifications(@Actor() actor: ActionContext) {
    return this.workers.verifications(actor.actorUserId ?? '');
  }

  @Post('me/documents')
  uploadTarget(
    @Actor() actor: ActionContext,
    @Body(new ZodPipe(UploadBody)) body: z.infer<typeof UploadBody>,
  ) {
    return this.workers.documentUploadTarget(actor, body.verificationType, body.contentType);
  }

  @Post('me/verifications')
  submit(
    @Actor() actor: ActionContext,
    @Body(new ZodPipe(SubmitBody)) body: z.infer<typeof SubmitBody>,
  ) {
    return this.workers.submitVerification(actor, body);
  }

  @Get('me/training')
  training(@Actor() actor: ActionContext) {
    return this.workers.training(actor.actorUserId ?? '');
  }

  @Post('me/presence')
  @HttpCode(200)
  async presence(
    @Actor() actor: ActionContext,
    @Body(new ZodPipe(PresenceBody)) body: z.infer<typeof PresenceBody>,
  ) {
    if (body.online) await this.legal.assertAccepted(actor.actorUserId ?? '', 'WORKER_APP');
    return this.workers.setPresence(actor, body);
  }

  @Get('me/shifts')
  shifts(@Actor() actor: ActionContext) {
    return this.workers.shifts(actor.actorUserId ?? '');
  }

  @Get('offers')
  offers(@Actor() actor: ActionContext) {
    return this.workers.offers(actor.actorUserId ?? '');
  }

  @Post('offers/:id/accept')
  @HttpCode(200)
  async accept(@Actor() actor: ActionContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.dispatch.accept(id, actor);
    return this.workers.currentJob(actor.actorUserId ?? '');
  }

  @Post('offers/:id/reject')
  @HttpCode(204)
  async reject(
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>,
  ) {
    await this.dispatch.reject(id, body.reason, actor);
  }

  @Get('jobs/current')
  current(@Actor() actor: ActionContext) {
    return this.workers.currentJob(actor.actorUserId ?? '');
  }

  @Get('jobs')
  history(
    @Actor() actor: ActionContext,
    @Query(new ZodPipe(LimitQuery)) query: z.infer<typeof LimitQuery>,
  ) {
    return this.workers.jobHistory(actor.actorUserId ?? '', query.limit);
  }

  @Get('jobs/:bookingId')
  job(@Actor() actor: ActionContext, @Param('bookingId', ParseUUIDPipe) bookingId: string) {
    return this.workers.job(actor.actorUserId ?? '', bookingId);
  }

  @Post('jobs/:bookingId/en-route')
  @HttpCode(200)
  async enRoute(
    @Actor() actor: ActionContext,
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
  ) {
    await this.lifecycle.recordFieldEvent(bookingId, 'START_TRAVEL', actor);
    return this.workers.job(actor.actorUserId ?? '', bookingId);
  }

  @Post('jobs/:bookingId/arrived')
  @HttpCode(200)
  async arrived(
    @Actor() actor: ActionContext,
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
  ) {
    await this.lifecycle.recordFieldEvent(bookingId, 'MARK_ARRIVED', actor);
    return this.workers.job(actor.actorUserId ?? '', bookingId);
  }

  @Post('jobs/:bookingId/start')
  @HttpCode(200)
  async start(
    @Actor() actor: ActionContext,
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Body(new ZodPipe(StartBody)) body: z.infer<typeof StartBody>,
  ) {
    await this.lifecycle.startService(bookingId, actor, { code: body.code });
    return this.workers.job(actor.actorUserId ?? '', bookingId);
  }

  @Post('jobs/:bookingId/complete')
  @HttpCode(200)
  async complete(
    @Actor() actor: ActionContext,
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
  ) {
    await this.lifecycle.recordFieldEvent(bookingId, 'COMPLETE_SERVICE', actor);
    return this.workers.job(actor.actorUserId ?? '', bookingId);
  }

  @Post('jobs/:bookingId/customer-no-show')
  @HttpCode(200)
  async customerNoShow(
    @Actor() actor: ActionContext,
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Body(new ZodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>,
  ) {
    await this.lifecycle.recordFieldEvent(bookingId, 'CUSTOMER_NO_SHOW', actor, body.reason);
    return this.workers.job(actor.actorUserId ?? '', bookingId);
  }

  @Post('jobs/:bookingId/withdraw')
  @HttpCode(204)
  async withdraw(
    @Actor() actor: ActionContext,
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Body(new ZodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>,
  ) {
    await this.dispatch.unassign(bookingId, 'WORKER_WITHDREW', body.reason, actor);
  }

  @Get('earnings')
  earnings(@Actor() actor: ActionContext) {
    return this.workers.earnings(actor.actorUserId ?? '');
  }

  @Post('support-cases')
  openCase(
    @Actor() actor: ActionContext,
    @IdempotencyKey() key: string,
    @Body(new ZodPipe(SupportBody)) body: z.infer<typeof SupportBody>,
  ) {
    return this.support.open(
      actor,
      'WORKER',
      { ...body, desiredResolution: null },
      { key, hash: requestHash(body) },
    );
  }

  @Post('sos')
  sos(
    @Actor() actor: ActionContext,
    @IdempotencyKey() key: string,
    @Body(new ZodPipe(SosBody)) body: z.infer<typeof SosBody>,
  ) {
    return this.safety.raise(
      actor,
      'WORKER',
      {
        bookingId: body.bookingId,
        category: body.category,
        severity: body.category === 'SOS' ? 'CRITICAL' : 'HIGH',
        summary: body.note,
        lat: body.lat,
        lng: body.lng,
        locationText: null,
      },
      { key, hash: requestHash(body) },
    );
  }
}
