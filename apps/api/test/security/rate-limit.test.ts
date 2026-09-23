import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient } from '../support/http.js';
import { signInWithOtp, type PhoneSession } from '../support/phone-auth.js';
import { createTestApp, type TestApp } from '../support/world.js';

/**
 * Request limits: per session when signed in (many people share one mobile-carrier IP),
 * per IP otherwise, tighter for actions that create records or reveal data, and never
 * for health checks or signed webhooks. Over the limit: 429 RATE_LIMITED + Retry-After.
 */

let app: TestApp;
let api: ApiClient;
let alice: PhoneSession;
let bob: PhoneSession;

const PER_SESSION = 30;
const ANONYMOUS = 10;
const SENSITIVE = 5;

beforeAll(async () => {
  app = await createTestApp({
    RATE_LIMIT_PER_SESSION_PER_MINUTE: String(PER_SESSION),
    RATE_LIMIT_ANONYMOUS_PER_MINUTE: String(ANONYMOUS),
    RATE_LIMIT_SENSITIVE_PER_MINUTE: String(SENSITIVE),
  });
  api = new ApiClient(app.http);
  alice = await signInWithOtp(app, api, 'customer');
  bob = await signInWithOtp(app, api, 'customer');
});

afterAll(async () => {
  await app.close();
});

function get(url: string, options: { token?: string; ip?: string } = {}) {
  return app.http.inject({
    method: 'GET',
    url: `/api/v1${url}`,
    remoteAddress: options.ip ?? '127.0.0.1',
    headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
  });
}

describe('request limits', () => {
  it('limits requests without a token per IP, with a clear answer and Retry-After', async () => {
    const ip = '203.0.113.7';
    for (let i = 0; i < ANONYMOUS; i++) {
      expect((await get('/legal/documents?app=CUSTOMER_APP', { ip })).statusCode).toBe(200);
    }
    const limited = await get('/legal/documents?app=CUSTOMER_APP', { ip });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    const body = limited.json<{ error: { code: string; requestId: string; details: Json } }>();
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.requestId).toBe(limited.headers['x-request-id']);
    // Another address is unaffected.
    expect((await get('/legal/documents?app=CUSTOMER_APP', { ip: '203.0.113.8' })).statusCode).toBe(
      200,
    );
  });

  it('counts signed-in requests per session, so people sharing an IP do not block each other', async () => {
    for (let i = 0; i < PER_SESSION; i++) {
      expect((await get('/customer/me', { token: alice.accessToken })).statusCode).toBe(200);
    }
    expect((await get('/customer/me', { token: alice.accessToken })).statusCode).toBe(429);
    // Bob, on the same address, carries on.
    expect((await get('/customer/me', { token: bob.accessToken })).statusCode).toBe(200);
  });

  it('limits actions that create records more tightly, separately from browsing', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < SENSITIVE + 1; i++) {
      const res = await api.as(bob.accessToken).post(
        '/customer/support-cases',
        {
          category: 'OTHER',
          subject: `Question ${String(i)}`,
          description: 'A question about the app',
        },
        { 'idempotency-key': randomUUID() },
      );
      statuses.push(res.status);
    }
    expect(statuses.slice(0, SENSITIVE).every((s) => s === 201)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    expect((await get('/customer/me', { token: bob.accessToken })).statusCode).toBe(200);
  });

  it('never limits health checks or signed payment webhooks', async () => {
    const ip = '203.0.113.20';
    for (let i = 0; i < ANONYMOUS * 3; i++) {
      expect((await get('/health/live', { ip })).statusCode).toBe(200);
    }
    for (let i = 0; i < ANONYMOUS + 2; i++) {
      const res = await app.http.inject({
        method: 'POST',
        url: '/api/v1/payments/webhooks/sandbox',
        remoteAddress: ip,
        payload: '{}',
        headers: { 'content-type': 'application/json' },
      });
      // Refused for its bad signature, never for volume.
      expect(res.statusCode).not.toBe(429);
    }
  });
});

type Json = Record<string, unknown>;
