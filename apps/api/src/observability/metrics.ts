import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics. HTTP and job metrics are counted in-process; queue and backlog
 * gauges are read from PostgreSQL when scraped (see MetricsService), so they are correct
 * however many instances run.
 */
export class Metrics {
  readonly registry = new Registry();

  readonly httpDuration = new Histogram({
    name: 'onetappe_http_request_duration_seconds',
    help: 'API request duration by route pattern and status',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  readonly jobRuns = new Counter({
    name: 'onetappe_job_runs_total',
    help: 'Background job runs by outcome',
    labelNames: ['job', 'outcome'] as const,
    registers: [this.registry],
  });

  readonly jobDuration = new Histogram({
    name: 'onetappe_job_duration_seconds',
    help: 'Background job run duration',
    labelNames: ['job'] as const,
    buckets: [0.05, 0.1, 0.5, 1, 5, 15, 60],
    registers: [this.registry],
  });

  readonly backlog = new Gauge({
    name: 'onetappe_backlog',
    help: 'Items waiting or failed, by queue and state (read from the database)',
    labelNames: ['queue', 'state'] as const,
    registers: [this.registry],
  });

  readonly oldestWaitingSeconds = new Gauge({
    name: 'onetappe_backlog_oldest_waiting_seconds',
    help: 'Age of the oldest item still waiting, by queue',
    labelNames: ['queue'] as const,
    registers: [this.registry],
  });

  readonly integrationPaused = new Gauge({
    name: 'onetappe_integration_paused',
    help: '1 when delivery to an integration target is paused',
    labelNames: ['target'] as const,
    registers: [this.registry],
  });

  constructor(service: string) {
    this.registry.setDefaultLabels({ service });
    collectDefaultMetrics({ register: this.registry, prefix: 'onetappe_' });
  }
}
