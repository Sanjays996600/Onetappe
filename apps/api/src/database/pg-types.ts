import pg from 'pg';

const INT8_OID = 20;
const DATE_OID = 1082;

/**
 * - int8 (bigint) columns hold paise amounts and identity ids. They are returned as
 *   JavaScript numbers, and any value outside the safe-integer range fails loudly
 *   instead of silently losing precision.
 * - date columns are calendar dates with no time zone; keep them as 'YYYY-MM-DD'
 *   strings so they never shift across midnight.
 */
export function registerPgTypeParsers(): void {
  pg.types.setTypeParser(INT8_OID, (value: string) => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw new RangeError(`bigint value ${value} exceeds the safe integer range`);
    }
    return parsed;
  });
  pg.types.setTypeParser(DATE_OID, (value: string) => value);
}
