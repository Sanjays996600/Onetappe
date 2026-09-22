import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Queryable } from '../database/transaction.js';

export interface ServiceLocation {
  readonly localityId: string;
  readonly zoneId: string;
  readonly cityId: string;
  readonly timeZone: string;
}

export interface ServiceabilityQuery {
  readonly pincode: string;
  readonly lat: number | string;
  readonly lng: number | string;
  /** When given, only this service's active zones are considered. */
  readonly serviceId?: string;
}

/**
 * Decides whether a point can be served: its pincode must belong to an active locality
 * in an active zone and city, and the point must be inside that zone's service radius.
 * The nearest qualifying zone wins. Nothing here is specific to one city.
 */
@Injectable()
export class ServiceabilityService {
  async resolve(tx: Queryable, query: ServiceabilityQuery): Promise<ServiceLocation | null> {
    const distance = sql<number>`distance_m(${query.lat}::numeric, ${query.lng}::numeric, sl.center_lat, sl.center_lng)`;

    const row = await tx
      .selectFrom('serviceable_locality as sl')
      .select(['sl.locality_id', 'sl.zone_id', 'sl.city_id', 'sl.time_zone'])
      .where('sl.pincode', '=', query.pincode)
      .where(sql<boolean>`${distance} <= sl.service_radius_m`)
      .$if(query.serviceId !== undefined, (qb) =>
        qb.where((eb) =>
          eb.exists(
            eb
              .selectFrom('service_zone as sz')
              .innerJoin('service as s', 's.id', 'sz.service_id')
              .select(sql`1`.as('one'))
              .whereRef('sz.zone_id', '=', 'sl.zone_id')
              .where('sz.service_id', '=', query.serviceId ?? '')
              .where('sz.is_active', '=', true)
              .where('s.is_active', '=', true),
          ),
        ),
      )
      .orderBy(distance)
      .orderBy('sl.locality_id')
      .limit(1)
      .executeTakeFirst();

    if (!row?.locality_id || !row.zone_id || !row.city_id || !row.time_zone) return null;
    return {
      localityId: row.locality_id,
      zoneId: row.zone_id,
      cityId: row.city_id,
      timeZone: row.time_zone,
    };
  }
}
