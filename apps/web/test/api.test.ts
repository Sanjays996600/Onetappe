import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiClient, ApiError, SubmissionKeys, money } from '../src/api.ts';
import type { Tokens } from '../src/types.ts';
const tokens = (expired = false): Tokens => ({
  accessToken: 'access',
  refreshToken: 'refresh-token-with-enough-length',
  accessTokenExpiresAt: new Date(Date.now() + (expired ? -1000 : 600_000)).toISOString(),
  sessionExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
});

void test('concurrent requests share one token rotation and use the new token', async () => {
  let refreshCount = 0;
  const headers: Headers[] = [];
  const client = new ApiClient('/api/v1', async (input, init) => {
    if (typeof input === 'string' && input.endsWith('/auth/refresh')) {
      refreshCount++;
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
      return Response.json({ ...tokens(), accessToken: 'new-access' });
    }
    headers.push(new Headers(init?.headers));
    return Response.json({ ok: true });
  });
  client.setTokens(tokens(true));
  await Promise.all([client.request('/customer/me'), client.request('/customer/addresses')]);
  assert.equal(refreshCount, 1);
  assert.equal(headers.length, 2);
  assert.ok(headers.every((h) => h.get('authorization') === 'Bearer new-access'));
});

void test('an expired session clears authentication and does not submit the mutation', async () => {
  let expired = false;
  let calls = 0;
  const client = new ApiClient(
    '/api/v1',
    () => {
      calls++;
      return Promise.resolve(
        Response.json(
          { error: { code: 'SESSION_REVOKED', message: 'Sign in again' } },
          { status: 401 },
        ),
      );
    },
    () => {
      expired = true;
    },
  );
  client.setTokens(tokens(true));
  await assert.rejects(
    client.request('/customer/bookings', 'POST', { expectedTotalPaise: 50000 }),
    ApiError,
  );
  assert.equal(expired, true);
  assert.equal(calls, 1);
});

void test('uncertain booking response is not automatically repeated; manual retry retains key and body', async () => {
  const seen: { key: string | null; body: BodyInit | null | undefined }[] = [];
  const client = new ApiClient('/api/v1', (_input, init) => {
    seen.push({ key: new Headers(init?.headers).get('Idempotency-Key'), body: init?.body });
    if (seen.length === 1) return Promise.reject(new Error('connection lost after commit'));
    return Promise.resolve(Response.json({ id: 'same-booking', replayed: true }));
  });
  const keys = new SubmissionKeys();
  const body = { expectedTotalPaise: 50000, startAt: '2026-10-01T09:30:00Z' };
  await assert.rejects(
    client.request('/customer/bookings', 'POST', body, keys.for('/bookings', body)),
    /Unable to reach/,
  );
  assert.equal(seen.length, 1);
  const result = await client.request<{ replayed: boolean }>(
    '/customer/bookings',
    'POST',
    body,
    keys.for('/bookings', body),
  );
  assert.equal(result.replayed, true);
  assert.deepEqual(seen[0], seen[1]);
  assert.notEqual(keys.for('/bookings', { ...body, expectedTotalPaise: 60000 }), seen[0]?.key);
});

void test('server validation errors retain support request id', async () => {
  const client = new ApiClient('/api/v1', () =>
    Promise.resolve(
      Response.json(
        {
          error: {
            code: 'NO_AVAILABILITY',
            message: 'No worker available',
            requestId: 'trace-123',
          },
        },
        { status: 409 },
      ),
    ),
  );
  await assert.rejects(
    client.request('/customer/bookings', 'POST', {}),
    (error: unknown) =>
      error instanceof ApiError &&
      error.code === 'NO_AVAILABILITY' &&
      error.requestId === 'trace-123',
  );
});

void test('paise are displayed as rupees without losing paise', () => {
  assert.equal(money(12345), '₹123.45');
});
