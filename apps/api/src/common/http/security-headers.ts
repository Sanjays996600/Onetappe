import type { FastifyInstance } from 'fastify';

/**
 * Defensive headers on every response. The API only serves JSON (and staff-only document
 * downloads), so nothing may be framed, sniffed, cached or run as a page. A route that
 * sets one of these itself (e.g. the sandboxed document download) keeps its own value.
 */
const DEFAULTS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-site',
  // Responses carry personal data: never stored by browsers or shared caches.
  'cache-control': 'no-store',
};

export function registerSecurityHeaders(
  fastify: FastifyInstance,
  options: { hsts: boolean },
): void {
  const headers: Record<string, string> = { ...DEFAULTS };
  // Only where TLS is terminated in front of the API; browsers then refuse plain HTTP.
  if (options.hsts) headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  fastify.addHook('onSend', (_request, reply, payload, done) => {
    for (const [name, value] of Object.entries(headers)) {
      if (!reply.hasHeader(name)) void reply.header(name, value);
    }
    done(null, payload);
  });
}
