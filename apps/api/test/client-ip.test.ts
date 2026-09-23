import { afterAll, describe, expect, it } from 'vitest';
import { randomMobile } from './support/phone-auth.js';
import { createTestApp, type TestApp } from './support/world.js';

/**
 * The client IP drives the OTP per-IP limit and the audit trail, so it must not be
 * something a caller can simply claim.
 */

const apps: TestApp[] = [];
afterAll(async () => {
  for (const app of apps) await app.close();
});

async function ipRecordedFor(
  app: TestApp,
  request: { remoteAddress: string; headers?: Record<string, string> },
): Promise<string | null> {
  const phone = randomMobile();
  const res = await app.http.inject({
    method: 'POST',
    url: '/api/v1/customer/auth/otp',
    remoteAddress: request.remoteAddress,
    headers: { 'content-type': 'application/json', ...request.headers },
    payload: JSON.stringify({ phone }),
  });
  expect(res.statusCode).toBe(200);
  const row = await app.db
    .selectFrom('otp_challenge')
    .select('request_ip')
    .where('id', '=', (JSON.parse(res.body) as { challengeId: string }).challengeId)
    .executeTakeFirstOrThrow();
  return row.request_ip;
}

describe('client IP', () => {
  it('behind one load balancer, only the address it added is trusted', async () => {
    const app = await createTestApp({ TRUSTED_PROXY_HOPS: '1' });
    apps.push(app);
    const ip = await ipRecordedFor(app, {
      remoteAddress: '10.0.0.5', // the load balancer
      headers: { 'x-forwarded-for': '198.51.100.66, 203.0.113.9' }, // spoofed, real
    });
    expect(ip).toBe('203.0.113.9');
  });

  it('without trusted proxies, X-Forwarded-For is ignored', async () => {
    const app = await createTestApp({ TRUSTED_PROXY_HOPS: '0' });
    apps.push(app);
    const ip = await ipRecordedFor(app, {
      remoteAddress: '203.0.113.20',
      headers: { 'x-forwarded-for': '198.51.100.66' },
    });
    expect(ip).toBe('203.0.113.20');
  });

  it('the admin panel server may vouch for the staff member IP only with the shared key', async () => {
    const secret = 'bff-shared-secret-0123456789-abcdefghij';
    const app = await createTestApp({ BFF_SHARED_SECRET: secret });
    apps.push(app);
    const vouched = (key: string, clientIp: string) =>
      ipRecordedFor(app, {
        remoteAddress: '10.0.0.9',
        headers: { 'x-onetappe-bff-key': key, 'x-onetappe-client-ip': clientIp },
      });
    expect(await vouched(secret, '203.0.113.44')).toBe('203.0.113.44');
    expect(await vouched('wrong-key-0123456789-0123456789-xyz', '203.0.113.44')).toBe('10.0.0.9');
    expect(await vouched(secret, 'not-an-ip')).toBe('10.0.0.9');
  });
});
