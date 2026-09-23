import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiClient } from './support/http.js';
import {
  NOIDA_SECTOR_62,
  deliverWebhook,
  onboardWorkerViaApi,
  runJob,
  sandbox,
} from './support/journey.js';
import { signInWithOtp } from './support/phone-auth.js';
import { createStaff, signInStaff, type StaffMember } from './support/staff.js';
import { createTestApp, createWorld, type TestApp, type World } from './support/world.js';

/**
 * Real-world failures that are not about a single happy path: two people acting at once,
 * phones losing signal, a lost gateway webhook, a restarted server, a crashed background
 * worker, and people poking at other people's records.
 */

type Json = Record<string, unknown>;
type ErrorBody = { error: { code: string } };

let app: TestApp;
let api: ApiClient;
let workerOps: StaffMember;

beforeAll(async () => {
  app = await createTestApp();
  api = new ApiClient(app.http);
  workerOps = await createStaff(app, ['WORKER_OPERATIONS']);
});

afterAll(async () => {
  await app.close();
});

async function noida(workers: number) {
  const world = await createWorld(app.db, {
    workers: 0,
    cityName: 'Noida',
    zoneName: 'Sector 62',
    center: NOIDA_SECTOR_62,
  });
  const onboarded = [];
  for (let i = 0; i < workers; i += 1)
    onboarded.push(await onboardWorkerViaApi(app, api, workerOps, world));
  return {
    world,
    workers: onboarded.map((w) => ({ id: w.workerId, api: api.as(w.session.accessToken) })),
  };
}

async function customerWithAddress(world: World) {
  const session = await signInWithOtp(app, api, 'customer');
  const client = api.as(session.accessToken);
  await client.patch('/customer/me', { fullName: 'Anita Rao' });
  const address = await client.post<Json>(
    '/customer/addresses',
    {
      contactName: 'Anita Rao',
      contactPhone: session.phone,
      houseNumber: 'C-12',
      pincode: world.pincode,
      cityName: 'Noida',
      lat: world.center.lat + 0.002,
      lng: world.center.lng + 0.002,
    },
    { 'idempotency-key': randomUUID() },
  );
  return { session, client, addressId: address.body['id'] as string };
}

function book(client: ApiClient, world: World, addressId: string, hour = 10, key = randomUUID()) {
  return client.post<Json>(
    '/customer/bookings',
    {
      serviceId: world.serviceId,
      addressId,
      bookingType: 'SCHEDULED',
      startAt: world.at(hour).toISOString(),
      expectedTotalPaise: 58_882,
    },
    { 'idempotency-key': key },
  );
}

async function bookAndPay(client: ApiClient, world: World, addressId: string, hour = 10) {
  const booking = await book(client, world, addressId, hour);
  const bookingId = booking.body['id'] as string;
  const pay = await client.post<Json>(`/customer/bookings/${bookingId}/payments`);
  const orderId = (pay.body['checkout'] as Json)['orderId'] as string;
  await deliverWebhook(api, sandbox(app).capture(orderId));
  return { bookingId, paymentId: pay.body['paymentId'] as string };
}

/** The worker holding the offer accepts it; returns that worker's client. */
async function acceptOffer(workers: Array<{ api: ApiClient }>) {
  for (const worker of workers) {
    const offers = await worker.api.get<Json[]>('/worker/offers');
    const offer = offers.body[0];
    if (offer) {
      await worker.api.post(`/worker/offers/${offer['offerId'] as string}/accept`);
      return worker.api;
    }
  }
  throw new Error('no worker received an offer');
}

const history = (bookingId: string) =>
  app.db
    .selectFrom('booking_status_history')
    .select(['event', 'to_status'])
    .where('booking_id', '=', bookingId)
    .orderBy('id')
    .execute();

describe('two staff acting on the same booking', () => {
  async function confirmedBooking() {
    const { world } = await noida(1);
    const { client, addressId } = await customerWithAddress(world);
    const { bookingId } = await bookAndPay(client, world, addressId);
    return { world, bookingId };
  }

  it('acting at the same moment on the same screen: one change wins, the other is told to refresh', async () => {
    const { world, bookingId } = await confirmedBooking();
    const alice = api.as(await signInStaff(api, await createStaff(app, ['OPERATIONS_HEAD'])));
    const bob = api.as(await signInStaff(api, await createStaff(app, ['OPERATIONS_HEAD'])));
    const { version } = (await alice.get<Json>(`/admin/bookings/${bookingId}`)).body;

    const [moved, cancelled] = await Promise.all([
      alice.post<Json & ErrorBody>(`/admin/bookings/${bookingId}/reschedule`, {
        startAt: world.at(12).toISOString(),
        reason: 'Customer asked by phone to move to noon',
        expectedVersion: version,
      }),
      bob.post<Json & ErrorBody>(`/admin/bookings/${bookingId}/cancel`, {
        reason: 'Customer asked by chat to cancel',
        fault: 'CUSTOMER',
        expectedVersion: version,
      }),
    ]);
    const outcomes = [moved, cancelled];
    expect(outcomes.filter((r) => r.status < 300)).toHaveLength(1);
    const loser = outcomes.find((r) => r.status >= 300);
    expect(loser?.status).toBe(409);
    expect(loser?.body.error.code).toBe('STALE_BOOKING');

    // Exactly the winning decision is on record.
    const cancelWon = cancelled.status < 300;
    const events = (await history(bookingId)).map((h) => h.event);
    expect(events.includes('CANCEL')).toBe(cancelWon);
    const changes = await app.db
      .selectFrom('booking_schedule_change')
      .select('id')
      .where('booking_id', '=', bookingId)
      .execute();
    expect(changes).toHaveLength(cancelWon ? 0 : 1);
  });

  it('acting on an out-of-date screen is refused; after a refresh it works', async () => {
    const { bookingId } = await confirmedBooking();
    const alice = api.as(await signInStaff(api, await createStaff(app, ['OPERATIONS_HEAD'])));
    const bob = api.as(await signInStaff(api, await createStaff(app, ['OPERATIONS_HEAD'])));
    const bobsScreen = (await bob.get<Json>(`/admin/bookings/${bookingId}`)).body;

    const held = await alice.post<Json>(`/admin/bookings/${bookingId}/hold`, {
      reason: 'Customer travelling, confirm later',
      expectedVersion: bobsScreen['version'],
    });
    expect(held.status).toBe(200);

    const stale = await bob.post<ErrorBody>(`/admin/bookings/${bookingId}/hold`, {
      reason: 'Pausing while we call the customer',
      expectedVersion: bobsScreen['version'],
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE_BOOKING');

    const fresh = (await bob.get<Json>(`/admin/bookings/${bookingId}`)).body;
    expect(fresh['status']).toBe('ON_HOLD');
    const released = await bob.post<Json>(`/admin/bookings/${bookingId}/release-hold`, {
      reason: 'Customer confirmed by phone',
      expectedVersion: fresh['version'],
    });
    expect(released.status).toBe(200);
  });

  it('every booking intervention must say which version it was based on', async () => {
    const { bookingId } = await confirmedBooking();
    const ops = api.as(await signInStaff(api, await createStaff(app, ['OPERATIONS_HEAD'])));
    for (const action of ['hold', 'redispatch', 'worker-no-show', 'cancel']) {
      const res = await ops.post(`/admin/bookings/${bookingId}/${action}`, {
        reason: 'Missing version check',
        ...(action === 'cancel' ? { fault: 'COMPANY' } : {}),
      });
      expect(res.status, action).toBe(400);
    }
    expect((await ops.get<Json>(`/admin/bookings/${bookingId}`)).body['status']).toBe('CONFIRMED');
  });
});

describe('phones losing signal', () => {
  it('a worker whose app retries each step (response lost) gets success, and nothing happens twice', async () => {
    const { world, workers } = await noida(2);
    const { client, addressId } = await customerWithAddress(world);
    const { bookingId } = await bookAndPay(client, world, addressId);
    const worker = await acceptOffer(workers);
    const other = workers.map((w) => w.api).find((w) => w !== worker)!;
    const code = (await client.get<Json>(`/customer/bookings/${bookingId}/start-code`)).body[
      'code'
    ];

    const steps: Array<[string, Json, string]> = [
      ['en-route', {}, 'EN_ROUTE'],
      ['arrived', {}, 'ARRIVED'],
      ['start', { code }, 'IN_PROGRESS'],
      ['complete', {}, 'COMPLETED'],
    ];
    for (const [step, body, status] of steps) {
      const first = await worker.post<Json>(`/worker/jobs/${bookingId}/${step}`, body);
      const retry = await worker.post<Json>(`/worker/jobs/${bookingId}/${step}`, body);
      expect([first.status, retry.status], step).toEqual([200, 200]);
      expect(retry.body['status'], step).toBe(status);
      // A different worker cannot ride on the replay rule.
      expect((await other.post(`/worker/jobs/${bookingId}/${step}`, body)).status, step).toBe(403);
    }
    const events = (await history(bookingId)).map((h) => h.event);
    for (const event of ['START_TRAVEL', 'MARK_ARRIVED', 'START_SERVICE', 'COMPLETE_SERVICE'])
      expect(
        events.filter((e) => e === event),
        event,
      ).toHaveLength(1);
  });

  it('a retry of an earlier step after the job moved on is still refused', async () => {
    const { world, workers } = await noida(1);
    const { client, addressId } = await customerWithAddress(world);
    const { bookingId } = await bookAndPay(client, world, addressId);
    const worker = await acceptOffer(workers);
    await worker.post(`/worker/jobs/${bookingId}/en-route`);
    await worker.post(`/worker/jobs/${bookingId}/arrived`);
    const late = await worker.post<ErrorBody>(`/worker/jobs/${bookingId}/en-route`);
    expect(late.status).toBe(422);
    expect(late.body.error.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('customer pays, loses signal and the webhook is lost: reopening the app confirms from the gateway', async () => {
    const { world } = await noida(1);
    const { client, addressId } = await customerWithAddress(world);
    const booking = await book(client, world, addressId);
    const bookingId = booking.body['id'] as string;
    const pay = await client.post<Json>(`/customer/bookings/${bookingId}/payments`);
    const orderId = (pay.body['checkout'] as Json)['orderId'] as string;
    const lostWebhook = sandbox(app).capture(orderId); // captured at the gateway, never delivered

    const refreshed = await client.post<Json>(
      `/customer/bookings/${bookingId}/payments/${pay.body['paymentId'] as string}/refresh`,
    );
    expect(refreshed.status).toBe(200);
    expect((refreshed.body['booking'] as Json)['status']).toBe('CONFIRMED');

    // The webhook turning up much later changes nothing.
    expect((await deliverWebhook(api, lostWebhook)).status).toBeLessThan(300);
    const confirmations = (await history(bookingId)).filter((h) => h.to_status === 'CONFIRMED');
    expect(confirmations).toHaveLength(1);
  });
});

describe('Razorpay unreachable', () => {
  it('checkout fails cleanly, nothing is marked paid, and a later attempt succeeds', async () => {
    const { world } = await noida(1);
    const { client, addressId } = await customerWithAddress(world);
    const booking = await book(client, world, addressId);
    const bookingId = booking.body['id'] as string;

    const gateway = sandbox(app);
    const down = vi
      .spyOn(gateway, 'createOrder')
      .mockRejectedValueOnce(new Error('connect ETIMEDOUT api.razorpay.com'));
    const failed = await client.post<ErrorBody>(`/customer/bookings/${bookingId}/payments`);
    expect(failed.status).toBe(422);
    expect(failed.body.error.code).toBe('PAYMENT_GATEWAY_UNAVAILABLE');
    expect((await client.get<Json>(`/customer/bookings/${bookingId}`)).body['status']).toBe(
      'PENDING_PAYMENT',
    );
    down.mockRestore();

    const pay = await client.post<Json>(`/customer/bookings/${bookingId}/payments`);
    expect(pay.status).toBe(201);
    const orderId = (pay.body['checkout'] as Json)['orderId'] as string;
    const captured = gateway.capture(orderId);

    // The gateway is unreachable again when the app asks: the booking is not confirmed on
    // the app's word; the webhook (or the reconciliation job) confirms it later.
    const fetchDown = vi
      .spyOn(gateway, 'fetchOrderStatus')
      .mockRejectedValue(new Error('connect ETIMEDOUT api.razorpay.com'));
    const refresh = await client.post<ErrorBody>(
      `/customer/bookings/${bookingId}/payments/${pay.body['paymentId'] as string}/refresh`,
    );
    expect(refresh.status).toBe(503);
    expect(refresh.body.error.code).toBe('PAYMENT_GATEWAY_UNAVAILABLE');
    expect(refresh.headers['retry-after']).toBe('10');
    expect((await client.get<Json>(`/customer/bookings/${bookingId}`)).body['status']).toBe(
      'PENDING_PAYMENT',
    );
    fetchDown.mockRestore();

    await deliverWebhook(api, captured);
    expect((await client.get<Json>(`/customer/bookings/${bookingId}`)).body['status']).toBe(
      'CONFIRMED',
    );
  });
});

describe('restarts and crashes', () => {
  it('a booking request retried against a restarted server returns the original booking', async () => {
    const { world } = await noida(1);
    const { session, client, addressId } = await customerWithAddress(world);
    const key = randomUUID();
    const first = await book(client, world, addressId, 10, key);
    expect(first.status).toBe(201);

    // A new API process: nothing is remembered in memory, everything in PostgreSQL.
    const restarted = await createTestApp();
    try {
      const again = await new ApiClient(restarted.http).as(session.accessToken).post<Json>(
        '/customer/bookings',
        {
          serviceId: world.serviceId,
          addressId,
          bookingType: 'SCHEDULED',
          startAt: world.at(10).toISOString(),
          expectedTotalPaise: 58_882,
        },
        { 'idempotency-key': key },
      );
      expect(again.body['id']).toBe(first.body['id']);
    } finally {
      await restarted.close();
    }
    const rows = await app.db
      .selectFrom('booking')
      .select('id')
      .where('customer_user_id', '=', session.user.id)
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('a background job held by a crashed process resumes once its lease runs out', async () => {
    await app.db
      .insertInto('job_lease')
      .values({
        job_name: 'release-expired-holds',
        owner: 'crashed-host:4242:deadbeef',
        locked_until: sql<Date>`now() + interval '10 minutes'`,
      })
      .onConflict((oc) =>
        oc.column('job_name').doUpdateSet({
          owner: 'crashed-host:4242:deadbeef',
          locked_until: sql<Date>`now() + interval '10 minutes'`,
        }),
      )
      .execute();
    expect((await runJob(app, 'release-expired-holds')).ran).toBe(false); // never two at once

    await app.db
      .updateTable('job_lease')
      .set({ locked_until: sql<Date>`now() - interval '1 second'` })
      .where('job_name', '=', 'release-expired-holds')
      .execute();
    expect((await runJob(app, 'release-expired-holds')).ran).toBe(true);
  });
});

describe('other people’s records (IDOR)', () => {
  it('a customer cannot see or act on another customer’s booking, address or case', async () => {
    const { world } = await noida(1);
    const owner = await customerWithAddress(world);
    const { bookingId, paymentId } = await bookAndPay(owner.client, world, owner.addressId);
    const intruder = await customerWithAddress(world);
    const c = intruder.client;

    const attempts: Array<[string, () => Promise<{ status: number }>]> = [
      ['booking', () => c.get(`/customer/bookings/${bookingId}`)],
      ['timeline', () => c.get(`/customer/bookings/${bookingId}/timeline`)],
      ['start code', () => c.get(`/customer/bookings/${bookingId}/start-code`)],
      ['invoice', () => c.get(`/customer/bookings/${bookingId}/invoice`)],
      ['pay', () => c.post(`/customer/bookings/${bookingId}/payments`)],
      ['refresh', () => c.post(`/customer/bookings/${bookingId}/payments/${paymentId}/refresh`)],
      ['cancel', () => c.post(`/customer/bookings/${bookingId}/cancel`, { reason: 'Not mine' })],
      [
        'reschedule',
        () =>
          c.post(`/customer/bookings/${bookingId}/reschedule`, {
            startAt: world.at(12).toISOString(),
            reason: 'Not mine',
          }),
      ],
      ['rating', () => c.post(`/customer/bookings/${bookingId}/rating`, { score: 1 })],
      ['archive address', () => c.post(`/customer/addresses/${owner.addressId}/archive`)],
      ['book at their address', () => book(c, world, owner.addressId, 13)],
      [
        'support case on their booking',
        () =>
          c.post(
            '/customer/support-cases',
            {
              bookingId,
              category: 'SERVICE_QUALITY',
              subject: 'Not my booking',
              description: 'Trying to open a case on a booking that is not mine',
            },
            { 'idempotency-key': randomUUID() },
          ),
      ],
    ];
    for (const [name, attempt] of attempts) {
      const res = await attempt();
      expect([403, 404], name).toContain(res.status);
    }
    // Their lists never include the other customer's records.
    expect((await c.get<{ items: Json[] }>('/customer/bookings')).body.items).toEqual([]);
    expect((await c.get<Json[]>('/customer/addresses')).body.map((a) => a['id'])).not.toContain(
      owner.addressId,
    );
    // And nothing changed for the owner.
    expect((await owner.client.get<Json>(`/customer/bookings/${bookingId}`)).body['status']).toBe(
      'CONFIRMED',
    );
  });

  it('a worker cannot read a job offered to or held by someone else', async () => {
    const { world, workers } = await noida(2);
    const { client, addressId } = await customerWithAddress(world);
    const { bookingId } = await bookAndPay(client, world, addressId);
    const holder = await acceptOffer(workers);
    const other = workers.map((w) => w.api).find((w) => w !== holder)!;
    expect([403, 404]).toContain((await other.get(`/worker/jobs/${bookingId}`)).status);
    expect((await holder.get(`/worker/jobs/${bookingId}`)).status).toBe(200);
  });

  it('a customer token cannot reach worker or admin endpoints', async () => {
    const { world } = await noida(0);
    const { client } = await customerWithAddress(world);
    expect([401, 403]).toContain((await client.get('/worker/offers')).status);
    expect([401, 403]).toContain((await client.get('/admin/bookings')).status);
    expect([401, 403]).toContain((await client.get('/admin/config/cities')).status);
  });
});

describe('response headers', () => {
  it('every response forbids framing, sniffing and caching', async () => {
    for (const res of [
      await app.http.inject({ method: 'GET', url: '/api/v1/customer/catalog' }), // 401
      await app.http.inject({ method: 'GET', url: '/api/v1/health/live' }),
    ]) {
      expect(res.headers).toMatchObject({
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-store',
      });
      // HSTS only where TLS terminates in front of the API (staging/production).
      expect(res.headers['strict-transport-security']).toBeUndefined();
    }
  });
});
