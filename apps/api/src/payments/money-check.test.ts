import { describe, expect, it } from 'vitest';
import { moneyMismatch } from './money-check.js';

const expected = { amount_paise: 58_882, currency: 'INR' };

describe('moneyMismatch', () => {
  it('accepts exactly the expected paise and currency', () => {
    expect(moneyMismatch(expected, { amountPaise: 58_882, currency: 'INR' })).toBeNull();
  });

  it('refuses a different amount, even by one paisa, in either direction', () => {
    expect(moneyMismatch(expected, { amountPaise: 58_881, currency: 'INR' })).toBe(
      'AMOUNT_MISMATCH expected 58882 got 58881',
    );
    expect(moneyMismatch(expected, { amountPaise: 58_883, currency: 'INR' })).toBe(
      'AMOUNT_MISMATCH expected 58882 got 58883',
    );
  });

  it('refuses a different currency even when the number matches', () => {
    expect(moneyMismatch(expected, { amountPaise: 58_882, currency: 'USD' })).toBe(
      'CURRENCY_MISMATCH expected INR got USD',
    );
  });

  it('refuses partial evidence: a missing amount or currency', () => {
    expect(moneyMismatch(expected, { amountPaise: null, currency: 'INR' })).toBe('AMOUNT_MISSING');
    expect(moneyMismatch(expected, { amountPaise: 58_882, currency: null })).toBe(
      'CURRENCY_MISSING',
    );
  });

  it('refuses malformed values without echoing them', () => {
    expect(moneyMismatch(expected, { amountPaise: 588.82, currency: 'INR' })).toBe(
      'AMOUNT_INVALID',
    );
    expect(moneyMismatch(expected, { amountPaise: 58_882, currency: 'inr' })).toBe(
      'CURRENCY_INVALID',
    );
    expect(
      moneyMismatch(expected, { amountPaise: 58_882, currency: '<script>alert(1)</script>' }),
    ).toBe('CURRENCY_INVALID');
  });
});
