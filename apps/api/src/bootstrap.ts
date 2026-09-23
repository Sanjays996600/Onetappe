import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { AppErrorFilter } from './common/app-error.filter.js';
import { registerRequestId } from './common/http/request-id.js';
import { registerHttpObservability } from './observability/http-observability.js';
import type { JsonLogger } from './observability/json-logger.js';
import type { Metrics } from './observability/metrics.js';
import { APP_LOGGER, METRICS } from './observability/observability.tokens.js';
import { MAX_DOCUMENT_BYTES } from './storage/document-storage.js';
import type { Env } from './config/env.js';

export const API_PREFIX = 'api/v1';

/** Largest JSON body accepted (worker document uploads have their own limit). */
const BODY_LIMIT_BYTES = 1024 * 1024;

export function createAdapter(env: Pick<Env, 'APP_ENV'>): FastifyAdapter {
  return new FastifyAdapter({
    bodyLimit: BODY_LIMIT_BYTES,
    // Behind the load balancer the client IP comes from X-Forwarded-For.
    trustProxy: env.APP_ENV === 'staging' || env.APP_ENV === 'production',
  });
}

/** HTTP configuration shared by the server and the tests. */
export function configureApp(app: INestApplication, env: Pick<Env, 'CORS_ORIGINS'>): void {
  // One version prefix for every client; breaking changes go to /api/v2.
  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalFilters(new AppErrorFilter());
  const fastify = (app as NestFastifyApplication).getHttpAdapter().getInstance();
  registerRequestId(fastify);
  registerHttpObservability(fastify, app.get<JsonLogger>(APP_LOGGER), app.get<Metrics>(METRICS));
  // Document uploads (local storage provider) arrive as raw bytes with their own limit.
  fastify.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: MAX_DOCUMENT_BYTES },
    (_request, body, done) => {
      done(null, body);
    },
  );
  const origins = env.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (origins.length > 0) app.enableCors({ origin: origins, credentials: false });
  app.enableShutdownHooks();
}

export async function createApp(env: Env): Promise<NestFastifyApplication> {
  // rawBody: payment webhooks are verified against the exact bytes received.
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, createAdapter(env), {
    rawBody: true,
    bufferLogs: true,
  });
  app.useLogger(app.get<JsonLogger>(APP_LOGGER));
  configureApp(app, env);
  return app;
}
