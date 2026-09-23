import type { Tokens } from '@onetappe/api-client';
import { adminConfig } from './config';
import { jwtExpiry, seal, unseal } from './seal';

export interface AdminSession extends Tokens {
  /** When the access token expires (ms); refreshed shortly before. */
  readonly accessExpiresAt: number;
  /** When the session itself ends (12 h for staff); the cookie lives no longer. */
  readonly sessionExpiresAt: number;
}

// `__Host-` cookies must be Secure, host-only and path=/ (no subdomain can set or read them).
export const sessionCookieName = () =>
  adminConfig().production ? '__Host-ot_session' : 'ot_session';

export function sessionFromTokens(tokens: Tokens, sessionExpiresAt: number): AdminSession {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessExpiresAt: jwtExpiry(tokens.accessToken),
    sessionExpiresAt,
  };
}

export function sealSession(session: AdminSession): string {
  return seal(adminConfig().sessionKey, 'session', session, session.sessionExpiresAt);
}

export function unsealSession(value: string | undefined): AdminSession | null {
  return unseal(adminConfig().sessionKey, 'session', value) as AdminSession | null;
}

/**
 * Attributes for the session cookie. Deleting must repeat them: a browser ignores a
 * Set-Cookie for a `__Host-` cookie that is not Secure, so a plain delete would not work.
 */
export function sessionCookieOptions(expiresAt: number) {
  return {
    httpOnly: true,
    secure: adminConfig().production,
    sameSite: 'strict' as const,
    path: '/',
    expires: new Date(expiresAt),
  };
}
