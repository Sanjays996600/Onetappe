import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { JsonLogger } from './json-logger.js';
import type { Metrics } from './metrics.js';
import { RequestContext } from './request-context.js';

/**
 * Per request: runs the handler inside a correlation context, then writes one access-log
 * line and one latency observation. The route *pattern* is recorded, never the raw URL,
 * so ids, upload tokens and webhook keys in paths or query strings never reach logs or
 * metric labels.
 */
export function registerHttpObservability(
  fastify: FastifyInstance,
  logger: JsonLogger,
  metrics: Metrics,
): void {
  fastify.addHook('onRequest', (request: FastifyRequest & { requestId?: string }, _reply, done) => {
    RequestContext.run({ requestId: request.requestId ?? request.id }, done);
  });

  fastify.addHook(
    'onResponse',
    (request: FastifyRequest & { requestId?: string }, reply: FastifyReply, done) => {
      const route = request.routeOptions.url ?? 'unmatched';
      const status = reply.statusCode;
      const seconds = reply.elapsedTime / 1000;
      metrics.httpDuration.observe(
        { method: request.method, route, status: String(status) },
        seconds,
      );
      // requestId, actor and booking ids come from the correlation context.
      logger.event(status >= 500 ? 'error' : status >= 400 ? 'warn' : 'log', 'request', {
        method: request.method,
        route,
        status,
        durationMs: Math.round(reply.elapsedTime),
      });
      done();
    },
  );
}
