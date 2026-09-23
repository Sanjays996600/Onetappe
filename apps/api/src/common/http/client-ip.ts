import { isIP } from 'node:net';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { safeEqual } from '../../security/crypto.js';

export const BFF_KEY_HEADER = 'x-onetappe-bff-key';
export const CLIENT_IP_HEADER = 'x-onetappe-client-ip';

/**
 * The address of the person making the request (used for OTP limits and audit):
 * - normally the connection's address, after the trusted proxy hops (see TRUSTED_PROXY_HOPS);
 * - for staff, whose requests arrive through the admin panel's server, the address that
 *   server vouches for — only with the shared BFF key, so nobody else can set it.
 */
export function registerClientIp(fastify: FastifyInstance, bffSecret: string | undefined): void {
  fastify.addHook('onRequest', (request: FastifyRequest & { clientIp?: string }, _reply, done) => {
    request.clientIp = request.ip;
    const key = request.headers[BFF_KEY_HEADER];
    const vouched = request.headers[CLIENT_IP_HEADER];
    if (
      bffSecret &&
      typeof key === 'string' &&
      safeEqual(key, bffSecret) &&
      typeof vouched === 'string' &&
      isIP(vouched) !== 0
    ) {
      request.clientIp = vouched;
    }
    done();
  });
}

/** Proxy hops trusted for X-Forwarded-For: the load balancer in staging/production. */
export function trustedProxyHops(env: {
  APP_ENV: string;
  TRUSTED_PROXY_HOPS?: number | undefined;
}): number {
  return (
    env.TRUSTED_PROXY_HOPS ?? (env.APP_ENV === 'staging' || env.APP_ENV === 'production' ? 1 : 0)
  );
}
