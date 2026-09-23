import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiError } from './errors.js';
import { HttpClient, type Tokens } from './http.js';

type Handler = (req: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}) =>
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | Promise<{ status: number; body?: unknown; headers?: Record<string, string> }>;

function fakeFetch(handler: Handler) {
  const calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
  }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    const req = {
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: init.body ? (JSON.parse(init.body as string) as unknown) : undefined,
    };
    calls.push(req);
    const res = await handler(req);
    return new Response(res.body === undefined ? null : JSON.stringify(res.body), {
      status: res.status,
      headers: res.headers,
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function memoryStore(initial: Tokens | null) {
  let tokens = initial;
  return {
    get: () => tokens,
    set: (next: Tokens | null) => {
      tokens = next;
    },
    current: () => tokens,
  };
}

const Ok = z.object({ ok: z.boolean() });
const error = (status: number, code: string, headers?: Record<string, string>) => ({
  status,
  body: { error: { code, message: code, details: {}, requestId: 'req-1' } },
  headers,
});

describe('HttpClient', () => {
  it('sends the access token and parses API errors', async () => {
    const { impl, calls } = fakeFetch(() => error(422, 'NO_AVAILABILITY'));
    const http = new HttpClient({
      baseUrl: 'https://api.test/api/v1',
      fetch: impl,
      tokens: memoryStore({ accessToken: 'a1', refreshToken: 'r1' }),
    });
    const failure = await http.request(Ok, 'POST', '/x', { body: {} }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 422, code: 'NO_AVAILABILITY', requestId: 'req-1' });
    expect(calls[0]?.headers['authorization']).toBe('Bearer a1');
  });

  it('refreshes an expired token once for concurrent calls, then retries them', async () => {
    let refreshes = 0;
    const { impl } = fakeFetch(async (req) => {
      if (req.url.endsWith('/auth/refresh')) {
        refreshes += 1;
        await new Promise((r) => setTimeout(r, 10));
        return { status: 200, body: { accessToken: 'a2', refreshToken: 'r2' } };
      }
      return req.headers['authorization'] === 'Bearer a2'
        ? { status: 200, body: { ok: true } }
        : error(401, 'TOKEN_EXPIRED');
    });
    const store = memoryStore({ accessToken: 'a1', refreshToken: 'r1' });
    const http = new HttpClient({ baseUrl: 'https://api.test', fetch: impl, tokens: store });
    const results = await Promise.all([1, 2, 3].map(() => http.request(Ok, 'GET', '/me')));
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(refreshes).toBe(1);
    expect(store.current()).toEqual({ accessToken: 'a2', refreshToken: 'r2' });
  });

  it('signs out when the refresh is refused, but not on a wrong MFA code', async () => {
    const { impl } = fakeFetch((req) =>
      req.url.endsWith('/auth/refresh')
        ? error(401, 'SESSION_REVOKED')
        : req.url.endsWith('/step-up')
          ? error(401, 'MFA_INVALID')
          : error(401, 'TOKEN_EXPIRED'),
    );
    const store = memoryStore({ accessToken: 'a1', refreshToken: 'r1' });
    const http = new HttpClient({ baseUrl: 'https://api.test', fetch: impl, tokens: store });
    await expect(http.request(Ok, 'POST', '/auth/staff/step-up', {})).rejects.toMatchObject({
      code: 'MFA_INVALID',
    });
    expect(store.current()).not.toBeNull();
    await expect(http.request(Ok, 'GET', '/me')).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });
    expect(store.current()).toBeNull();
  });

  it('retries idempotent requests on 503 with the same key; never a plain POST', async () => {
    let n = 0;
    const { impl, calls } = fakeFetch(() =>
      (n += 1) < 3
        ? error(503, 'TEMPORARILY_UNAVAILABLE', { 'retry-after': '0' })
        : { status: 200, body: { ok: true } },
    );
    const http = new HttpClient({
      baseUrl: 'https://api.test',
      fetch: impl,
      retryDelaysMs: [1, 1],
    });
    await expect(
      http.request(Ok, 'POST', '/bookings', { body: {}, idempotencyKey: 'key-1' }),
    ).resolves.toEqual({ ok: true });
    expect(calls.map((c) => c.headers['idempotency-key'])).toEqual(['key-1', 'key-1', 'key-1']);

    n = 0;
    calls.length = 0;
    await expect(http.request(Ok, 'POST', '/cancel', { body: {} })).rejects.toMatchObject({
      status: 503,
    });
    expect(calls).toHaveLength(1);
  });

  it('reports a timeout and a network failure as client errors', async () => {
    const slow = fakeFetch(() => new Promise(() => undefined));
    const http = new HttpClient({
      baseUrl: 'https://api.test',
      fetch: ((url: string, init: RequestInit) =>
        new Promise((_, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
          void slow.impl(url, init);
        })) as unknown as typeof fetch,
      timeoutMs: 20,
      retryDelaysMs: [],
    });
    await expect(http.request(Ok, 'GET', '/slow')).rejects.toMatchObject({
      code: 'TIMEOUT',
      status: 0,
    });

    const offline = new HttpClient({
      baseUrl: 'https://api.test',
      fetch: () => Promise.reject(new TypeError('Network request failed')),
      retryDelaysMs: [],
    });
    await expect(offline.request(Ok, 'GET', '/x')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('reports responses that do not match the expected shape', async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: { ok: 'yes' } }));
    const mismatches: string[] = [];
    const http = new HttpClient({
      baseUrl: 'https://api.test',
      fetch: impl,
      onContractMismatch: (m) => mismatches.push(`${m.method} ${m.path}`),
    });
    await expect(http.request(Ok, 'GET', '/x')).resolves.toEqual({ ok: 'yes' });
    expect(mismatches).toEqual(['GET /x']);
  });
});
