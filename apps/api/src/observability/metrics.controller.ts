import { Controller, Get, Headers, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public } from '../auth/decorators.js';
import { NotFoundError, UnauthorizedError } from '../common/errors.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { safeEqual } from '../security/crypto.js';
import { MetricsService } from './metrics.service.js';

/**
 * Prometheus scrape endpoint. Not a user API: it needs the METRICS_TOKEN bearer token
 * (outside local/test) and is meant to be reachable only from the monitoring network.
 */
@Controller('metrics')
@Public()
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get()
  async scrape(
    @Headers('authorization') authorization: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    authorizeScrape(this.env, authorization);
    const { contentType, body } = await this.metrics.render();
    await reply.header('content-type', contentType).send(body);
  }
}

export function authorizeScrape(env: Env, authorization: string | undefined): void {
  const expected = env.METRICS_TOKEN;
  if (!expected) {
    // Only local/test may run without a token (enforced by the environment schema).
    if (!['local', 'test'].includes(env.APP_ENV)) throw new NotFoundError('Route', 'metrics');
    return;
  }
  const presented = /^Bearer (.+)$/.exec(authorization ?? '')?.[1];
  if (!presented || !safeEqual(presented, expected)) {
    throw new UnauthorizedError('METRICS_TOKEN_INVALID', 'A valid metrics token is required');
  }
}
