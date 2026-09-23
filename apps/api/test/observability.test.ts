import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JsonLogger } from '../src/observability/json-logger.js';
import { APP_LOGGER } from '../src/observability/observability.tokens.js';
import { ApiClient } from './support/http.js';
import { deliverWebhook, sandbox } from './support/journey.js';
import { signInWithOtp } from './support/phone-auth.js';
import { createStaff, signInStaff } from './support/staff.js';
import { createTestApp, createWorld, type TestApp, type World } from './support/world.js';

type Json = Record<string, unknown>;

let app: TestApp;
let api: ApiClient;
let world: World;
const lines: Json[] = [];

beforeAll(async () => {
  app = await createTestApp({ LOG_LEVEL: 'info' });
  api = new ApiClient(app.http);
  world = await createWorld(app.db, { workers: 2 });
  app.http.get<JsonLogger>(APP_LOGGER).sink = {
    write: (line) => {
      lines.push(JSON.parse(line) as Json);
    },
  };
});

afterAll(async () => {
  await app.close();
});

let nextHour = 9;
async function paidBooking() {
  nextHour += 2;
  const session = await signInWithOtp(app, api, 'customer');
  const client = api.as(session.accessToken);
  const address = await client.post<Json>(
    '/customer/addresses',
    {
      contactName: 'Sameer Khan',
      contactPhone: session.phone,
      houseNumber: 'G-2',
      pincode: world.pincode,
      cityName: 'Noida',
      lat: world.center.lat,
      lng: world.center.lng,
    },
    { 'idempotency-key': randomUUID() },
  );
  const booking = await client.post<Json>(
    '/customer/bookings',
    {
      serviceId: world.serviceId,
      addressId: address.body['id'],
      bookingType: 'SCHEDULED',
      startAt: world.at(nextHour).toISOString(),
      expectedTotalPaise: 58_882,
    },
    { 'idempotency-key': randomUUID() },
  );
  const bookingId = booking.body['id'] as string;
  const pay = await client.post<Json>(`/customer/bookings/${bookingId}/payments`);
  await deliverWebhook(
    api,
    sandbox(app).capture((pay.body['checkout'] as Json)['orderId'] as string),
  );
  return { session, client, bookingId };
}

describe('structured access log', () => {
  it('logs the route pattern, status, duration and request id — never ids from the URL or personal data', async () => {
    const { session, client, bookingId } = await paidBooking();
    lines.length = 0;
    const res = await client.get(`/customer/bookings/${bookingId}`, {
      'x-request-id': 'trace-me-123',
    });
    expect(res.status).toBe(200);

    const access = lines.find((l) => l['msg'] === 'request' && l['requestId'] === 'trace-me-123');
    expect(access).toMatchObject({
      level: 'info',
      method: 'GET',
      route: '/api/v1/customer/bookings/:id',
      status: 200,
      actorUserId: session.user.id,
    });
    expect(typeof access?.['durationMs']).toBe('number');
    const everything = JSON.stringify(lines);
    expect(everything).not.toContain(bookingId);
    expect(everything).not.toContain(session.phone.slice(-10));
  });

  it('does not log OTP request bodies (phone numbers)', async () => {
    lines.length = 0;
    const phone = `9${String(Date.now()).slice(-9)}`;
    await api.post('/customer/auth/otp', { phone });
    expect(JSON.stringify(lines)).not.toContain(phone);
  });
});

describe('metrics', () => {
  it('exposes request latency and database-backed backlog gauges', async () => {
    const res = await app.http.inject({ method: 'GET', url: '/api/v1/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('onetappe_http_request_duration_seconds_bucket');
    expect(res.body).toContain('route="/api/v1/customer/bookings/:id"');
    expect(res.body).toContain('onetappe_backlog{');
    expect(res.body).toContain('onetappe_integration_paused{');
  });

  it('requires the metrics token when one is configured', async () => {
    const guarded = await createTestApp({ METRICS_TOKEN: 'metrics-token-0123456789-abcdefghijkl' });
    try {
      const anonymous = await guarded.http.inject({ method: 'GET', url: '/api/v1/metrics' });
      expect(anonymous.statusCode).toBe(401);
      const wrong = await guarded.http.inject({
        method: 'GET',
        url: '/api/v1/metrics',
        headers: { authorization: 'Bearer wrong' },
      });
      expect(wrong.statusCode).toBe(401);
      const ok = await guarded.http.inject({
        method: 'GET',
        url: '/api/v1/metrics',
        headers: { authorization: 'Bearer metrics-token-0123456789-abcdefghijkl' },
      });
      expect(ok.statusCode).toBe(200);
    } finally {
      await guarded.close();
    }
  });
});

describe('booking trace', () => {
  it('shows the booking across status, payment, gateway and notifications with request ids, without personal data', async () => {
    const { session, bookingId } = await paidBooking();
    const ops = await createStaff(app, ['OPERATIONS_HEAD']);
    const res = await api
      .as(await signInStaff(api, ops))
      .get<{ entries: Json[] }>(`/admin/bookings/${bookingId}/trace`);
    expect(res.status).toBe(200);
    const areas = new Set(res.body.entries.map((e) => e['area']));
    for (const area of ['status', 'payment', 'gateway', 'notification', 'assignment']) {
      expect(areas).toContain(area);
    }
    const statusEntries = res.body.entries.filter((e) => e['area'] === 'status');
    expect(statusEntries.every((e) => typeof e['requestId'] === 'string')).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(session.phone.slice(-10));
    // Operations head has no payment.read: amounts are not shown.
    const payment = res.body.entries.find((e) => e['area'] === 'payment');
    expect(payment?.['detail']).not.toHaveProperty('amountPaise');
  });

  it('shows money details only with payment.read', async () => {
    const { bookingId } = await paidBooking();
    const finance = await createStaff(app, ['FINANCE']);
    const res = await api
      .as(await signInStaff(api, finance))
      .get<{ entries: Json[] }>(`/admin/bookings/${bookingId}/trace`);
    const payment = res.body.entries.find((e) => e['area'] === 'payment');
    expect(payment?.['detail']).toHaveProperty('amountPaise', 58_882);
  });
});

describe('system status', () => {
  it('reports jobs, backlog, integrations and alerts to permitted staff only', async () => {
    const ops = await createStaff(app, ['OPERATIONS_HEAD']);
    const res = await api.as(await signInStaff(api, ops)).get<Json>('/admin/system/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ database: { ok: true } });
    expect(Array.isArray(res.body['jobs'])).toBe(true);
    // No worker process runs in this test, so the jobs are reported stale.
    const alerts = res.body['alerts'] as Json[];
    expect(alerts.some((a) => a['code'] === 'JOB_STALE' && a['severity'] === 'critical')).toBe(
      true,
    );

    const dispatcher = await createStaff(app, ['DISPATCHER']);
    const denied = await api.as(await signInStaff(api, dispatcher)).get('/admin/system/status');
    expect(denied.status).toBe(403);
  });
});
