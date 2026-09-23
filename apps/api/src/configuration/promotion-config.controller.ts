import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import {
  Actor,
  CurrentPrincipal,
  RequirePermissions,
  RequireRecentMfa,
} from '../auth/decorators.js';
import type { Principal } from '../auth/principal.js';
import { NotFoundError } from '../common/errors.js';
import { ZodPipe } from '../common/http/zod.pipe.js';
import type { ActionContext } from '../database/action-context.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { inTransaction } from '../database/transaction.js';
import { assertCityScope } from './scope.js';

const Reason = z.string().trim().min(5).max(500);

const PromotionCreate = z
  .object({
    code: z.string().regex(/^[A-Za-z0-9_-]{3,30}$/),
    description: z.string().trim().min(3).max(300),
    discountType: z.enum(['FLAT', 'PERCENT']),
    value: z.number().int().min(1),
    maxDiscountPaise: z.number().int().min(1).nullable().default(null),
    minOrderPaise: z.number().int().min(0).nullable().default(null),
    validFrom: z.iso.datetime(),
    validTo: z.iso.datetime(),
    maxRedemptions: z.number().int().min(1).nullable().default(null),
    maxRedemptionsPerUser: z.number().int().min(1).default(1),
    firstBookingOnly: z.boolean().default(false),
    /** Empty = every service / every city. */
    serviceIds: z.array(z.uuid()).max(100).default([]),
    cityIds: z.array(z.uuid()).max(100).default([]),
    reason: Reason,
  })
  .strict()
  .refine((p) => p.discountType !== 'PERCENT' || p.value <= 10_000, 'Percent is at most 10000 bp')
  .refine((p) => new Date(p.validTo) > new Date(p.validFrom), 'validTo must be after validFrom');
const PromotionUpdate = z
  .object({
    description: z.string().trim().min(3).max(300).optional(),
    validTo: z.iso.datetime().optional(),
    maxRedemptions: z.number().int().min(1).nullable().optional(),
    maxRedemptionsPerUser: z.number().int().min(1).optional(),
    /** Promotions can be switched off; a new code is created to offer one again. */
    isActive: z.literal(false).optional(),
    reason: Reason,
  })
  .strict();

const PERMISSION = 'promotion.manage';

/**
 * Promotion codes. The code and the discount are what customers were promised and never
 * change (the database refuses it); a promotion can be narrowed, extended or switched off.
 */
@Controller('admin/config/promotions')
@RequirePermissions(PERMISSION)
export class PromotionConfigController {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  @Get()
  async list() {
    const [promotions, services, cities, redemptions] = await Promise.all([
      this.db.selectFrom('promotion').selectAll().orderBy('valid_from', 'desc').execute(),
      this.db.selectFrom('promotion_service').selectAll().execute(),
      this.db.selectFrom('promotion_city').selectAll().execute(),
      this.db
        .selectFrom('promotion_redemption')
        .select((eb) => ['promotion_id', eb.fn.countAll<number>().as('n')])
        .where('status', '<>', 'RELEASED')
        .groupBy('promotion_id')
        .execute(),
    ]);
    return promotions.map((p) => ({
      ...p,
      serviceIds: services.filter((s) => s.promotion_id === p.id).map((s) => s.service_id),
      cityIds: cities.filter((c) => c.promotion_id === p.id).map((c) => c.city_id),
      redemptions: redemptions.find((r) => r.promotion_id === p.id)?.n ?? 0,
    }));
  }

  @Post()
  @RequireRecentMfa()
  create(
    @Actor() actor: ActionContext,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(PromotionCreate)) body: z.infer<typeof PromotionCreate>,
  ) {
    if (body.cityIds.length === 0) assertCityScope(principal, PERMISSION, null);
    for (const cityId of body.cityIds) assertCityScope(principal, PERMISSION, cityId);
    return inTransaction(this.db, { ...actor, reason: body.reason }, async (tx) => {
      const promotion = await tx
        .insertInto('promotion')
        .values({
          code: body.code,
          description: body.description,
          discount_type: body.discountType,
          value: body.value,
          max_discount_paise: body.maxDiscountPaise,
          min_order_paise: body.minOrderPaise,
          valid_from: new Date(body.validFrom),
          valid_to: new Date(body.validTo),
          max_redemptions: body.maxRedemptions,
          max_redemptions_per_user: body.maxRedemptionsPerUser,
          first_booking_only: body.firstBookingOnly,
          created_by: actor.actorUserId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      if (body.serviceIds.length > 0) {
        await tx
          .insertInto('promotion_service')
          .values(
            body.serviceIds.map((serviceId) => ({
              promotion_id: promotion.id,
              service_id: serviceId,
            })),
          )
          .execute();
      }
      if (body.cityIds.length > 0) {
        await tx
          .insertInto('promotion_city')
          .values(body.cityIds.map((cityId) => ({ promotion_id: promotion.id, city_id: cityId })))
          .execute();
      }
      return promotion;
    });
  }

  @Patch(':id')
  @RequireRecentMfa()
  async update(
    @Actor() actor: ActionContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(PromotionUpdate)) body: z.infer<typeof PromotionUpdate>,
  ) {
    const cities = await this.db
      .selectFrom('promotion_city')
      .select('city_id')
      .where('promotion_id', '=', id)
      .execute();
    if (cities.length === 0) assertCityScope(principal, PERMISSION, null);
    for (const { city_id } of cities) assertCityScope(principal, PERMISSION, city_id);
    return inTransaction(this.db, { ...actor, reason: body.reason }, async (tx) => {
      const row = await tx
        .updateTable('promotion')
        .set({
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.validTo !== undefined ? { valid_to: new Date(body.validTo) } : {}),
          ...(body.maxRedemptions !== undefined ? { max_redemptions: body.maxRedemptions } : {}),
          ...(body.maxRedemptionsPerUser !== undefined
            ? { max_redemptions_per_user: body.maxRedemptionsPerUser }
            : {}),
          ...(body.isActive === false ? { is_active: false } : {}),
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();
      if (!row) throw new NotFoundError('Promotion', id);
      return row;
    });
  }
}
