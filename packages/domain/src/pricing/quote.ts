import {
  applyBasisPoints,
  assertBasisPoints,
  assertPaise,
  type BasisPoints,
  type Paise,
} from '../money/money.js';

/**
 * Customer price calculation. Configured amounts are tax-exclusive; tax is added on the
 * taxable value after discount. Every line is kept so the booking stores exactly how
 * the total was reached.
 */

export interface ChargeInput {
  readonly ruleId: string;
  readonly code: string;
  readonly label: string;
  readonly kind: 'FIXED' | 'PERCENT_OF_BASE';
  /** Paise for FIXED, basis points for PERCENT_OF_BASE. */
  readonly value: number;
  readonly taxable: boolean;
}

export interface PromotionInput {
  readonly promotionId: string;
  readonly code: string;
  readonly discountType: 'FLAT' | 'PERCENT';
  /** Paise for FLAT, basis points for PERCENT. */
  readonly value: number;
  readonly maxDiscountPaise: Paise | null;
  readonly minOrderPaise: Paise | null;
}

export interface QuoteInput {
  readonly priceRuleId: string;
  readonly baseAmountPaise: Paise;
  readonly taxRateBp: BasisPoints;
  readonly taxCode: string;
  readonly charges: readonly ChargeInput[];
  readonly promotion: PromotionInput | null;
}

export type QuoteLineType = 'BASE' | 'CHARGE' | 'DISCOUNT' | 'TAX';

export interface QuoteLine {
  readonly type: QuoteLineType;
  readonly code: string;
  readonly label: string;
  /** Positive for amounts payable, negative for discounts. */
  readonly amountPaise: Paise;
  readonly sourceId: string | null;
}

export type PromotionOutcome =
  | { readonly applied: true; readonly discountPaise: Paise }
  | { readonly applied: false; readonly reason: 'MIN_ORDER_NOT_MET' | 'ZERO_DISCOUNT' };

export interface Quote {
  readonly lines: readonly QuoteLine[];
  readonly subtotalPaise: Paise;
  readonly discountPaise: Paise;
  readonly taxablePaise: Paise;
  readonly taxPaise: Paise;
  readonly totalPaise: Paise;
  readonly promotion: PromotionOutcome | null;
}

export function calculateQuote(input: QuoteInput): Quote {
  assertPaise(input.baseAmountPaise, 'baseAmountPaise');
  if (input.baseAmountPaise < 0) throw new RangeError('baseAmountPaise cannot be negative');
  assertBasisPoints(input.taxRateBp, 'taxRateBp');

  const lines: QuoteLine[] = [
    {
      type: 'BASE',
      code: 'BASE',
      label: 'Service price',
      amountPaise: input.baseAmountPaise,
      sourceId: input.priceRuleId,
    },
  ];

  let taxableCharges = 0;
  let nonTaxableCharges = 0;
  for (const charge of input.charges) {
    const amount =
      charge.kind === 'FIXED'
        ? charge.value
        : applyBasisPoints(input.baseAmountPaise, charge.value);
    assertPaise(amount, `charge ${charge.code}`);
    if (amount < 0) throw new RangeError(`charge ${charge.code} cannot be negative`);
    if (amount === 0) continue;
    if (charge.taxable) taxableCharges += amount;
    else nonTaxableCharges += amount;
    lines.push({
      type: 'CHARGE',
      code: charge.code,
      label: charge.label,
      amountPaise: amount,
      sourceId: charge.ruleId,
    });
  }

  const taxableBeforeDiscount = input.baseAmountPaise + taxableCharges;
  const subtotal = taxableBeforeDiscount + nonTaxableCharges;

  let discount = 0;
  let promotion: PromotionOutcome | null = null;
  if (input.promotion) {
    promotion = evaluatePromotion(input.promotion, subtotal, taxableBeforeDiscount);
    if (promotion.applied) {
      discount = promotion.discountPaise;
      lines.push({
        type: 'DISCOUNT',
        code: input.promotion.code,
        label: `Promo ${input.promotion.code}`,
        amountPaise: -discount,
        sourceId: input.promotion.promotionId,
      });
    }
  }

  // Discount reduces the taxable value; it never exceeds it (see evaluatePromotion).
  const taxable = taxableBeforeDiscount - discount;
  const tax = applyBasisPoints(taxable, input.taxRateBp);
  if (tax > 0) {
    lines.push({
      type: 'TAX',
      code: input.taxCode,
      label: input.taxCode,
      amountPaise: tax,
      sourceId: null,
    });
  }

  return {
    lines,
    subtotalPaise: subtotal,
    discountPaise: discount,
    taxablePaise: taxable,
    taxPaise: tax,
    totalPaise: subtotal - discount + tax,
    promotion,
  };
}

function evaluatePromotion(
  promo: PromotionInput,
  subtotal: Paise,
  discountableCeiling: Paise,
): PromotionOutcome {
  if (promo.minOrderPaise !== null && subtotal < promo.minOrderPaise) {
    return { applied: false, reason: 'MIN_ORDER_NOT_MET' };
  }
  let discount =
    promo.discountType === 'FLAT' ? promo.value : applyBasisPoints(subtotal, promo.value);
  assertPaise(discount, 'discount');
  if (promo.maxDiscountPaise !== null) discount = Math.min(discount, promo.maxDiscountPaise);
  discount = Math.max(0, Math.min(discount, discountableCeiling));
  if (discount === 0) return { applied: false, reason: 'ZERO_DISCOUNT' };
  return { applied: true, discountPaise: discount };
}
