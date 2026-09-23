import { NextResponse, type NextRequest } from 'next/server';
import { clientIpFrom } from './server/client-ip';
import { adminConfig } from './server/config';
import {
  sealSession,
  sessionCookieName,
  sessionCookieOptions,
  sessionFromTokens,
  unsealSession,
  type AdminSession,
} from './server/session-codec';

const PUBLIC = ['/login', '/accept-invitation', '/health'];
/** Refresh the access token when it has less than this left, before pages render. */
const REFRESH_AHEAD_MS = 90_000;

function contentSecurityPolicy(nonce: string, dev: boolean): string {
  return [
    "default-src 'self'",
    // Only scripts carrying this response's nonce run (Next adds it to its own scripts).
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${dev ? ' ws:' : ''}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

async function refreshed(
  session: AdminSession,
  request: NextRequest,
): Promise<AdminSession | null> {
  const config = adminConfig();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const ip = clientIpFrom(request.headers.get('x-forwarded-for'), config.trustedProxyHops);
  if (config.bffSecret && ip) {
    headers['x-onetappe-bff-key'] = config.bffSecret;
    headers['x-onetappe-client-ip'] = ip;
  }
  try {
    const res = await fetch(`${config.apiUrl}/auth/refresh`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ refreshToken: session.refreshToken }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const tokens = (await res.json()) as { accessToken: string; refreshToken: string };
    return sessionFromTokens(tokens, session.sessionExpiresAt);
  } catch {
    return session; // API unreachable: keep the session; the page shows the outage.
  }
}

export async function proxy(request: NextRequest) {
  const dev = process.env['NODE_ENV'] !== 'production';
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
  const csp = contentSecurityPolicy(nonce, dev);
  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC.some((p) => path === p || path.startsWith(`${p}/`));

  const cookieName = sessionCookieName();
  let session = unsealSession(request.cookies.get(cookieName)?.value);
  let rotated: AdminSession | null = null;
  if (session && session.accessExpiresAt - Date.now() < REFRESH_AHEAD_MS) {
    const next = await refreshed(session, request);
    if (next !== session) {
      session = next;
      rotated = next;
    }
  }

  if (!session && !isPublic) {
    const login = new URL('/login', request.url);
    if (path !== '/') login.searchParams.set('next', path + request.nextUrl.search);
    const redirect = NextResponse.redirect(login);
    if (request.cookies.has(cookieName))
      redirect.cookies.set(cookieName, '', sessionCookieOptions(0));
    return redirect;
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);
  // Where to come back to after signing in again, for pages that find the session over.
  requestHeaders.set('x-ot-path', path + request.nextUrl.search);
  if (rotated) {
    // Pages rendered for this request read the new tokens.
    request.cookies.set(cookieName, sealSession(rotated));
    requestHeaders.set('cookie', request.cookies.toString());
  }
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', csp);
  response.headers.set('cache-control', 'no-store');
  if (rotated) {
    response.cookies.set(
      cookieName,
      sealSession(rotated),
      sessionCookieOptions(rotated.sessionExpiresAt),
    );
  } else if (!session && request.cookies.has(cookieName)) {
    response.cookies.set(cookieName, '', sessionCookieOptions(0));
  }
  return response;
}

export const config = {
  matcher: [{ source: '/((?!_next/static|_next/image|favicon.ico).*)' }],
};
