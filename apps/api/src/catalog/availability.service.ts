import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { SLOT_GRANULARITY_MINUTES } from '../booking/booking-schedule.js';
import { Clock } from '../common/clock.js';
import { NotFoundError, ValidationError } from '../common/errors.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import type { ServiceLocation } from '../service-area/serviceability.service.js';

export interface AvailabilityQuery {
  readonly serviceId: string;
  readonly serviceOptionId: string | null;
  readonly location: ServiceLocation;
  /** Local calendar date, YYYY-MM-DD. */
  readonly date: string;
}

/**
 * Start times on a date for which at least one eligible worker is free right now. This
 * is guidance for the app's time picker only: the booking itself re-checks and reserves
 * atomically in the database, so a slot shown here can still be taken by someone else.
 */
@Injectable()
export class AvailabilityService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly clock: Clock,
  ) {}

  async slots(query: AvailabilityQuery): Promise<Date[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(query.date)) {
      throw new ValidationError('DATE_INVALID', 'Use a YYYY-MM-DD date');
    }
    const service = await this.db
      .selectFrom('service as s')
      .leftJoin('service_option as o', (join) =>
        join
          .onRef('o.service_id', '=', 's.id')
          .on('o.id', '=', query.serviceOptionId ?? '00000000-0000-0000-0000-000000000000'),
      )
      .select([
        's.duration_minutes',
        's.buffer_before_minutes',
        's.buffer_after_minutes',
        's.min_lead_time_minutes',
        's.max_advance_days',
        's.supports_scheduled',
        'o.duration_minutes as option_minutes',
      ])
      .where('s.id', '=', query.serviceId)
      .where('s.is_active', '=', true)
      .executeTakeFirst();
    if (!service || !service.supports_scheduled)
      throw new NotFoundError('Service', query.serviceId);

    const now = this.clock.now();
    const earliest = new Date(now.getTime() + service.min_lead_time_minutes * 60_000);
    const latest = new Date(now.getTime() + service.max_advance_days * 86_400_000);
    const duration = service.option_minutes ?? service.duration_minutes;
    const step = `${SLOT_GRANULARITY_MINUTES} minutes`;

    const { rows } = await sql<{ start: Date }>`
      WITH day AS (
        SELECT (${query.date}::date::timestamp AT TIME ZONE ${query.location.timeZone}) AS starts
      ),
      slot AS (
        SELECT gs AS start,
               tstzrange(gs - make_interval(mins => ${service.buffer_before_minutes}),
                         gs + make_interval(mins => ${duration + service.buffer_after_minutes}), '[)') AS blocked
        FROM day, generate_series(day.starts, day.starts + interval '1 day' - ${step}::interval, ${step}::interval) AS gs
        WHERE gs >= ${earliest} AND gs <= ${latest}
      )
      SELECT slot.start FROM slot
      WHERE EXISTS (
        SELECT 1
        FROM worker_profile w
        JOIN worker_shift sh ON sh.worker_id = w.user_id AND sh.status = 'PLANNED'
                            AND sh.zone_id = ${query.location.zoneId}::uuid AND sh.period @> slot.blocked
        WHERE w.status IN ('ACTIVE', 'RESTRICTED')
          AND worker_ineligibility_reason(w.user_id, ${query.serviceId}::uuid, ${query.location.zoneId}::uuid, slot.blocked) IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM worker_reservation r
            WHERE r.worker_id = w.user_id AND r.status IN ('HELD', 'ALLOCATED', 'ACCEPTED')
              AND r.period && slot.blocked
              AND NOT (r.status = 'HELD' AND r.hold_expires_at <= now())
          )
      )
      ORDER BY slot.start
    `.execute(this.db);
    return rows.map((row) => new Date(row.start));
  }
}
