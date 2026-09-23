import { Global, Module } from '@nestjs/common';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { JsonLogger } from './json-logger.js';
import { Metrics } from './metrics.js';
import { MetricsController } from './metrics.controller.js';
import { MetricsService } from './metrics.service.js';
import { APP_LOGGER, METRICS } from './observability.tokens.js';

export function processRole(): string {
  return process.env['ONETAPPE_PROCESS'] ?? 'api';
}

@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    { provide: METRICS, useFactory: () => new Metrics(processRole()) },
    {
      provide: APP_LOGGER,
      inject: [ENV],
      useFactory: (env: Env) => new JsonLogger(processRole(), env.LOG_LEVEL),
    },
    MetricsService,
  ],
  exports: [METRICS, APP_LOGGER, MetricsService],
})
export class ObservabilityModule {}
