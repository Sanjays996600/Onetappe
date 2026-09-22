import { Injectable } from '@nestjs/common';
import {
  calculateQuote,
  ruleMatches,
  selectRule,
  type ChargeInput,
  type IsoWeekday,
  type PromotionInput,
  type Quote,
  type RuleContext,
  type ScopedRule,
} from '@onetappe/domain';
import { sql } from 'kysely';
import { BusinessRuleError, ValidationError } from '../common/errors.js';
import type { Tx } from '../database/transaction.js';

export interface PricingRequest {
  readonly customerUserId: string;
  readonly serviceId: string;
  readonly serviceOptionId: string | null;
  readonly cityId: string;
  readonly zoneId: string;
  readonly bookingType: 'INSTANT' | 'SCHEDULED';
  readonly serviceStart: Date;
  readonly timeZone: string;
  readonly promoCode: string | null;
  readonly now: Date;
}

export interface PricedBooking {
  readonly quote: Quote;
  readonly priceRuleId: string;
  readonly promotionId: string | null;
}

export type PromotionRejectionReason =
  | 'NOT_FOUND'
  | 'NOT_ACTIVE'
  | 'NOT_FOR_THIS_SERVICE'
  | 'NOT_FOR_THIS_CITY'
  | 'FULLY_REDEEMED'
  | 'ALREADY_USED'
  | 'FIRST_BOOKING_ONLY'
  | 'MIN_ORDER_NOT_MET';

/**
 * Loads the configured rules for a booking and delegates the arithmetic to
 * @onetappe/domain. No price is hard-coded anywhere in the application.
 */
@Injectable()
export class PricingService {
  async price(tx: Tx, request: PricingRequest): Promise<PricedBooking> {
    const context: RuleContext = {
      serviceId: request.serviceId,
      serviceOptionId: request.serviceOptionId,
      cityId: request.cityId,
      zoneId: request.zoneId,
      serviceStart: request.serviceStart,
      pricedAt: request.now,
      timeZone: request.timeZone,
    };

    const priceRules = await tx
      .selectFrom('price_rule')
      .selectAll()
      .where('service_id', '=', request.serviceId)
      .where('is_active', '=', true)
      .execute();

    const priceRule = selectRule(
      priceRules.map((row) => ({ ...toScopedRule(row), row })),
      context,
    );
    if (!priceRule) {
      throw new BusinessRuleError(
        'SERVICE_NOT_PRICED',
        'This service has no price configured for the selected area and time',
      );
    }

    const taxRate = await tx
      .selectFrom('tax_rate')
      .select(['code', 'rate_bp'])
      .where('code', '=', priceRule.row.tax_rate_code)
      .where('effective_from', '<=', request.now)
      .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', request.now)]))
      .executeTakeFirst();
    if (!taxRate) {
      throw new BusinessRuleError(
        'TAX_RATE_MISSING',
        `No effective tax rate ${priceRule.row.tax_rate_code} is configured`,
      );
    }

    const charges = await this.loadCharges(tx, request, context);
    const promotion = request.promoCode
      ? await this.loadPromotion(tx, request, request.promoCode)
      : null;

    const quote = calculateQuote({
      priceRuleId: priceRule.id,
      baseAmountPaise: priceRule.row.base_amount_paise,
      taxRateBp: taxRate.rate_bp,
      taxCode: taxRate.code,
      charges,
      promotion,
    });

    if (promotion && quote.promotion && !quote.promotion.applied) {
      throw promotionRejected(
        quote.promotion.reason === 'MIN_ORDER_NOT_MET' ? 'MIN_ORDER_NOT_MET' : 'NOT_ACTIVE',
      );
    }

    return {
      quote,
      priceRuleId: priceRule.id,
      promotionId: promotion?.promotionId ?? null,
    };
  }

  private async loadCharges(
    tx: Tx,
    request: PricingRequest,
    context: RuleContext,
  ): Promise<ChargeInput[]> {
    const rows = await tx
      .selectFrom('charge_rule')
      .selectAll()
      .where('is_active', '=', true)
      .where((eb) =>
        eb.or([eb('service_id', 'is', null), eb('service_id', '=', request.serviceId)]),
      )
      .where((eb) =>
        eb.or([eb('booking_type', 'is', null), eb('booking_type', '=', request.bookingType)]),
      )
      .execute();

    // Rules sharing a code are alternatives: the most specific matching one applies.
    const byCode = new Map<string, Array<ScopedRule & { row: (typeof rows)[number] }>>();
    for (const row of rows) {
      const scoped = {
        ...toScopedRule({
          ...row,
          service_id: row.service_id ?? request.serviceId,
          service_option_id: null,
          priority: 0,
        }),
        row,
      };
      if (!ruleMatches(scoped, context)) continue;
      const group = byCode.get(row.code) ?? [];
      group.push(scoped);
      byCode.set(row.code, group);
    }

    const charges: ChargeInput[] = [];
    for (const group of byCode.values()) {
      const chosen = selectRule(group, context);
      if (!chosen) continue;
      charges.push({
        ruleId: chosen.id,
        code: chosen.row.code,
        label: chosen.row.label,
        kind: chosen.row.kind as ChargeInput['kind'],
        value: chosen.row.value,
        taxable: chosen.row.taxable,
      });
    }
    return charges.sort((a, b) => a.code.localeCompare(b.code));
  }

  /**
   * Validates a promo code for this customer. The promotion row is locked so that the
   * last available redemption cannot be used twice concurrently.
   */
  private async loadPromotion(
    tx: Tx,
    request: PricingRequest,
    code: string,
  ): Promise<PromotionInput> {
    const promo = await tx
      .selectFrom('promotion')
      .selectAll()
      .where(sql<boolean>`code = ${code}::citext`)
      .forUpdate()
      .executeTakeFirst();
    if (!promo) throw promotionRejected('NOT_FOUND');
    if (!promo.is_active || request.now < promo.valid_from || request.now >= promo.valid_to) {
      throw promotionRejected('NOT_ACTIVE');
    }

    const services = await tx
      .selectFrom('promotion_service')
      .select('service_id')
      .where('promotion_id', '=', promo.id)
      .execute();
    if (services.length > 0 && !services.some((s) => s.service_id === request.serviceId)) {
      throw promotionRejected('NOT_FOR_THIS_SERVICE');
    }

    const cities = await tx
      .selectFrom('promotion_city')
      .select('city_id')
      .where('promotion_id', '=', promo.id)
      .execute();
    if (cities.length > 0 && !cities.some((c) => c.city_id === request.cityId)) {
      throw promotionRejected('NOT_FOR_THIS_CITY');
    }

    const usage = await tx
      .selectFrom('promotion_redemption')
      .select((eb) => [
        eb.fn.countAll<number>().as('total'),
        eb.fn.count<number>('id').filterWhere('user_id', '=', request.customerUserId).as('byUser'),
      ])
      .where('promotion_id', '=', promo.id)
      .where('status', '<>', 'RELEASED')
      .executeTakeFirstOrThrow();
    if (promo.max_redemptions !== null && usage.total >= promo.max_redemptions) {
      throw promotionRejected('FULLY_REDEEMED');
    }
    if (usage.byUser >= promo.max_redemptions_per_user) {
      throw promotionRejected('ALREADY_USED');
    }

    if (promo.first_booking_only) {
      const previous = await tx
        .selectFrom('booking')
        .select('id')
        .where('customer_user_id', '=', request.customerUserId)
        .where('status', 'not in', ['PENDING_PAYMENT', 'CANCELLED', 'EXPIRED'])
        .limit(1)
        .executeTakeFirst();
      if (previous) throw promotionRejected('FIRST_BOOKING_ONLY');
    }

    return {
      promotionId: promo.id,
      code: promo.code,
      discountType: promo.discount_type as PromotionInput['discountType'],
      value: promo.value,
      maxDiscountPaise: promo.max_discount_paise,
      minOrderPaise: promo.min_order_paise,
    };
  }
}

interface RuleRow {
  id: string;
  service_id: string;
  service_option_id: string | null;
  city_id: string | null;
  zone_id: string | null;
  weekdays: number[] | null;
  start_minute: number | null;
  end_minute: number | null;
  valid_from: Date;
  valid_to: Date | null;
  priority: number;
  is_active: boolean;
}

function toScopedRule(row: RuleRow): ScopedRule {
  return {
    id: row.id,
    serviceId: row.service_id,
    serviceOptionId: row.service_option_id,
    cityId: row.city_id,
    zoneId: row.zone_id,
    weekdays: row.weekdays as IsoWeekday[] | null,
    startMinute: row.start_minute,
    endMinute: row.end_minute,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    priority: row.priority,
    isActive: row.is_active,
  };
}

function promotionRejected(reason: PromotionRejectionReason): ValidationError {
  return new ValidationError('PROMO_CODE_INVALID', `Promo code cannot be applied: ${reason}`, {
    reason,
  });
}
