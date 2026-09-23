import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { IntegrationMonitor } from '../integrations/integration-monitor.service.js';
import { JOB_NAMES, JobRunner } from '../jobs/job-runner.service.js';
import { MetricsService } from '../observability/metrics.service.js';

export interface Alert {
  readonly severity: 'critical' | 'warning';
  readonly code: string;
  readonly message: string;
}

/**
 * One view of platform health for operations: database, background jobs, queues,
 * integrations and the alerts that follow from them. The same conditions are exported as
 * Prometheus metrics for paging (see infra/monitoring/alerts.yml).
 */
@Injectable()
export class SystemStatusService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly jobs: JobRunner,
    private readonly metrics: MetricsService,
    private readonly integrations: IntegrationMonitor,
  ) {}

  async status() {
    const started = Date.now();
    await sql`SELECT 1`.execute(this.db);
    const databaseLatencyMs = Date.now() - started;

    const lastRuns = await this.db
      .selectFrom('job_run')
      .select((eb) => [
        'job_name',
        eb.fn.max<Date | null>('started_at').as('lastStartedAt'),
        eb.fn
          .max<Date | null>('finished_at')
          .filterWhere('status', '=', 'SUCCEEDED')
          .as('lastSucceededAt'),
        eb.fn
          .countAll<number>()
          .filterWhere((w) =>
            w.and([
              w('status', '=', 'FAILED'),
              w('started_at', '>', sql<Date>`now() - interval '1 hour'`),
            ]),
          )
          .as('failuresLastHour'),
      ])
      .where('started_at', '>', sql<Date>`now() - interval '1 day'`)
      .groupBy('job_name')
      .execute();
    const intervals = this.jobs.intervals();
    const now = Date.now();
    const jobs = JOB_NAMES.map((name) => {
      const run = lastRuns.find((r) => r.job_name === name);
      const lastSuccess = run?.lastSucceededAt ?? null;
      // A job is stale when it has not succeeded for five of its intervals (min. 5 minutes).
      const staleAfterMs = Math.max(intervals[name] * 5, 5 * 60_000);
      return {
        name,
        intervalSeconds: intervals[name] / 1000,
        lastStartedAt: run?.lastStartedAt?.toISOString() ?? null,
        lastSucceededAt: lastSuccess?.toISOString() ?? null,
        failuresLastHour: run?.failuresLastHour ?? 0,
        stale: !lastSuccess || now - lastSuccess.getTime() > staleAfterMs,
      };
    });

    const backlog = await this.metrics.backlogRows();
    const integrations = await this.integrations.status();
    return {
      checkedAt: new Date().toISOString(),
      database: { ok: true, latencyMs: databaseLatencyMs },
      jobs,
      backlog: backlog.map((row) => ({
        queue: row.queue,
        state: row.state,
        count: row.n,
        oldestWaitingSeconds: row.oldest === null ? null : Math.round(row.oldest),
      })),
      integrations,
      alerts: alertsFrom(jobs, backlog, integrations.targets),
    };
  }
}

function alertsFrom(
  jobs: ReadonlyArray<{ name: string; stale: boolean; failuresLastHour: number }>,
  backlog: ReadonlyArray<{ queue: string; state: string; n: number; oldest: number | null }>,
  targets: ReadonlyArray<{
    target: string;
    enabled: boolean;
    pausedUntil: string | null;
    dead: number;
  }>,
): Alert[] {
  const alerts: Alert[] = [];
  for (const job of jobs) {
    if (job.stale) {
      alerts.push({
        severity: 'critical',
        code: 'JOB_STALE',
        message: `Background job ${job.name} has not succeeded recently (is the worker running?)`,
      });
    } else if (job.failuresLastHour > 0) {
      alerts.push({
        severity: 'warning',
        code: 'JOB_FAILING',
        message: `${job.name} failed ${String(job.failuresLastHour)} time(s) in the last hour`,
      });
    }
  }
  const count = (queue: string, state: string) =>
    backlog.find((b) => b.queue === queue && b.state === state)?.n ?? 0;
  if (count('safety_incident', 'OPEN_CRITICAL') > 0) {
    alerts.push({
      severity: 'critical',
      code: 'SAFETY_CRITICAL_OPEN',
      message: 'A critical safety incident is open',
    });
  }
  if (count('payment_event', 'PROCESSING_ERROR') > 0) {
    alerts.push({
      severity: 'warning',
      code: 'PAYMENT_EVENT_PROBLEMS',
      message: 'Gateway events with processing problems in the last 7 days (e.g. amount mismatch)',
    });
  }
  if (count('payment', 'OPEN_OVER_15_MIN') > 0) {
    alerts.push({
      severity: 'warning',
      code: 'PAYMENTS_UNRESOLVED',
      message:
        'Payments still unresolved after 15 minutes (webhooks or reconciliation not arriving?)',
    });
  }
  if (count('refund', 'FAILED') > 0) {
    alerts.push({
      severity: 'warning',
      code: 'REFUNDS_FAILED',
      message: 'Refunds failed at the gateway and need attention',
    });
  }
  if (count('notification', 'FAILED') > 0) {
    alerts.push({
      severity: 'warning',
      code: 'NOTIFICATIONS_FAILING',
      message: 'Notifications are failing to send',
    });
  }
  for (const t of targets) {
    if (!t.enabled) continue;
    if (t.pausedUntil)
      alerts.push({
        severity: 'warning',
        code: 'INTEGRATION_PAUSED',
        message: `${t.target} delivery is paused`,
      });
    if (t.dead > 0)
      alerts.push({
        severity: 'warning',
        code: 'INTEGRATION_DEAD_EVENTS',
        message: `${t.target} has ${String(t.dead)} failed event(s) needing a decision`,
      });
  }
  return alerts;
}
