import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { z } from 'zod';
import { Actor, ForApp, RequirePermissions } from '../auth/decorators.js';
import { ZodPipe } from '../common/http/zod.pipe.js';
import type { ActionContext } from '../database/action-context.js';
import { AdminPeopleService } from './admin-people.service.js';

const reason = z.string().trim().min(5, 'Give a meaningful reason').max(500);
const ReasonBody = z.object({ reason }).strict();
const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
const CustomerQuery = ListQuery.extend({
  phoneLast4: z
    .string()
    .regex(/^\d{4}$/)
    .optional(),
});
const WorkerQuery = ListQuery.extend({
  status: z
    .string()
    .regex(/^[A-Z_]+$/)
    .optional(),
});
const VerificationTypes = [
  'IDENTITY',
  'ADDRESS',
  'POLICE',
  'REFERENCE',
  'FITNESS',
  'SKILL_ASSESSMENT',
  'CONTRACT',
  'PHOTO',
  'BANK_ACCOUNT',
] as const;

const DecisionBody = z
  .object({
    decision: z.enum(['VERIFIED', 'REJECTED']),
    reason,
    expiresAt: z.iso.datetime({ offset: true }).nullable().default(null),
  })
  .strict();
const RecordVerificationBody = DecisionBody.extend({
  type: z.enum(VerificationTypes),
  method: z.string().trim().min(2).max(100),
}).strict();
const TrainingBody = z
  .object({
    moduleCode: z.string().regex(/^[A-Z0-9_]{2,40}$/),
    status: z.enum(['PASSED', 'FAILED']),
    score: z.number().int().min(0).max(100).nullable().default(null),
    expiresAt: z.iso.datetime({ offset: true }).nullable().default(null),
    reason,
  })
  .strict();
const StatusBody = z
  .object({
    status: z.enum([
      'APPROVED',
      'ACTIVE',
      'SUSPENDED',
      'RESTRICTED',
      'REJECTED',
      'INACTIVE',
      'PROFILE_PENDING',
    ]),
    reason,
  })
  .strict();
const PermissionBody = z
  .object({ serviceId: z.uuid(), zoneId: z.uuid().nullable().default(null), reason })
  .strict();
const ShiftBody = z
  .object({
    zoneId: z.uuid(),
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
    reason: z.string().trim().max(500).nullable().default(null),
  })
  .strict();
const RestrictionBody = z
  .object({
    serviceId: z.uuid().nullable().default(null),
    zoneId: z.uuid().nullable().default(null),
    reason,
    reviewAt: z.iso.datetime({ offset: true }),
  })
  .strict();

@Controller('admin')
@ForApp('ADMIN_WEB')
export class AdminPeopleController {
  constructor(private readonly people: AdminPeopleService) {}

  // ---- Customers ----

  @Get('customers')
  @RequirePermissions('customer.read')
  customers(@Query(new ZodPipe(CustomerQuery)) query: z.infer<typeof CustomerQuery>) {
    return this.people.customers({ phoneLast4: query.phoneLast4 ?? null, limit: query.limit });
  }

  @Get('customers/:id')
  @RequirePermissions('customer.read')
  customer(@Param('id', ParseUUIDPipe) id: string) {
    return this.people.customer(id);
  }

  /** Full phone number and addresses, e.g. to call the customer. Audited. */
  @Post('customers/:id/reveal')
  @HttpCode(200)
  @RequirePermissions('customer.pii.reveal')
  revealCustomer(
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>,
  ) {
    return this.people.revealCustomer(actor, id, body.reason);
  }

  // ---- Workers ----

  @Get('workers')
  @RequirePermissions('worker.read')
  workers(@Query(new ZodPipe(WorkerQuery)) query: z.infer<typeof WorkerQuery>) {
    return this.people.workers({ status: query.status ?? null, limit: query.limit });
  }

  @Get('workers/:id')
  @RequirePermissions('worker.read')
  worker(@Param('id', ParseUUIDPipe) id: string) {
    return this.people.worker(id);
  }

  @Post('workers/:id/reveal')
  @HttpCode(200)
  @RequirePermissions('worker.pii.reveal')
  revealWorker(
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>,
  ) {
    return this.people.revealWorker(actor, id, body.reason);
  }

  @Post('workers/:id/verifications/:verificationId/document')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  // Served as an inert download: never rendered or sniffed as active content.
  @Header('x-content-type-options', 'nosniff')
  @Header('content-security-policy', "default-src 'none'; sandbox")
  @RequirePermissions('worker.documents.view')
  async document(
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('verificationId', ParseUUIDPipe) verificationId: string,
    @Body(new ZodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>,
  ) {
    const file = await this.people.document(actor, id, verificationId, body.reason);
    return new StreamableFile(file.bytes, {
      type: file.contentType,
      disposition: `attachment; filename="document-${verificationId}"`,
    });
  }

  @Post('workers/:id/verifications/:verificationId/decision')
  @RequirePermissions('worker.verification.decide')
  decide(
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('verificationId', ParseUUIDPipe) verificationId: string,
    @Body(new ZodPipe(DecisionBody)) body: z.infer<typeof DecisionBody>,
  ) {
    return this.people.decideVerification(actor, id, verificationId, {
      ...body,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    });
  }

  /** Checks done by staff: police verification, references, skills assessment. */
  @Post('workers/:id/verifications')
  @RequirePermissions('worker.verification.decide')
  recordVerification(
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(RecordVerificationBody)) body: z.infer<typeof RecordVerificationBody>,
  ) {
    return this.people.recordVerification(actor, id, {
      ...body,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    });
  }

  @Post('workers/:id/training')
  @RequirePermissions('worker.verification.decide')
  training(
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(TrainingBody)) body: z.infer<typeof TrainingBody>,
  ) {
    return this.people.recordTraining(actor, id, {
      ...body,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    });
  }

  @Post('workers/:id/status')
  @RequirePermissions('worker.status.manage')
  status(
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(StatusBody)) body: z.infer<typeof StatusBody>,
  ) {
    return this.people.changeStatus(actor, id, body.status, body.reason);
  }

  @Post('workers/:id/service-permissions')
  @RequirePermissions('worker.manage')
  permit(
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(PermissionBody)) body: z.infer<typeof PermissionBody>,
  ) {
    return this.people.grantServicePermission(actor, id, body);
  }

  @Post('workers/:id/shifts')
  @HttpCode(204)
  @RequirePermissions('availability.manage')
  async shift(
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ShiftBody)) body: z.infer<typeof ShiftBody>,
  ) {
    await this.people.addShift(actor, id, {
      zoneId: body.zoneId,
      start: new Date(body.start),
      end: new Date(body.end),
      reason: body.reason,
    });
  }

  @Post('workers/:id/restrictions')
  @RequirePermissions('worker.restriction.manage')
  restrict(
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(RestrictionBody)) body: z.infer<typeof RestrictionBody>,
  ) {
    return this.people.restrict(actor, id, { ...body, reviewAt: new Date(body.reviewAt) });
  }

  @Post('workers/:id/restrictions/:restrictionId/lift')
  @RequirePermissions('worker.restriction.manage')
  lift(
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('restrictionId', ParseUUIDPipe) restrictionId: string,
    @Body(new ZodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>,
  ) {
    return this.people.liftRestriction(actor, id, restrictionId, body.reason);
  }
}
