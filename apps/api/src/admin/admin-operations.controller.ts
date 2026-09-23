import { IdempotencyKey, requestHash } from '../common/http/idempotency.js';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import {
  Actor,
  CurrentPrincipal,
  ForApp,
  RequirePermissions,
  RequireRecentMfa,
} from '../auth/decorators.js';
import type { Principal } from '../auth/principal.js';
import { NotFoundError, ValidationError } from '../common/errors.js';
import { ZodPipe } from '../common/http/zod.pipe.js';
import type { ActionContext } from '../database/action-context.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { inTransaction } from '../database/transaction.js';
import { RefundService } from '../payments/refund.service.js';
import { SAFETY_CATEGORIES, SafetyService } from '../support/safety.service.js';
import { SUPPORT_STATUSES, SupportService } from '../support/support.service.js';
import { SystemStatusService } from './system-status.service.js';
import { SETTING_SCHEMAS, isSettingKey } from '../configuration/settings-registry.js';

const reason = z.string().trim().min(5, 'Give a meaningful reason').max(500);
const ReasonBody = z.object({ reason }).strict();
const LimitQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

const RefundQuery = LimitQuery.extend({
  status: z
    .enum(['REQUESTED', 'APPROVED', 'REJECTED', 'PROCESSING', 'PROCESSED', 'FAILED'])
    .optional(),
});
const RefundRequestBody = z
  .object({
    bookingId: z.uuid(),
    amountPaise: z.number().int().positive().nullable().default(null),
    reasonCode: z.enum([
      'SERVICE_ISSUE',
      'WORKER_NO_SHOW',
      'COMPANY_CANCELLED',
      'GOODWILL',
      'OTHER',
    ]),
    reason,
  })
  .strict();
const DecisionBody = z
  .object({ note: z.string().trim().max(500).nullable().default(null) })
  .strict();

const CaseQuery = LimitQuery.extend({ status: z.enum(SUPPORT_STATUSES).optional() });
const CaseActionBody = z
  .object({
    note: z.string().trim().max(5000).nullable().default(null),
    status: z.enum(SUPPORT_STATUSES).nullable().default(null),
    ownerUserId: z.uuid().nullable().default(null),
    resolution: z.string().trim().max(5000).nullable().default(null),
    internal: z.boolean().default(true),
  })
  .strict();

const IncidentBody = z
  .object({
    bookingId: z.uuid().nullable().default(null),
    category: z.enum(SAFETY_CATEGORIES),
    severity: z.enum(['CRITICAL', 'HIGH', 'ROUTINE']),
    summary: z.string().trim().min(5).max(5000),
    locationText: z.string().trim().max(500).nullable().default(null),
  })
  .strict();
const IncidentActionBody = z
  .object({
    note: z.string().trim().min(3).max(5000),
    status: z.enum(['CONTAINED', 'UNDER_REVIEW', 'CLOSED']).nullable().default(null),
    takeCommand: z.boolean().default(false),
  })
  .strict();

const OnCallBody = z
  .object({
    userId: z.uuid(),
    level: z.number().int().min(1).max(3),
    phone: z
      .string()
      .regex(/^\+91[6-9]\d{9}$/)
      .nullable()
      .default(null),
    reason: z.string().trim().min(5).max(500),
  })
  .strict();
const ReasonOnly = z.object({ reason: z.string().trim().min(5).max(500) }).strict();

const AuditQuery = LimitQuery.extend({
  entityType: z
    .string()
    .regex(/^[a-z_]+$/)
    .optional(),
  entityId: z.string().max(100).optional(),
  actorUserId: z.uuid().optional(),
});
const SettingBody = z
  .object({
    value: z.record(z.string(), z.unknown()),
    description: z.string().trim().min(3).max(500),
    reason,
  })
  .strict();
const SETTING_KEY = /^[a-z_]+(\.[a-z_]+)*$/;

/** Refunds, support cases, safety incidents, audit log and business settings. */
@Controller('admin')
@ForApp('ADMIN_WEB')
export class AdminOperationsController {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly refunds: RefundService,
    private readonly support: SupportService,
    private readonly safety: SafetyService,
    private readonly system: SystemStatusService,
  ) {}

  // ---- The signed-in staff member ----

  /**
   * Who is signed in and what they may do, so the admin panel shows only permitted
   * screens and actions. The API still checks every request; this is for display.
   */
  @Get('me')
  async me(@CurrentPrincipal() principal: Principal) {
    const user = await this.db
      .selectFrom('app_user')
      .select(['id', 'email', 'full_name', 'preferred_locale'])
      .where('id', '=', principal.userId)
      .executeTakeFirstOrThrow();
    return {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      locale: user.preferred_locale,
      roles: principal.roles,
      permissions: Object.fromEntries(
        [...principal.permissions].map(([code, grant]) => [
          code,
          grant === 'ALL' ? 'ALL' : [...grant].sort(),
        ]),
      ),
      mfaVerifiedAt: principal.mfaVerifiedAt?.toISOString() ?? null,
    };
  }

  // ---- Refunds ----

  @Get('refunds')
  @RequirePermissions('refund.read')
  listRefunds(@Query(new ZodPipe(RefundQuery)) query: z.infer<typeof RefundQuery>) {
    return this.db
      .selectFrom('refund as r')
      .innerJoin('booking as b', 'b.id', 'r.booking_id')
      .select([
        'r.id',
        'b.booking_code',
        'r.amount_paise',
        'r.status',
        'r.reason_code',
        'r.reason_text',
        'r.requested_by',
        'r.decided_by',
        'r.decision_policy',
        'r.created_at',
      ])
      .$if(query.status !== undefined, (qb) =>
        qb.where('r.status', '=', query.status ?? 'REQUESTED'),
      )
      .orderBy('r.created_at', 'desc')
      .limit(query.limit)
      .execute();
  }

  @Post('refunds')
  @RequirePermissions('refund.request')
  async requestRefund(
    @Actor() actor: ActionContext,
    @Body(new ZodPipe(RefundRequestBody)) body: z.infer<typeof RefundRequestBody>,
  ) {
    const context = { ...actor, reason: body.reason };
    const id = await inTransaction(this.db, context, (tx) =>
      this.refunds.requestInTx(tx, context, {
        bookingId: body.bookingId,
        amountPaise: body.amountPaise,
        reasonCode: body.reasonCode,
        reasonText: body.reason,
      }),
    );
    if (!id) throw new NotFoundError('Refundable payment', body.bookingId);
    return { refundId: id, status: 'REQUESTED' };
  }

  /** Approval sends money back: finance only, a different person than the requester, fresh MFA. */
  @Post('refunds/:id/approve')
  @HttpCode(204)
  @RequirePermissions('refund.approve')
  @RequireRecentMfa()
  async approveRefund(
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(DecisionBody)) body: z.infer<typeof DecisionBody>,
  ) {
    await this.refunds.approve(id, actor, body.note);
  }

  @Post('refunds/:id/reject')
  @HttpCode(204)
  @RequirePermissions('refund.approve')
  async rejectRefund(
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>,
  ) {
    await this.refunds.reject(id, actor, body.reason);
  }

  // ---- Support ----

  @Get('support-cases')
  @RequirePermissions('support.read')
  cases(@Query(new ZodPipe(CaseQuery)) query: z.infer<typeof CaseQuery>) {
    return this.support.list({ status: query.status ?? null, limit: query.limit });
  }

  @Get('support-cases/:id')
  @RequirePermissions('support.read')
  supportCase(@Param('id', ParseUUIDPipe) id: string) {
    return this.support.detail(id);
  }

  @Post('support-cases/:id/actions')
  @RequirePermissions('support.manage')
  actOnCase(
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(CaseActionBody)) body: z.infer<typeof CaseActionBody>,
  ) {
    return this.support.act(actor, id, body);
  }

  // ---- Safety ----

  @Post('safety-incidents')
  @RequirePermissions('safety.escalate')
  escalate(
    @Actor() actor: ActionContext,
    @IdempotencyKey() key: string,
    @Body(new ZodPipe(IncidentBody)) body: z.infer<typeof IncidentBody>,
  ) {
    return this.safety.raise(
      actor,
      'STAFF',
      { ...body, lat: null, lng: null },
      { key, hash: requestHash(body) },
    );
  }

  @Get('safety-incidents')
  @RequirePermissions('safety.read')
  incidents(@Query(new ZodPipe(LimitQuery)) query: z.infer<typeof LimitQuery>) {
    return this.safety.list({ openOnly: true, limit: query.limit });
  }

  @Get('safety-incidents/:id')
  @RequirePermissions('safety.read')
  incident(@Param('id', ParseUUIDPipe) id: string) {
    return this.safety.detail(id);
  }

  /** "I have it": stops paging. Safe to repeat. */
  @Post('safety-incidents/:id/acknowledge')
  @HttpCode(200)
  @RequirePermissions('safety.manage')
  acknowledgeIncident(@Actor() actor: ActionContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.safety.acknowledge(actor, id);
  }

  @Get('safety/on-call')
  @RequirePermissions('safety.read')
  onCall() {
    return this.safety.onCall();
  }

  @Post('safety/on-call')
  @RequirePermissions('safety.manage')
  @RequireRecentMfa()
  addOnCall(
    @Actor() actor: ActionContext,
    @Body(new ZodPipe(OnCallBody)) body: z.infer<typeof OnCallBody>,
  ) {
    return this.safety.addOnCall(actor, body);
  }

  @Post('safety/on-call/:id/remove')
  @HttpCode(200)
  @RequirePermissions('safety.manage')
  @RequireRecentMfa()
  removeOnCall(
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ReasonOnly)) body: z.infer<typeof ReasonOnly>,
  ) {
    return this.safety.removeOnCall(actor, id, body.reason);
  }

  @Post('safety-incidents/:id/actions')
  @RequirePermissions('safety.manage')
  actOnIncident(
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(IncidentActionBody)) body: z.infer<typeof IncidentActionBody>,
  ) {
    return this.safety.act(actor, id, body);
  }

  // ---- Audit & settings ----

  @Get('system/status')
  @RequirePermissions('system.read')
  systemStatus() {
    return this.system.status();
  }

  @Get('audit')
  @RequirePermissions('audit.read')
  audit(@Query(new ZodPipe(AuditQuery)) query: z.infer<typeof AuditQuery>) {
    return this.db
      .selectFrom('audit_log')
      .selectAll()
      .$if(query.entityType !== undefined, (qb) =>
        qb.where('entity_type', '=', query.entityType ?? ''),
      )
      .$if(query.entityId !== undefined, (qb) => qb.where('entity_id', '=', query.entityId ?? ''))
      .$if(query.actorUserId !== undefined, (qb) =>
        qb.where('actor_user_id', '=', query.actorUserId ?? ''),
      )
      .orderBy('id', 'desc')
      .limit(query.limit)
      .execute();
  }

  @Get('settings')
  @RequirePermissions('settings.manage')
  settings() {
    return this.db.selectFrom('business_setting').selectAll().orderBy('key').execute();
  }

  @Put('settings/:key')
  @HttpCode(204)
  @RequirePermissions('settings.manage')
  @RequireRecentMfa()
  async setting(
    @Actor() actor: ActionContext,
    @Param('key') key: string,
    @Body(new ZodPipe(SettingBody)) body: z.infer<typeof SettingBody>,
  ) {
    if (!SETTING_KEY.test(key) || !isSettingKey(key)) throw new NotFoundError('Setting', key);
    const parsed = SETTING_SCHEMAS[key].safeParse(body.value);
    if (!parsed.success) {
      throw new ValidationError('SETTING_INVALID', z.prettifyError(parsed.error));
    }
    await inTransaction(this.db, { ...actor, reason: body.reason }, (tx) =>
      tx
        .insertInto('business_setting')
        .values({
          key,
          value: JSON.stringify(parsed.data),
          description: body.description,
          updated_by: actor.actorUserId,
        })
        .onConflict((oc) =>
          oc.column('key').doUpdateSet({
            value: JSON.stringify(parsed.data),
            description: body.description,
            updated_by: actor.actorUserId,
          }),
        )
        .execute(),
    );
  }
}
