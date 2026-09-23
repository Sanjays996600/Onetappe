import { createApiClient, type Tokens } from '@onetappe/api-client';
import type { TestApp } from './world.js';

/** `fetch` that goes straight into the Fastify instance (no network), for the real client. */
export function injectFetch(app: TestApp): typeof fetch {
  return (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const res = await app.http.inject({
      method: (init.method ?? 'GET') as 'GET',
      url: `${url.pathname}${url.search}`,
      headers: init.headers as Record<string, string>,
      ...(init.body === undefined ? {} : { payload: init.body as string }),
    });
    const headers = new Headers();
    for (const [name, value] of Object.entries(res.headers)) {
      if (value !== undefined)
        headers.set(name, Array.isArray(value) ? value.join(', ') : String(value));
    }
    return new Response(res.statusCode === 204 ? null : res.body, {
      status: res.statusCode,
      headers,
    });
  }) as unknown as typeof fetch;
}

/**
 * The shared app client exactly as the apps use it, against the API under test. Any
 * response that does not match the client's schemas fails the test (contract drift).
 */
export function realClient(app: TestApp, initial: Tokens | null = null) {
  let tokens = initial;
  const client = createApiClient({
    baseUrl: 'http://api.test/api/v1',
    fetch: injectFetch(app),
    tokens: { get: () => tokens, set: (next) => void (tokens = next) },
    retryDelaysMs: [],
    onContractMismatch: (m) => {
      throw new Error(
        `API response does not match the client for ${m.method} ${m.path}: ${m.issues}`,
      );
    },
  });
  return Object.assign(client, {
    signIn: (next: Tokens) => void (tokens = next),
    tokens: () => tokens,
  });
}
