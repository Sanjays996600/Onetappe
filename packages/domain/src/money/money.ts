/**
 * Money is always an integer number of paise (1 INR = 100 paise). Never use floating
 * point for amounts. Percentages are integer basis points (1% = 100 bp).
 */
export type Paise = number;
export type BasisPoints = number;

export function assertPaise(value: number, label = 'amount'): asserts value is Paise {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be an integer number of paise, got ${value}`);
  }
}

export function assertBasisPoints(value: number, label = 'rate'): asserts value is BasisPoints {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100_00) {
    throw new RangeError(`${label} must be an integer between 0 and 10000 basis points`);
  }
}

/**
 * `amount × bp / 10000`, rounded half away from zero to the nearest paisa.
 * Uses BigInt so large amounts cannot lose precision.
 */
export function applyBasisPoints(amount: Paise, bp: BasisPoints): Paise {
  assertPaise(amount);
  assertBasisPoints(bp);
  const product = BigInt(amount) * BigInt(bp);
  const divisor = 10_000n;
  const sign = product < 0n ? -1n : 1n;
  const abs = product * sign;
  const rounded = (abs + divisor / 2n) / divisor;
  return Number(rounded * sign);
}

/** Formats paise as "₹1,234.50" using Indian digit grouping. */
export function formatInr(amount: Paise, locale = 'en-IN'): string {
  assertPaise(amount);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
  }).format(amount / 100);
}
