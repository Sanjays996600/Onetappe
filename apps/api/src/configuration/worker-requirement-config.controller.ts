import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  Actor,
  CurrentPrincipal,
  ForApp,
  RequirePermissions,
  RequireRecentMfa,
} from '../auth/decorators.js';
import type { Principal } from '../auth/principal.js';
import { ZodPipe } from '../common/http/zod.pipe.js';
import type { ActionContext } from '../database/action-context.js';
import { assertCityScope } from './scope.js';
import {
  VERIFICATION_TYPES,
  WorkerRequirementService,
  type Requirement,
} from './worker-requirement.service.js';

const READ = 'worker_requirement.read';
const MANAGE = 'worker_requirement.manage';
const APPROVE = 'worker_requirement.approve_relaxation';

const Reason = z.string().trim().min(5).max(500);
const ModuleCode = z.string().regex(/^[A-Z0-9_]{2,40}$/);

const ModuleCreate = z
  .object({
    code: ModuleCode,
    name: z.string().trim().min(2).max(120),
    description: z.string().trim().max(2000).nullable().default(null),
    reason: Reason,
  })
  .strict();
const ModuleUpdate = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    isActive: z.boolean().optional(),
    reason: Reason,
  })
  .strict();
const VerificationBody = z
  .object({ verificationType: z.enum(VERIFICATION_TYPES), reason: Reason })
  .strict();
const TrainingBody = z.object({ moduleCode: ModuleCode, reason: Reason }).strict();
const RelaxationCreate = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('VERIFICATION'),
      serviceId: z.uuid(),
      verificationType: z.enum(VERIFICATION_TYPES),
      reason: Reason,
    })
    .strict(),
  z
    .object({
      kind: z.literal('TRAINING'),
      serviceId: z.uuid(),
      moduleCode: ModuleCode,
      reason: Reason,
    })
    .strict(),
]);
const Decision = z.object({ note: Reason }).strict();
const RelaxationStatus = z.enum(['PENDING', 'APPLIED', 'REJECTED', 'WITHDRAWN']).optional();

/**
 * Worker requirements: training modules, and the verifications and training each service
 * needs before a worker may be booked for it. Rules for every city, so every change needs
 * the permission for all cities and a fresh authenticator check. Removing a requirement is
 * a request that a different person must approve (see WorkerRequirementService).
 */
@Controller('admin/config')
@ForApp('ADMIN_WEB')
export class WorkerRequirementConfigController {
  constructor(private readonly requirements: WorkerRequirementService) {}

  @Get('worker-requirements')
  @RequirePermissions(READ)
  overview() {
    return this.requirements.overview();
  }

  @Get('worker-requirements/relaxations')
  @RequirePermissions(READ)
  relaxations(
    @Query('status', new ZodPipe(RelaxationStatus)) status: z.infer<typeof RelaxationStatus>,
  ) {
    return this.requirements.relaxations(status);
  }

  @Post('training-modules')
  @RequirePermissions(MANAGE)
  @RequireRecentMfa()
  createModule(
    @Actor() actor: ActionContext,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(ModuleCreate)) body: z.infer<typeof ModuleCreate>,
  ) {
    assertCityScope(principal, MANAGE, null);
    return this.requirements.createModule(actor, body);
  }

  @Patch('training-modules/:code')
  @RequirePermissions(MANAGE)
  @RequireRecentMfa()
  updateModule(
    @Actor() actor: ActionContext,
    @CurrentPrincipal() principal: Principal,
    @Param('code', new ZodPipe(ModuleCode)) code: string,
    @Body(new ZodPipe(ModuleUpdate)) body: z.infer<typeof ModuleUpdate>,
  ) {
    assertCityScope(principal, MANAGE, null);
    return this.requirements.updateModule(actor, code, body);
  }

  @Post('services/:id/verification-requirements')
  @RequirePermissions(MANAGE)
  @RequireRecentMfa()
  addVerification(
    @Actor() actor: ActionContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) serviceId: string,
    @Body(new ZodPipe(VerificationBody)) body: z.infer<typeof VerificationBody>,
  ) {
    assertCityScope(principal, MANAGE, null);
    return this.requirements.addRequirement(
      actor,
      serviceId,
      { kind: 'VERIFICATION', verificationType: body.verificationType },
      body.reason,
    );
  }

  @Post('services/:id/training-requirements')
  @RequirePermissions(MANAGE)
  @RequireRecentMfa()
  addTraining(
    @Actor() actor: ActionContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) serviceId: string,
    @Body(new ZodPipe(TrainingBody)) body: z.infer<typeof TrainingBody>,
  ) {
    assertCityScope(principal, MANAGE, null);
    return this.requirements.addRequirement(
      actor,
      serviceId,
      { kind: 'TRAINING', moduleCode: body.moduleCode },
      body.reason,
    );
  }

  @Post('worker-requirements/relaxations')
  @RequirePermissions(MANAGE)
  @RequireRecentMfa()
  requestRelaxation(
    @Actor() actor: ActionContext,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(RelaxationCreate)) body: z.infer<typeof RelaxationCreate>,
  ) {
    assertCityScope(principal, MANAGE, null);
    const requirement: Requirement =
      body.kind === 'VERIFICATION'
        ? { kind: 'VERIFICATION', verificationType: body.verificationType }
        : { kind: 'TRAINING', moduleCode: body.moduleCode };
    return this.requirements.requestRelaxation(actor, body.serviceId, requirement, body.reason);
  }

  @Post('worker-requirements/relaxations/:id/approve')
  @RequirePermissions(APPROVE)
  @RequireRecentMfa()
  approve(
    @Actor() actor: ActionContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(Decision)) body: z.infer<typeof Decision>,
  ) {
    assertCityScope(principal, APPROVE, null);
    return this.requirements.approveRelaxation(actor, id, body.note);
  }

  @Post('worker-requirements/relaxations/:id/reject')
  @RequirePermissions(APPROVE)
  @RequireRecentMfa()
  reject(
    @Actor() actor: ActionContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(Decision)) body: z.infer<typeof Decision>,
  ) {
    assertCityScope(principal, APPROVE, null);
    return this.requirements.rejectRelaxation(actor, id, body.note);
  }

  @Post('worker-requirements/relaxations/:id/withdraw')
  @RequirePermissions(MANAGE)
  @RequireRecentMfa()
  withdraw(
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(Decision)) body: z.infer<typeof Decision>,
  ) {
    return this.requirements.withdrawRelaxation(actor, id, body.note);
  }
}
