import { describe, expect, it } from 'vitest';
import { calculateQuote } from './quote.js';
import { selectRule, type ScopedRule } from './rule-selection.js';

const base: ScopedRule = {
  id: 'r-base',
  serviceId: 'svc-hh60',
  serviceOptionId: null,
  cityId: null,
  zoneId: null,
  weekdays: null,
  startMinute: null,
  endMinute: null,
  validFrom: new Date('2026-01-01T00:00:00Z'),
  validTo: null,
  priority: 0,
  isActive: true,
};

const ctx = {
  serviceId: 'svc-hh60',
  serviceOptionId: null,
  cityId: 'city-noida',
  zoneId: 'zone-sec62',
  serviceStart: new Date('2026-10-01T04:30:00Z'), // Thu 10:00 IST
  pricedAt: new Date('2026-09-30T10:00:00Z'),
  timeZone: 'Asia/Kolkata',
};

describe('rule selection', () => {
  it('prefers the more specific rule at equal priority', () => {
    const zone = { ...base, id: 'r-zone', zoneId: 'zone-sec62' };
    expect(selectRule([base, zone], ctx)?.id).toBe('r-zone');
  });

  it('lets priority override specificity', () => {
    const zone = { ...base, id: 'r-zone', zoneId: 'zone-sec62' };
    const campaign = { ...base, id: 'r-campaign', priority: 10 };
    expect(selectRule([zone, campaign], ctx)?.id).toBe('r-campaign');
  });

  it('respects weekday, time window, validity and active flag', () => {
    const weekend = { ...base, id: 'r-weekend', weekdays: [6, 7] as const, priority: 5 };
    const evening = {
      ...base,
      id: 'r-evening',
      startMinute: 18 * 60,
      endMinute: 22 * 60,
      priority: 5,
    };
    const expired = {
      ...base,
      id: 'r-old',
      priority: 5,
      validTo: new Date('2026-09-01T00:00:00Z'),
    };
    const inactive = { ...base, id: 'r-off', priority: 5, isActive: false };
    const otherZone = { ...base, id: 'r-other', zoneId: 'zone-x', priority: 5 };
    expect(selectRule([base, weekend, evening, expired, inactive, otherZone], ctx)?.id).toBe(
      'r-base',
    );
  });

  it('returns null when nothing applies', () => {
    expect(selectRule([{ ...base, serviceId: 'svc-other' }], ctx)).toBeNull();
  });
});

describe('quote', () => {
  it('adds tax on the discounted taxable value', () => {
    const quote = calculateQuote({
      priceRuleId: 'r-base',
      baseAmountPaise: 49_900,
      taxRateBp: 1_800,
      taxCode: 'GST18',
      charges: [
        {
          ruleId: 'c1',
          code: 'INSTANT',
          label: 'Instant booking',
          kind: 'FIXED',
          value: 5_000,
          taxable: true,
        },
      ],
      promotion: {
        promotionId: 'p1',
        code: 'FIRST50',
        discountType: 'FLAT',
        value: 5_000,
        maxDiscountPaise: null,
        minOrderPaise: null,
      },
    });
    expect(quote.subtotalPaise).toBe(54_900);
    expect(quote.discountPaise).toBe(5_000);
    expect(quote.taxablePaise).toBe(49_900);
    expect(quote.taxPaise).toBe(8_982);
    expect(quote.totalPaise).toBe(58_882);
    expect(quote.lines.map((l) => l.type)).toEqual(['BASE', 'CHARGE', 'DISCOUNT', 'TAX']);
    const sum = quote.lines.reduce((acc, l) => acc + l.amountPaise, 0);
    expect(sum).toBe(quote.totalPaise);
  });

  it('caps percentage discounts and skips promotions below the minimum order', () => {
    const capped = calculateQuote({
      priceRuleId: 'r',
      baseAmountPaise: 100_000,
      taxRateBp: 0,
      taxCode: 'NIL',
      charges: [],
      promotion: {
        promotionId: 'p',
        code: 'PCT20',
        discountType: 'PERCENT',
        value: 2_000,
        maxDiscountPaise: 10_000,
        minOrderPaise: null,
      },
    });
    expect(capped.discountPaise).toBe(10_000);
    expect(capped.lines.some((l) => l.type === 'TAX')).toBe(false);

    const tooSmall = calculateQuote({
      priceRuleId: 'r',
      baseAmountPaise: 20_000,
      taxRateBp: 1_800,
      taxCode: 'GST18',
      charges: [],
      promotion: {
        promotionId: 'p',
        code: 'BIG',
        discountType: 'FLAT',
        value: 5_000,
        maxDiscountPaise: null,
        minOrderPaise: 50_000,
      },
    });
    expect(tooSmall.promotion).toEqual({ applied: false, reason: 'MIN_ORDER_NOT_MET' });
    expect(tooSmall.totalPaise).toBe(23_600);
  });

  it('never discounts below zero taxable value', () => {
    const quote = calculateQuote({
      priceRuleId: 'r',
      baseAmountPaise: 3_000,
      taxRateBp: 1_800,
      taxCode: 'GST18',
      charges: [],
      promotion: {
        promotionId: 'p',
        code: 'HUGE',
        discountType: 'FLAT',
        value: 10_000,
        maxDiscountPaise: null,
        minOrderPaise: null,
      },
    });
    expect(quote.discountPaise).toBe(3_000);
    expect(quote.totalPaise).toBe(0);
  });
});
