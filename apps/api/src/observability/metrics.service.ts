import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { METRICS } from './observability.tokens.js';
import type { Metrics } from './metrics.js';

export interface BacklogRow {
  readonly queue: string;
  readonly state: string;
  readonly n: number;
  readonly oldest: number | null;
}

/** Reads backlog gauges from the database at scrape time. */
@Injectable()
export class MetricsService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  async render(): Promise<{ contentType: string; body: string }> {
    await this.refreshBacklog();
    return {
      contentType: this.metrics.registry.contentType,
      body: await this.metrics.registry.metrics(),
    };
  }

  private async refreshBacklog(): Promise<void> {
    const { backlog, oldestWaitingSeconds, integrationPaused } = this.metrics;
    const rows = await this.backlogRows();
    backlog.reset();
    oldestWaitingSeconds.reset();
    for (const row of rows) {
      backlog.set({ queue: row.queue, state: row.state }, row.n);
      if (row.oldest !== null && row.n > 0) {
        oldestWaitingSeconds.set({ queue: `${row.queue}:${row.state}` }, row.oldest);
      }
    }

    const states = await this.db
      .selectFrom('integration_target_state')
      .select(['target', 'paused_until'])
      .execute();
    for (const s of states) {
      integrationPaused.set(
        { target: s.target },
        s.paused_until && s.paused_until > new Date() ? 1 : 0,
      );
    }
  }

  /** Waiting and failed work across the platform, read from the database. */
  async backlogRows(): Promise<BacklogRow[]> {
    const rows = await sql<BacklogRow>`
      SELECT 'notification' AS queue, status AS state, count(*)::int AS n,
             extract(epoch FROM now() - min(created_at))::float AS oldest
        FROM notification WHERE status IN ('QUEUED', 'SENDING', 'FAILED') GROUP BY status
      UNION ALL
      SELECT 'integration:' || target, status, count(*)::int,
             extract(epoch FROM now() - min(created_at))::float
        FROM integration_event WHERE status IN ('PENDING', 'PROCESSING', 'DEAD')
        GROUP BY target, status
      UNION ALL
      SELECT 'refund', status, count(*)::int, extract(epoch FROM now() - min(created_at))::float
        FROM refund WHERE status IN ('REQUESTED', 'APPROVED', 'PROCESSING', 'FAILED') GROUP BY status
      UNION ALL
      SELECT 'payment_event', 'PROCESSING_ERROR', count(*)::int,
             extract(epoch FROM now() - min(received_at))::float
        FROM payment_event
       WHERE processing_error IS NOT NULL AND received_at > now() - interval '7 days'
      UNION ALL
      SELECT 'payment', 'OPEN_OVER_15_MIN', count(*)::int,
             extract(epoch FROM now() - min(created_at))::float
        FROM payment WHERE status IN ('CREATED', 'AUTHORIZED')
         AND created_at < now() - interval '15 minutes' AND created_at > now() - interval '2 days'
      UNION ALL
      SELECT 'booking', 'UNASSIGNED_CONFIRMED', count(*)::int,
             extract(epoch FROM now() - min(updated_at))::float
        FROM booking WHERE status = 'CONFIRMED'
      UNION ALL
      SELECT 'safety_incident', 'OPEN_CRITICAL', count(*)::int,
             extract(epoch FROM now() - min(reported_at))::float
        FROM safety_incident WHERE severity = 'CRITICAL' AND status <> 'CLOSED'
      UNION ALL
      SELECT 'job', 'FAILED_LAST_HOUR', count(*)::int, NULL
        FROM job_run WHERE status = 'FAILED' AND started_at > now() - interval '1 hour'
    `.execute(this.db);
    return rows.rows;
  }
}
