/**
 * Compares what the gateway says was paid with what we asked for, to the paisa and the
 * currency. Returns the problem to record, or null when they match exactly. A missing
 * amount or currency is a problem too: a payment is never accepted on partial evidence.
 * The description holds only amounts and currency codes, never gateway free text.
 */
export function moneyMismatch(
  expected: { readonly amount_paise: number; readonly currency: string },
  reported: { readonly amountPaise: number | null; readonly currency: string | null },
): string | null {
  const amount = reported.amountPaise;
  if (amount === null) return 'AMOUNT_MISSING';
  if (!Number.isSafeInteger(amount)) return 'AMOUNT_INVALID';
  if (amount !== expected.amount_paise) {
    return `AMOUNT_MISMATCH expected ${String(expected.amount_paise)} got ${String(amount)}`;
  }
  const currency = reported.currency;
  if (currency === null) return 'CURRENCY_MISSING';
  if (!/^[A-Z]{3}$/.test(currency)) return 'CURRENCY_INVALID';
  if (currency !== expected.currency.trim()) {
    return `CURRENCY_MISMATCH expected ${expected.currency.trim()} got ${currency}`;
  }
  return null;
}
