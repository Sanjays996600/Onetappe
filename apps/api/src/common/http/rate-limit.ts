import { createHash } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { TooManyRequestsError } from '../errors.js';

/**
 * Request limits, applied before authentication so a flood never reaches the database.
 *
 * - Signed-in requests are counted per session (a hash of the bearer token), not per IP:
 *   Indian mobile carriers put many people behind one address (CGNAT).
 * - Requests without a token are counted per client IP (OTP has its own, stricter limits).
 * - Actions that create records, move money or reveal personal data have tighter limits.
 *
 * Counters are per API instance; the WAF limits volume at the edge in front of all
 * instances. Health checks, metrics and signed webhooks are not limited here.
 */
export interface RateLimitSettings {
  /** Signed-in requests per session per minute. */
  readonly perSessionPerMinute: number;
  /** Requests without a token per IP per minute. */
  readonly anonymousPerIpPerMinute: number;
  /** Sensitive actions per session per minute. */
  readonly sensitivePerMinute: number;
}

const EXEMPT = [
  /^\/api\/v1\/health\//,
  /^\/api\/v1\/metrics$/,
  /^\/api\/v1\/payments\/webhooks\//,
  /^\/api\/v1\/integrations\/zoho-desk\/webhook$/,
];

/** Route patterns (as registered) whose use is limited more tightly. */
const SENSITIVE = new Set([
  'POST /api/v1/customer/bookings',
  'POST /api/v1/customer/bookings/:id/payments',
  'POST /api/v1/customer/bookings/:id/payments/:paymentId/refresh',
  'POST /api/v1/customer/addresses',
  'POST /api/v1/customer/support-cases',
  'POST /api/v1/worker/support-cases',
  'POST /api/v1/customer/sos',
  'POST /api/v1/worker/sos',
  'POST /api/v1/admin/customers/:id/reveal',
  'POST /api/v1/admin/workers/:id/reveal',
  'POST /api/v1/admin/workers/:id/verifications/:verificationId/document',
  'POST /api/v1/admin/refunds',
]);

const routeOf = (request: FastifyRequest) =>
  `${request.method} ${request.routeOptions.url ?? request.url.split('?')[0] ?? ''}`;

function identity(request: FastifyRequest & { clientIp?: string }): string {
  const auth = request.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return `s:${createHash('sha256').update(auth).digest('base64url').slice(0, 22)}`;
  }
  return `ip:${request.clientIp ?? request.ip}`;
}

export function registerRateLimit(fastify: FastifyInstance, settings: RateLimitSettings): void {
  void fastify.register(rateLimit, {
    global: true,
    hook: 'onRequest',
    timeWindow: 60_000,
    // Bounded memory under an address spray: least recently seen keys are dropped first.
    cache: 50_000,
    allowList: (request) => EXEMPT.some((pattern) => pattern.test(request.url.split('?')[0] ?? '')),
    keyGenerator: (request) => {
      const group = SENSITIVE.has(routeOf(request)) ? 'sensitive' : 'all';
      return `${group}:${identity(request)}`;
    },
    max: (request, key) => {
      if (key.startsWith('sensitive:')) return settings.sensitivePerMinute;
      return key.startsWith('all:s:')
        ? settings.perSessionPerMinute
        : settings.anonymousPerIpPerMinute;
    },
    // Answered by the app's error filter: the usual error shape, request id and Retry-After.
    errorResponseBuilder: (_request, context) =>
      new TooManyRequestsError(Math.max(1, Math.ceil(context.ttl / 1000))),
  });
}
