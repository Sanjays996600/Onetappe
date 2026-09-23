import 'server-only';

/** Server-side configuration of the admin panel (never sent to the browser). */
export interface AdminConfig {
  /** The API including its version prefix, e.g. https://api.internal/api/v1. */
  readonly apiUrl: string;
  /** 32 random bytes, base64: seals the session cookie. */
  readonly sessionKey: Buffer;
  /** Shared with the API so it accepts the staff member's IP from us. */
  readonly bffSecret: string | null;
  /** Proxies in front of this server that add X-Forwarded-For. */
  readonly trustedProxyHops: number;
  readonly production: boolean;
}

let cached: AdminConfig | undefined;

export function adminConfig(): AdminConfig {
  if (cached) return cached;
  const production = process.env['NODE_ENV'] === 'production';
  const apiUrl = process.env['ADMIN_API_URL'];
  if (!apiUrl) throw new Error('ADMIN_API_URL is not set');
  const key = Buffer.from(process.env['ADMIN_SESSION_SECRET'] ?? '', 'base64');
  if (key.length !== 32) throw new Error('ADMIN_SESSION_SECRET must be 32 random bytes, base64');
  const bffSecret = process.env['BFF_SHARED_SECRET'] ?? null;
  if (bffSecret !== null && bffSecret.length < 32) {
    throw new Error('BFF_SHARED_SECRET must be at least 32 characters');
  }
  const hops = Number(process.env['ADMIN_TRUSTED_PROXY_HOPS'] ?? (production ? 1 : 0));
  if (!Number.isInteger(hops) || hops < 0 || hops > 5) {
    throw new Error('ADMIN_TRUSTED_PROXY_HOPS must be 0–5');
  }
  cached = { apiUrl, sessionKey: key, bffSecret, trustedProxyHops: hops, production };
  return cached;
}
