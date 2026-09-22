import { describe, expect, it } from 'vitest';
import { applyBasisPoints, assertPaise, formatInr } from './money.js';

describe('money', () => {
  it('applies basis points with half-up rounding', () => {
    expect(applyBasisPoints(49_900, 1_800)).toBe(8_982);
    expect(applyBasisPoints(1, 5_000)).toBe(1); // 0.5 paise rounds up
    expect(applyBasisPoints(-1, 5_000)).toBe(-1); // symmetric for negatives
    expect(applyBasisPoints(333, 1_000)).toBe(33);
  });

  it('rejects fractional paise and out-of-range rates', () => {
    expect(() => {
      assertPaise(10.5);
    }).toThrow(RangeError);
    expect(() => applyBasisPoints(100, 10_001)).toThrow(RangeError);
    expect(() => applyBasisPoints(100, -1)).toThrow(RangeError);
  });

  it('formats rupees with Indian grouping', () => {
    expect(formatInr(12_345_650)).toBe('₹1,23,456.50');
  });
});
