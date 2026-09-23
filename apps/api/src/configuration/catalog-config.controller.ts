import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { Actor, CurrentPrincipal, ForApp, RequirePermissions } from '../auth/decorators.js';
import type { Principal } from '../auth/principal.js';
import { BusinessRuleError, NotFoundError } from '../common/errors.js';
import { ZodPipe } from '../common/http/zod.pipe.js';
import type { ActionContext } from '../database/action-context.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { inTransaction, type Tx } from '../database/transaction.js';
import { assertCityScope, cityOfZone } from './scope.js';

const Reason = z.string().trim().min(5).max(500);
const Code = z.string().regex(/^[A-Z0-9_]{2,40}$/);
const Text = z.string().trim().min(2).max(120);
const LongText = z.string().trim().max(2000).nullable();

const CategoryCreate = z
  .object({
    code: Code,
    name: Text,
    description: LongText.default(null),
    parentId: z.uuid().nullable().default(null),
    sortOrder: z.number().int().default(0),
    reason: Reason,
  })
  .strict();
const CategoryUpdate = z
  .object({
    name: Text.optional(),
    description: LongText.optional(),
    sortOrder: z.number().int().optional(),
    isActive: z.boolean().optional(),
    reason: Reason,
  })
  .strict();

const ServiceFields = {
  name: Text,
  description: LongText,
  durationMinutes: z.number().int().min(5).max(1440),
  bufferBeforeMinutes: z.number().int().min(0).max(240),
  bufferAfterMinutes: z.number().int().min(0).max(240),
  workersRequired: z.number().int().min(1).max(20),
  supportsInstant: z.boolean(),
  supportsScheduled: z.boolean(),
  minLeadTimeMinutes: z
    .number()
    .int()
    .min(0)
    .max(7 * 24 * 60),
  maxAdvanceDays: z.number().int().min(0).max(365),
  paymentHoldMinutes: z.number().int().min(1).max(120),
  offerTimeoutSeconds: z.number().int().min(30).max(3600),
  requiresStartCode: z.boolean(),
  sortOrder: z.number().int(),
};
const ServiceCreate = z
  .object({
    categoryId: z.uuid(),
    code: Code,
    fulfilmentType: z
      .enum(['WORKER_VISIT', 'CREW_VISIT', 'SURVEY_THEN_VISIT', 'PARTNER_COORDINATION'])
      .default('WORKER_VISIT'),
    ...ServiceFields,
    description: LongText.default(null),
    reason: Reason,
  })
  .strict()
  .refine((s) => s.supportsInstant || s.supportsScheduled, 'Offer instant, scheduled or both');
const ServiceUpdate = z
  .object({
    ...Object.fromEntries(Object.entries(ServiceFields).map(([k, v]) => [k, v.optional()])),
    isActive: z.boolean().optional(),
    reason: Reason,
  })
  .strict();
const OptionCreate = z
  .object({
    code: z.string().regex(/^[A-Z0-9_]{1,40}$/),
    name: Text,
    description: LongText.default(null),
    durationMinutes: z.number().int().min(5).max(1440).nullable().default(null),
    isDefault: z.boolean().default(false),
    sortOrder: z.number().int().default(0),
    reason: Reason,
  })
  .strict();
const OptionUpdate = z
  .object({
    name: Text.optional(),
    description: LongText.optional(),
    isDefault: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
    isActive: z.boolean().optional(),
    reason: Reason,
  })
  .strict();
const TaskCreate = z
  .object({
    code: Code,
    name: Text,
    description: LongText.default(null),
    isDefaultSelected: z.boolean().default(true),
    sortOrder: z.number().int().default(0),
    reason: Reason,
  })
  .strict();
const TaskUpdate = z
  .object({
    name: Text.optional(),
    description: LongText.optional(),
    isDefaultSelected: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
    isActive: z.boolean().optional(),
    reason: Reason,
  })
  .strict();
const ServiceZoneBody = z
  .object({
    isActive: z.boolean(),
    notes: z.string().trim().max(500).nullable().default(null),
    reason: Reason,
  })
  .strict();

const COLUMN: Record<string, string> = {
  name: 'name',
  description: 'description',
  durationMinutes: 'duration_minutes',
  bufferBeforeMinutes: 'buffer_before_minutes',
  bufferAfterMinutes: 'buffer_after_minutes',
  workersRequired: 'workers_required',
  supportsInstant: 'supports_instant',
  supportsScheduled: 'supports_scheduled',
  minLeadTimeMinutes: 'min_lead_time_minutes',
  maxAdvanceDays: 'max_advance_days',
  paymentHoldMinutes: 'payment_hold_minutes',
  offerTimeoutSeconds: 'offer_timeout_seconds',
  requiresStartCode: 'requires_start_code',
  sortOrder: 'sort_order',
  isActive: 'is_active',
  isDefault: 'is_default',
  isDefaultSelected: 'is_default_selected',
};

/** Maps camelCase API fields to columns, ignoring `reason` and absent fields. */
function columns(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === 'reason' || value === undefined) continue;
    const column = COLUMN[key];
    if (column) out[column] = value;
  }
  return out;
}

const PERMISSION = 'catalog.manage';

/**
 * The service catalogue: categories, services (HH60 and future ones), options, tasks and
 * which zones offer each service. Deactivation instead of deletion; every change carries
 * a reason and is audited. A service can only go live once it has a current price and a
 * current worker payout, so nothing is ever offered unpriced or unpaid.
 */
@Controller('admin/config')
@ForApp('ADMIN_WEB')
@RequirePermissions(PERMISSION)
export class CatalogConfigController {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  @Get('categories')
  categories() {
    return this.db.selectFrom('service_category').selectAll().orderBy('sort_order').execute();
  }

  @Post('categories')
  createCategory(
    @Actor() actor: ActionContext,
    @Body(new ZodPipe(CategoryCreate)) body: z.infer<typeof CategoryCreate>,
  ) {
    return inTransaction(this.db, { ...actor, reason: body.reason }, (tx) =>
      tx
        .insertInto('service_category')
        .values({
          code: body.code,
          name: body.name,
          description: body.description,
          parent_id: body.parentId,
          sort_order: body.sortOrder,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  @Patch('categories/:id')
  updateCategory(
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(CategoryUpdate)) body: z.infer<typeof CategoryUpdate>,
  ) {
    return this.update('service_category', id, body, actor);
  }

  @Get('services')
  async services() {
    const [services, options, tasks, zones] = await Promise.all([
      this.db.selectFrom('service').selectAll().orderBy('sort_order').execute(),
      this.db.selectFrom('service_option').selectAll().orderBy('sort_order').execute(),
      this.db.selectFrom('service_task').selectAll().orderBy('sort_order').execute(),
      this.db.selectFrom('service_zone').selectAll().execute(),
    ]);
    return services.map((s) => ({
      ...s,
      options: options.filter((o) => o.service_id === s.id),
      tasks: tasks.filter((t) => t.service_id === s.id),
      zones: zones.filter((z) => z.service_id === s.id),
    }));
  }

  @Post('services')
  createService(
    @Actor() actor: ActionContext,
    @Body(new ZodPipe(ServiceCreate)) body: z.infer<typeof ServiceCreate>,
  ) {
    return inTransaction(this.db, { ...actor, reason: body.reason }, (tx) =>
      tx
        .insertInto('service')
        .values({
          category_id: body.categoryId,
          code: body.code,
          fulfilment_type: body.fulfilmentType,
          name: body.name,
          description: body.description,
          duration_minutes: body.durationMinutes,
          buffer_before_minutes: body.bufferBeforeMinutes,
          buffer_after_minutes: body.bufferAfterMinutes,
          workers_required: body.workersRequired,
          supports_instant: body.supportsInstant,
          supports_scheduled: body.supportsScheduled,
          min_lead_time_minutes: body.minLeadTimeMinutes,
          max_advance_days: body.maxAdvanceDays,
          payment_hold_minutes: body.paymentHoldMinutes,
          offer_timeout_seconds: body.offerTimeoutSeconds,
          requires_start_code: body.requiresStartCode,
          sort_order: body.sortOrder,
          // New services always start switched off.
          is_active: false,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  @Patch('services/:id')
  async updateService(
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ServiceUpdate)) body: z.infer<typeof ServiceUpdate>,
  ) {
    return inTransaction(this.db, { ...actor, reason: body.reason }, async (tx) => {
      if (body['isActive'] === true) await this.assertReadyToOffer(tx, id);
      const row = await tx
        .updateTable('service')
        .set(columns(body) as Record<string, never>)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();
      if (!row) throw new NotFoundError('Service', id);
      if (!row.supports_instant && !row.supports_scheduled) {
        throw new BusinessRuleError('SERVICE_NOT_BOOKABLE', 'Offer instant, scheduled or both');
      }
      return row;
    });
  }

  @Post('services/:id/options')
  createOption(
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) serviceId: string,
    @Body(new ZodPipe(OptionCreate)) body: z.infer<typeof OptionCreate>,
  ) {
    return inTransaction(this.db, { ...actor, reason: body.reason }, (tx) =>
      tx
        .insertInto('service_option')
        .values({
          service_id: serviceId,
          code: body.code,
          name: body.name,
          description: body.description,
          duration_minutes: body.durationMinutes,
          is_default: body.isDefault,
          sort_order: body.sortOrder,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  @Patch('options/:id')
  updateOption(
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(OptionUpdate)) body: z.infer<typeof OptionUpdate>,
  ) {
    return this.update('service_option', id, body, actor);
  }

  @Post('services/:id/tasks')
  createTask(
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) serviceId: string,
    @Body(new ZodPipe(TaskCreate)) body: z.infer<typeof TaskCreate>,
  ) {
    return inTransaction(this.db, { ...actor, reason: body.reason }, (tx) =>
      tx
        .insertInto('service_task')
        .values({
          service_id: serviceId,
          code: body.code,
          name: body.name,
          description: body.description,
          is_default_selected: body.isDefaultSelected,
          sort_order: body.sortOrder,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  @Patch('tasks/:id')
  updateTask(
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(TaskUpdate)) body: z.infer<typeof TaskUpdate>,
  ) {
    return this.update('service_task', id, body, actor);
  }

  /** Offers (or withdraws) a service in a zone. */
  @Put('services/:id/zones/:zoneId')
  async setServiceZone(
    @Actor() actor: ActionContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) serviceId: string,
    @Param('zoneId', ParseUUIDPipe) zoneId: string,
    @Body(new ZodPipe(ServiceZoneBody)) body: z.infer<typeof ServiceZoneBody>,
  ) {
    assertCityScope(principal, PERMISSION, await cityOfZone(this.db, zoneId));
    return inTransaction(this.db, { ...actor, reason: body.reason }, (tx) =>
      tx
        .insertInto('service_zone')
        .values({
          service_id: serviceId,
          zone_id: zoneId,
          is_active: body.isActive,
          notes: body.notes,
          updated_by: actor.actorUserId,
        })
        .onConflict((oc) =>
          oc.columns(['service_id', 'zone_id']).doUpdateSet({
            is_active: body.isActive,
            notes: body.notes,
            updated_by: actor.actorUserId,
          }),
        )
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  private async assertReadyToOffer(tx: Tx, serviceId: string): Promise<void> {
    const current = (table: 'price_rule' | 'payout_rule') =>
      tx
        .selectFrom(table)
        .select('id')
        .where('service_id', '=', serviceId)
        .where('is_active', '=', true)
        .where('valid_from', '<=', sql<Date>`now()`)
        .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>', sql<Date>`now()`)]))
        .executeTakeFirst();
    const missing = [
      ...((await current('price_rule')) ? [] : ['a current price rule']),
      ...((await current('payout_rule')) ? [] : ['a current worker payout rule']),
    ];
    if (missing.length > 0) {
      throw new BusinessRuleError(
        'SERVICE_NOT_READY',
        `The service cannot go live without ${missing.join(' and ')}`,
        { missing },
      );
    }
  }

  private update(
    table: 'service_category' | 'service_option' | 'service_task',
    id: string,
    body: Record<string, unknown>,
    actor: ActionContext,
  ) {
    return inTransaction(this.db, { ...actor, reason: String(body['reason']) }, async (tx) => {
      const row = await tx
        .updateTable(table)
        .set(columns(body) as Record<string, never>)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();
      if (!row) throw new NotFoundError('Record', id);
      return row;
    });
  }
}
