import 'reflect-metadata';
import http from 'node:http';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadEnv, type Env } from './config/env.js';
import { JobRunner } from './jobs/job-runner.service.js';
import { authorizeScrape } from './observability/metrics.controller.js';
import { MetricsService } from './observability/metrics.service.js';
import type { JsonLogger } from './observability/json-logger.js';
import { APP_LOGGER } from './observability/observability.tokens.js';

/**
 * Background worker process: runs the periodic jobs, no API. Deploy one or more instances
 * next to the API; job leases keep them from doing the same work twice. A small internal
 * HTTP listener exposes liveness and the worker's metrics (job runs and durations).
 */
async function main(): Promise<void> {
  process.env['ONETAPPE_PROCESS'] = 'worker';
  const env = loadEnv();
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.useLogger(app.get<JsonLogger>(APP_LOGGER));
  app.enableShutdownHooks();
  app.get(JobRunner).start();
  serveInternal(env, app.get(MetricsService));
}

function serveInternal(env: Env, metrics: MetricsService): void {
  const server = http.createServer((request, response) => {
    void (async () => {
      if (request.url === '/health/live') {
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
        return;
      }
      if (request.url === '/metrics') {
        try {
          authorizeScrape(env, request.headers.authorization);
        } catch {
          response.writeHead(401).end();
          return;
        }
        const { contentType, body } = await metrics.render();
        response.writeHead(200, { 'content-type': contentType }).end(body);
        return;
      }
      response.writeHead(404).end();
    })().catch(() => {
      response.writeHead(500).end();
    });
  });
  server.listen(env.WORKER_METRICS_PORT, '0.0.0.0');
}

main().catch((error: unknown) => {
  // Fail fast and visibly; the process supervisor restarts the service.
  console.error('Start-up failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
