import { describe, expect, it } from 'vitest';
import { indiaDate, money, toE164 } from './format';

describe('format', () => {
  it('normalises Indian mobile numbers', () => {
    expect(toE164('98765 43210')).toBe('+919876543210');
    expect(toE164('+91 98765-43210')).toBe('+919876543210');
    expect(toE164('09876543210')).toBe('+919876543210');
    expect(toE164('12345')).toBeNull();
    expect(toE164('5876543210')).toBeNull();
  });

  it('formats rupees from paise', () => {
    expect(money(58_882, 'en')).toBe('₹588.82');
  });

  it('uses the India calendar day', () => {
    expect(indiaDate(0, new Date('2026-09-23T20:00:00Z'))).toBe('2026-09-24');
    expect(indiaDate(1, new Date('2026-09-23T10:00:00Z'))).toBe('2026-09-24');
  });
});
