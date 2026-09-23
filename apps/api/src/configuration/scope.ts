import type { Kysely } from 'kysely';
import { hasPermissionInCity, citiesFor, type Principal } from '../auth/principal.js';
import { ForbiddenError, NotFoundError } from '../common/errors.js';
import type { DB } from '../database/db.generated.js';
import type { Queryable } from '../database/transaction.js';

/**
 * Configuration is scoped like operations: a role limited to Noida may change Noida's
 * zones, hours and prices, but not another city's, and not rules that apply everywhere
 * (those need the permission for all cities).
 */
export function assertCityScope(principal: Principal, permission: string, cityId: string | null) {
  if (cityId === null) {
    if (citiesFor(principal, permission) !== null) {
      throw new ForbiddenError(
        'CITY_SCOPE_REQUIRED',
        'Rules for every city need this permission for all cities',
      );
    }
    return;
  }
  if (!hasPermissionInCity(principal, permission, cityId)) {
    throw new ForbiddenError('OUTSIDE_CITY_SCOPE', 'This city is outside your responsibilities');
  }
}

export async function cityOfZone(db: Queryable | Kysely<DB>, zoneId: string): Promise<string> {
  const zone = await db
    .selectFrom('zone')
    .select('city_id')
    .where('id', '=', zoneId)
    .executeTakeFirst();
  if (!zone) throw new NotFoundError('Zone', zoneId);
  return zone.city_id;
}

/** The narrowest city a rule applies to (zone implies its city). */
export async function ruleCity(
  db: Queryable | Kysely<DB>,
  rule: { cityId: string | null; zoneId: string | null },
): Promise<string | null> {
  if (rule.zoneId) {
    const city = await cityOfZone(db, rule.zoneId);
    if (rule.cityId && rule.cityId !== city) {
      throw new NotFoundError('Zone', rule.zoneId);
    }
    return city;
  }
  return rule.cityId;
}
