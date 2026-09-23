import 'server-only';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ApiError, createApiClient, type ApiClient } from '@onetappe/api-client';
import { clientIpFrom } from './client-ip';
import { adminConfig } from './config';
import {
  clearSession,
  readSession,
  sessionFromTokens,
  writeSession,
  type AdminSession,
} from './session';

async function bffHeaders(): Promise<Record<string, string>> {
  const config = adminConfig();
  const out: Record<string, string> = {};
  if (config.bffSecret) {
    const ip = clientIpFrom((await headers()).get('x-forwarded-for'), config.trustedProxyHops);
    if (ip) {
      out['x-onetappe-bff-key'] = config.bffSecret;
      out['x-onetappe-client-ip'] = ip;
    }
  }
  return out;
}

/** A client without a session (sign-in, invitations). */
export async function anonymousApi(): Promise<ApiClient> {
  return createApiClient({ baseUrl: adminConfig().apiUrl, headers: await bffHeaders() });
}

/**
 * A client for the signed-in staff member. Tokens refreshed during the call are saved
 * when the context allows setting cookies (actions, route handlers); while rendering a
 * page the proxy has already refreshed them.
 */
export async function staffApi(): Promise<{ api: ApiClient; session: AdminSession }> {
  const session = await readSession();
  if (!session) redirect('/login');
  let current: AdminSession = session;
  const api = createApiClient({
    baseUrl: adminConfig().apiUrl,
    headers: await bffHeaders(),
    tokens: {
      get: () => current,
      set: async (tokens) => {
        try {
          if (tokens === null) await clearSession();
          else {
            current = sessionFromTokens(tokens, current.sessionExpiresAt);
            await writeSession(current);
          }
        } catch {
          // Rendering a page: cookies are read-only here; the proxy persists refreshes.
        }
      },
    },
  });
  return { api, session: current };
}

/**
 * Runs an API call for a page or action and turns the cases every screen shares into
 * navigation: signed out → sign-in; a recent authenticator check needed → step-up.
 */
export async function call<T>(work: (api: ApiClient) => Promise<T>, backTo?: string): Promise<T> {
  const { api } = await staffApi();
  backTo ??= (await headers()).get('x-ot-path') ?? '/';
  try {
    return await work(api);
  } catch (error) {
    if (error instanceof ApiError && error.isSignedOut)
      redirect(`/login?next=${encodeURIComponent(backTo)}`);
    if (error instanceof ApiError && error.code === 'MFA_REQUIRED')
      redirect(`/step-up?next=${encodeURIComponent(backTo)}`);
    throw error;
  }
}
