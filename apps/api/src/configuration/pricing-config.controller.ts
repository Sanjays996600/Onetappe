import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { selectRule, type IsoWeekday } from '@onetappe/domain';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import {
  Actor,
  CurrentPrincipal,
  ForApp,
  RequirePermissions,
  RequireRecentMfa,
} from '../auth/decorators.js';
import type { Principal } from '../auth/principal.js';
import { BusinessRuleError, NotFoundError, ValidationError } from '../common/errors.js';
import { ZodPipe } from '../common/http/zod.pipe.js';
import type { ActionContext } from '../database/action-context.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { inTransaction } from '../database/transaction.js';
import { PricingService } from '../pricing/pricing.service.js';
import { assertCityScope, ruleCity } from './scope.js';

const Reason = z.string().trim().min(5).max(500);
const Paise = z.number().int().min(0).max(100_000_000);
/** Rules start now or later: past prices and payouts are never rewritten. */
const FutureInstant = z.iso
  .datetime()
  .refine((v) => new Date(v).getTime() >= Date.now() - 60_000, 'Must be now or in the future');

const Matching = {
  serviceId: z.uuid(),
  serviceOptionId: z.uuid().nullable().default(null),
  cityId: z.uuid().nullable().default(null),
  zoneId: z.uuid().nullable().default(null),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).nullable().default(null),
  startMinute: z.number().int().min(0).max(1439).nullable().default(null),
  endMinute: z.number().int().min(0).max(1439).nullable().default(null),
  priority: z.number().int().min(-1000).max(1000).default(0),
  validFrom: FutureInstant,
  validTo: FutureInstant.nullable().default(null),
};
const timeWindowValid = (r: { startMinute: number | null; endMinute: number | null }) =>
  (r.startMinute === null) === (r.endMinute === null);

const PriceRuleCreate = z
  .object({
    ...Matching,
    baseAmountPaise: Paise,
    taxRateCode: z.string().regex(/^[A-Z0-9_]{2,20}$/),
    notes: z.string().trim().max(500).nullable().default(null),
    reason: Reason,
  })
  .strict()
  .refine(timeWindowValid, 'Give both startMinute and endMinute, or neither');
const PayoutRuleCreate = z
  .object({
    ...Matching,
    basePayoutPaise: Paise,
    travelAllowancePaise: Paise.default(0),
    reason: Reason,
  })
  .strict()
  .refine(timeWindowValid, 'Give both startMinute and endMinute, or neither');
const ChargeRuleCreate = z
  .object({
    code: z.string().regex(/^[A-Z0-9_]{2,40}$/),
    label: z.string().trim().min(2).max(80),
    serviceId: z.uuid().nullable().default(null),
    cityId: z.uuid().nullable().default(null),
    zoneId: z.uuid().nullable().default(null),
    bookingType: z.enum(['INSTANT', 'SCHEDULED']).nullable().default(null),
    weekdays: Matching.weekdays,
    startMinute: Matching.startMinute,
    endMinute: Matching.endMinute,
    kind: z.enum(['FIXED', 'PERCENT_OF_BASE']),
    value: z.number().int().min(0).max(10_000_000),
    taxable: z.boolean().default(true),
    validFrom: FutureInstant,
    validTo: FutureInstant.nullable().default(null),
    reason: Reason,
  })
  .strict()
  .refine(timeWindowValid, 'Give both startMinute and endMinute, or neither')
  .refine((c) => c.kind !== 'PERCENT_OF_BASE' || c.value <= 10_000, 'Percent is at most 10000 bp');
const TaxRateCreate = z
  .object({
    code: z.string().regex(/^[A-Z0-9_]{2,20}$/),
    name: z.string().trim().min(2).max(80),
    rateBp: z.number().int().min(0).max(10_000),
    effectiveFrom: FutureInstant,
    reason: Reason,
  })
  .strict();
const CancellationRuleCreate = z
  .object({
    serviceId: z.uuid().nullable().default(null),
    minMinutesBeforeStart: z
      .number()
      .int()
      .min(0)
      .max(60 * 24 * 30),
    refundBp: z.number().int().min(0).max(10_000),
    description: z.string().trim().min(5).max(300),
    validFrom: FutureInstant,
    reason: Reason,
  })
  .strict();
const EndBody = z.object({ at: FutureInstant.optional(), reason: Reason }).strict();
const ReplacePrice = z
  .object({ baseAmountPaise: Paise, effectiveFrom: FutureInstant, reason: Reason })
  .strict();
const ReplacePayout = z
  .object({
    basePayoutPaise: Paise,
    travelAllowancePaise: Paise,
    effectiveFrom: FutureInstant,
    reason: Reason,
  })
  .strict();
const PreviewBody = z
  .object({
    serviceId: z.uuid(),
    serviceOptionId: z.uuid().nullable().default(null),
    zoneId: z.uuid(),
    startAt: z.iso.datetime(),
    bookingType: z.enum(['INSTANT', 'SCHEDULED']).default('SCHEDULED'),
    promoCode: z.string().max(30).nullable().default(null),
  })
  .strict();
const ListQuery = z.object({ serviceId: z.uuid().optional() });

const PERMISSION = 'pricing.manage';

/**
 * Prices, extra charges, taxes, worker payouts and cancellation/refund rules. Money rules
 * are never edited: they are ended and replaced (the database refuses any rewrite), so
 * every past quote and payout can be explained from the rules in force at the time.
 * Writes need pricing.manage, a reason and a recent authenticator check.
 */
@Controller('admin/config')
@ForApp('ADMIN_WEB')
@RequirePermissions(PERMISSION)
export class PricingConfigController {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly pricing: PricingService,
  ) {}

  // ---- Reading ----

  @Get('tax-rates')
  taxRates() {
    return this.db
      .selectFrom('tax_rate')
      .selectAll()
      .orderBy('code')
      .orderBy('effective_from')
      .execute();
  }

  @Get('price-rules')
  priceRules(@Query(new ZodPipe(ListQuery)) query: z.infer<typeof ListQuery>) {
    return this.db
      .selectFrom('price_rule')
      .selectAll()
      .$if(query.serviceId !== undefined, (qb) =>
        qb.where('service_id', '=', query.serviceId ?? ''),
      )
      .orderBy('valid_from', 'desc')
      .execute();
  }

  @Get('charge-rules')
  chargeRules() {
    return this.db.selectFrom('charge_rule').selectAll().orderBy('valid_from', 'desc').execute();
  }

  @Get('payout-rules')
  payoutRules(@Query(new ZodPipe(ListQuery)) query: z.infer<typeof ListQuery>) {
    return this.db
      .selectFrom('payout_rule')
      .selectAll()
      .$if(query.serviceId !== undefined, (qb) =>
        qb.where('service_id', '=', query.serviceId ?? ''),
      )
      .orderBy('valid_from', 'desc')
      .execute();
  }

  @Get('cancellation-rules')
  cancellationRules() {
    return this.db
      .selectFrom('cancellation_rule')
      .selectAll()
      .orderBy('min_minutes_before_start', 'desc')
      .execute();
  }

  // ---- Creating ----

  @Post('tax-rates')
  @RequireRecentMfa()
  createTaxRate(
    @Actor() actor: ActionContext,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(TaxRateCreate)) body: z.infer<typeof TaxRateCreate>,
  ) {
    assertCityScope(principal, PERMISSION, null);
    return inTransaction(this.db, { ...actor, reason: body.reason }, (tx) =>
      tx
        .insertInto('tax_rate')
        .values({
          code: body.code,
          name: body.name,
          rate_bp: body.rateBp,
          effective_from: new Date(body.effectiveFrom),
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  @Post('price-rules')
  @RequireRecentMfa()
  async createPriceRule(
    @Actor() actor: ActionContext,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(PriceRuleCreate)) body: z.infer<typeof PriceRuleCreate>,
  ) {
    assertCityScope(principal, PERMISSION, await ruleCity(this.db, body));
    return inTransaction(this.db, { ...actor, reason: body.reason }, async (tx) => {
      const tax = await tx
        .selectFrom('tax_rate')
        .select('id')
        .where('code', '=', body.taxRateCode)
        .executeTakeFirst();
      if (!tax) throw new NotFoundError('Tax rate', body.taxRateCode);
      return tx
        .insertInto('price_rule')
        .values({
          service_id: body.serviceId,
          service_option_id: body.serviceOptionId,
          city_id: body.cityId,
          zone_id: body.zoneId,
          weekdays: body.weekdays,
          start_minute: body.startMinute,
          end_minute: body.endMinute,
          base_amount_paise: body.baseAmountPaise,
          tax_rate_code: body.taxRateCode,
          priority: body.priority,
          valid_from: new Date(body.validFrom),
          valid_to: body.validTo ? new Date(body.validTo) : null,
          notes: body.notes,
          created_by: actor.actorUserId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  @Post('charge-rules')
  @RequireRecentMfa()
  async createChargeRule(
    @Actor() actor: ActionContext,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(ChargeRuleCreate)) body: z.infer<typeof ChargeRuleCreate>,
  ) {
    assertCityScope(principal, PERMISSION, await ruleCity(this.db, body));
    return inTransaction(this.db, { ...actor, reason: body.reason }, (tx) =>
      tx
        .insertInto('charge_rule')
        .values({
          code: body.code,
          label: body.label,
          service_id: body.serviceId,
          city_id: body.cityId,
          zone_id: body.zoneId,
          booking_type: body.bookingType,
          weekdays: body.weekdays,
          start_minute: body.startMinute,
          end_minute: body.endMinute,
          kind: body.kind,
          value: body.value,
          taxable: body.taxable,
          valid_from: new Date(body.validFrom),
          valid_to: body.validTo ? new Date(body.validTo) : null,
          created_by: actor.actorUserId,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  @Post('payout-rules')
  @RequireRecentMfa()
  async createPayoutRule(
    @Actor() actor: ActionContext,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(PayoutRuleCreate)) body: z.infer<typeof PayoutRuleCreate>,
  ) {
    assertCityScope(principal, PERMISSION, await ruleCity(this.db, body));
    return inTransaction(this.db, { ...actor, reason: body.reason }, (tx) =>
      tx
        .insertInto('payout_rule')
        .values({
          service_id: body.serviceId,
          service_option_id: body.serviceOptionId,
          city_id: body.cityId,
          zone_id: body.zoneId,
          weekdays: body.weekdays,
          start_minute: body.startMinute,
          end_minute: body.endMinute,
          base_payout_paise: body.basePayoutPaise,
          travel_allowance_paise: body.travelAllowancePaise,
          priority: body.priority,
          valid_from: new Date(body.validFrom),
          valid_to: body.validTo ? new Date(body.validTo) : null,
          created_by: actor.actorUserId,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  @Post('cancellation-rules')
  @RequireRecentMfa()
  createCancellationRule(
    @Actor() actor: ActionContext,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(CancellationRuleCreate)) body: z.infer<typeof CancellationRuleCreate>,
  ) {
    assertCityScope(principal, PERMISSION, null);
    return inTransaction(this.db, { ...actor, reason: body.reason }, (tx) =>
      tx
        .insertInto('cancellation_rule')
        .values({
          service_id: body.serviceId,
          min_minutes_before_start: body.minMinutesBeforeStart,
          refund_bp: body.refundBp,
          description: body.description,
          valid_from: new Date(body.validFrom),
          created_by: actor.actorUserId,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  // ---- Ending and replacing ----

  @Post(':kind/:id/end')
  @RequireRecentMfa()
  async end(
    @Actor() actor: ActionContext,
    @CurrentPrincipal() principal: Principal,
    @Param('kind') kind: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(EndBody)) body: z.infer<typeof EndBody>,
  ) {
    const at = body.at ? new Date(body.at) : new Date();
    const context = { ...actor, reason: body.reason };
    switch (kind) {
      case 'price-rules':
      case 'payout-rules':
      case 'charge-rules': {
        const table =
          kind === 'price-rules'
            ? 'price_rule'
            : kind === 'payout-rules'
              ? 'payout_rule'
              : 'charge_rule';
        const rule = await this.db
          .selectFrom(table)
          .select(['city_id', 'zone_id'])
          .where('id', '=', id)
          .executeTakeFirst();
        if (!rule) throw new NotFoundError('Rule', id);
        assertCityScope(
          principal,
          PERMISSION,
          await ruleCity(this.db, { cityId: rule.city_id, zoneId: rule.zone_id }),
        );
        return inTransaction(this.db, context, (tx) =>
          tx
            .updateTable(table)
            .set({ valid_to: at })
            .where('id', '=', id)
            .returningAll()
            .executeTakeFirstOrThrow(),
        );
      }
      case 'cancellation-rules':
        assertCityScope(principal, PERMISSION, null);
        return inTransaction(this.db, context, (tx) =>
          tx
            .updateTable('cancellation_rule')
            .set({ valid_to: at })
            .where('id', '=', id)
            .returningAll()
            .executeTakeFirstOrThrow(),
        );
      case 'tax-rates':
        assertCityScope(principal, PERMISSION, null);
        return inTransaction(this.db, context, (tx) =>
          tx
            .updateTable('tax_rate')
            .set({ effective_to: at })
            .where('id', '=', id)
            .returningAll()
            .executeTakeFirstOrThrow(),
        );
      default:
        throw new NotFoundError('Rule type', kind);
    }
  }

  /** A new price from `effectiveFrom`: the current rule ends and a copy with the new amount begins, atomically. */
  @Post('price-rules/:id/replace')
  @RequireRecentMfa()
  async replacePrice(
    @Actor() actor: ActionContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ReplacePrice)) body: z.infer<typeof ReplacePrice>,
  ) {
    const from = new Date(body.effectiveFrom);
    return inTransaction(this.db, { ...actor, reason: body.reason }, async (tx) => {
      const old = await tx
        .selectFrom('price_rule')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!old) throw new NotFoundError('Price rule', id);
      assertCityScope(
        principal,
        PERMISSION,
        await ruleCity(tx, { cityId: old.city_id, zoneId: old.zone_id }),
      );
      assertReplaceable(old, from);
      await tx.updateTable('price_rule').set({ valid_to: from }).where('id', '=', id).execute();
      return tx
        .insertInto('price_rule')
        .values({
          service_id: old.service_id,
          service_option_id: old.service_option_id,
          city_id: old.city_id,
          zone_id: old.zone_id,
          weekdays: old.weekdays,
          start_minute: old.start_minute,
          end_minute: old.end_minute,
          base_amount_paise: body.baseAmountPaise,
          tax_rate_code: old.tax_rate_code,
          priority: old.priority,
          valid_from: from,
          valid_to: old.valid_to,
          notes: `Replaces ${id}`,
          created_by: actor.actorUserId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  @Post('payout-rules/:id/replace')
  @RequireRecentMfa()
  async replacePayout(
    @Actor() actor: ActionContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ReplacePayout)) body: z.infer<typeof ReplacePayout>,
  ) {
    const from = new Date(body.effectiveFrom);
    return inTransaction(this.db, { ...actor, reason: body.reason }, async (tx) => {
      const old = await tx
        .selectFrom('payout_rule')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!old) throw new NotFoundError('Payout rule', id);
      assertCityScope(
        principal,
        PERMISSION,
        await ruleCity(tx, { cityId: old.city_id, zoneId: old.zone_id }),
      );
      assertReplaceable(old, from);
      await tx.updateTable('payout_rule').set({ valid_to: from }).where('id', '=', id).execute();
      return tx
        .insertInto('payout_rule')
        .values({
          service_id: old.service_id,
          service_option_id: old.service_option_id,
          city_id: old.city_id,
          zone_id: old.zone_id,
          weekdays: old.weekdays,
          start_minute: old.start_minute,
          end_minute: old.end_minute,
          base_payout_paise: body.basePayoutPaise,
          travel_allowance_paise: body.travelAllowancePaise,
          priority: old.priority,
          valid_from: from,
          valid_to: old.valid_to,
          created_by: actor.actorUserId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  // ---- Preview ----

  /**
   * What a customer would be quoted, and what the worker would be paid, for a service in
   * a zone at a time — computed by the same engine the apps use. Changes nothing.
   */
  @Post('pricing/preview')
  @HttpCode(200)
  async preview(
    @Actor() actor: ActionContext,
    @Body(new ZodPipe(PreviewBody)) body: z.infer<typeof PreviewBody>,
  ) {
    const zone = await this.db
      .selectFrom('zone as z')
      .innerJoin('city as c', 'c.id', 'z.city_id')
      .select(['z.city_id', 'c.time_zone'])
      .where('z.id', '=', body.zoneId)
      .executeTakeFirst();
    if (!zone) throw new NotFoundError('Zone', body.zoneId);
    const start = new Date(body.startAt);
    return this.db.transaction().execute(async (tx) => {
      const priced = await this.pricing.price(tx, {
        customerUserId: actor.actorUserId ?? '',
        serviceId: body.serviceId,
        serviceOptionId: body.serviceOptionId,
        cityId: zone.city_id,
        zoneId: body.zoneId,
        bookingType: body.bookingType,
        serviceStart: start,
        timeZone: zone.time_zone,
        promoCode: body.promoCode,
        now: new Date(),
      });
      const payoutRules = await tx
        .selectFrom('payout_rule')
        .selectAll()
        .where('service_id', '=', body.serviceId)
        .where('is_active', '=', true)
        .execute();
      const payout = selectRule(
        payoutRules.map((r) => ({
          id: r.id,
          serviceId: r.service_id,
          serviceOptionId: r.service_option_id,
          cityId: r.city_id,
          zoneId: r.zone_id,
          weekdays: r.weekdays as IsoWeekday[] | null,
          startMinute: r.start_minute,
          endMinute: r.end_minute,
          validFrom: r.valid_from,
          validTo: r.valid_to,
          priority: r.priority,
          isActive: r.is_active,
          row: r,
        })),
        {
          serviceId: body.serviceId,
          serviceOptionId: body.serviceOptionId,
          cityId: zone.city_id,
          zoneId: body.zoneId,
          serviceStart: start,
          pricedAt: start,
          timeZone: zone.time_zone,
        },
      );
      const withinHours = await sql<{ ok: boolean }>`
        SELECT within_operating_hours(${body.zoneId}::uuid, ${body.serviceId}::uuid, ${start}::timestamptz,
                                      ${start}::timestamptz + interval '1 minute') AS ok`.execute(
        tx,
      );
      return {
        quote: priced.quote,
        priceRuleId: priced.priceRuleId,
        payout: payout
          ? {
              payoutRuleId: payout.id,
              basePayoutPaise: payout.row.base_payout_paise,
              travelAllowancePaise: payout.row.travel_allowance_paise,
            }
          : null,
        startsWithinOperatingHours: withinHours.rows[0]?.ok ?? false,
      };
    });
  }
}

function assertReplaceable(
  rule: { is_active: boolean; valid_from: Date; valid_to: Date | null },
  from: Date,
): void {
  if (!rule.is_active)
    throw new BusinessRuleError('RULE_INACTIVE', 'This rule is no longer active');
  if (from <= rule.valid_from) {
    throw new ValidationError(
      'EFFECTIVE_FROM_INVALID',
      'The new amount must start after the current rule began',
    );
  }
  if (rule.valid_to && from >= rule.valid_to) {
    throw new BusinessRuleError(
      'RULE_ALREADY_ENDING',
      'This rule ends before that date; create a new rule instead',
    );
  }
}
