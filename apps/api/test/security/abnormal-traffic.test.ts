import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../src/common/errors.js';
import { inTransaction } from '../../src/database/transaction.js';
import { ApiClient } from '../support/http.js';
import { deliverWebhook, sandbox } from '../support/journey.js';
import { signInWithOtp, type PhoneSession } from '../support/phone-auth.js';
import { createStaff, signInStaff } from '../support/staff.js';
import {
  createTestApp,
  createWorld,
  customerContext,
  SYSTEM,
  type TestApp,
  type World,
} from '../support/world.js';

/**
 * Abnormal traffic: bursts, double taps and people acting on the same booking at the same
 * moment. Whatever the interleaving, the outcome must be one consistent state — never a
 * double booking, a second payment order, a 500, or history that disagrees with the row.
 */

type Json = Record<string, unknown>;

let app: TestApp;
let api: ApiClient;

beforeAll(async () => {
  app = await createTestApp();
  api = new ApiClient(app.http);
});

afterAll(async () => {
  await app.close();
});

async function overlappingReservations(): Promise<number> {
  const { rows } = await sql<{ n: number }>`
    SELECT count(*)::int AS n
    FROM worker_reservation a
    JOIN worker_reservation b
      ON a.worker_id = b.worker_id AND a.id < b.id AND a.period && b.period
    WHERE a.status IN ('HELD', 'ALLOCATED', 'ACCEPTED')
      AND b.status IN ('HELD', 'ALLOCATED', 'ACCEPTED')
  `.execute(app.db);
  return rows[0]?.n ?? -1;
}

/** The booking row and its latest status history entry always agree. */
async function historyMatches(bookingId: string) {
  const booking = await app.db
    .selectFrom('booking')
    .select('status')
    .where('id', '=', bookingId)
    .executeTakeFirstOrThrow();
  const last = await app.db
    .selectFrom('booking_status_history')
    .select('to_status')
    .where('booking_id', '=', bookingId)
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirstOrThrow();
  return { status: booking.status, history: last.to_status };
}

async function bookAndPay(world: World, customer: PhoneSession, hour: number) {
  const c = api.as(customer.accessToken);
  const address = await c.post<Json>(
    '/customer/addresses',
    {
      contactName: 'Test',
      contactPhone: customer.phone,
      houseNumber: '1',
      pincode: world.pincode,
      cityName: 'Noida',
      lat: world.center.lat,
      lng: world.center.lng,
    },
    { 'idempotency-key': randomUUID() },
  );
  const booking = await c.post<Json>(
    '/customer/bookings',
    {
      serviceId: world.serviceId,
      addressId: address.body['id'],
      bookingType: 'SCHEDULED',
      startAt: world.at(hour).toISOString(),
      expectedTotalPaise: 58_882,
    },
    { 'idempotency-key': randomUUID() },
  );
  const id = booking.body['id'] as string;
  const pay = await c.post<Json>(`/customer/bookings/${id}/payments`);
  await deliverWebhook(
    api,
    sandbox(app).capture((pay.body['checkout'] as Json)['orderId'] as string),
  );
  return id;
}

describe('bursts', () => {
  it('forty customers, five workers, one time slot: five bookings and no overlap anywhere', async () => {
    const world = await createWorld(app.db, { workers: 5 });
    const customers = await Promise.all(Array.from({ length: 40 }, () => world.customer()));
    const results = await Promise.allSettled(
      customers.map((c) =>
        app.creation.create(world.bookingInput(c, world.at(13)), customerContext(c.userId)),
      ),
    );
    const failures = results.filter((r) => r.status === 'rejected');
    for (const f of failures) {
      // Every refusal is the business answer, never a crash.
      expect(f.reason).toBeInstanceOf(AppError);
      expect((f.reason as AppError).code).toBe('NO_AVAILABILITY');
    }
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    expect(await overlappingReservations()).toBe(0);
  });
});

describe('double taps and races through the API', () => {
  it('Pay pressed twice at once: one gateway order, the same payment for both taps', async () => {
    const world = await createWorld(app.db, { workers: 1 });
    const customer = await signInWithOtp(app, api, 'customer');
    const c = api.as(customer.accessToken);
    const address = await c.post<Json>(
      '/customer/addresses',
      {
        contactName: 'Test',
        contactPhone: customer.phone,
        houseNumber: '1',
        pincode: world.pincode,
        cityName: 'Noida',
        lat: world.center.lat,
        lng: world.center.lng,
      },
      { 'idempotency-key': randomUUID() },
    );
    const booking = await c.post<Json>(
      '/customer/bookings',
      {
        serviceId: world.serviceId,
        addressId: address.body['id'],
        bookingType: 'SCHEDULED',
        startAt: world.at(10).toISOString(),
        expectedTotalPaise: 58_882,
      },
      { 'idempotency-key': randomUUID() },
    );
    const id = booking.body['id'] as string;
    const [first, second] = await Promise.all([
      c.post<Json>(`/customer/bookings/${id}/payments`),
      c.post<Json>(`/customer/bookings/${id}/payments`),
    ]);
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(first.body['paymentId']).toBe(second.body['paymentId']);
    const orders = await app.db
      .selectFrom('payment')
      .select('id')
      .where('booking_id', '=', id)
      .execute();
    expect(orders).toHaveLength(1);
  });

  it('a payment start that died half-way (process crash) does not block paying', async () => {
    const world = await createWorld(app.db, { workers: 1 });
    const customer = await signInWithOtp(app, api, 'customer');
    const c = api.as(customer.accessToken);
    const address = await c.post<Json>(
      '/customer/addresses',
      {
        contactName: 'Test',
        contactPhone: customer.phone,
        houseNumber: '1',
        pincode: world.pincode,
        cityName: 'Noida',
        lat: world.center.lat,
        lng: world.center.lng,
      },
      { 'idempotency-key': randomUUID() },
    );
    const booking = await c.post<Json>(
      '/customer/bookings',
      {
        serviceId: world.serviceId,
        addressId: address.body['id'],
        bookingType: 'SCHEDULED',
        startAt: world.at(15).toISOString(),
        expectedTotalPaise: 58_882,
      },
      { 'idempotency-key': randomUUID() },
    );
    const id = booking.body['id'] as string;
    // Recorded two minutes ago, but the gateway order was never created.
    const stuck = await inTransaction(app.db, SYSTEM, (tx) =>
      tx
        .insertInto('payment')
        .values({
          booking_id: id,
          provider: 'SANDBOX',
          amount_paise: 58_882,
          idempotency_key: `order:${id}:${randomUUID()}`,
          created_at: new Date(Date.now() - 120_000),
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    const pay = await c.post<Json>(`/customer/bookings/${id}/payments`);
    expect(pay.status).toBe(201);
    expect(pay.body['paymentId']).not.toBe(stuck.id);
    const old = await app.db
      .selectFrom('payment')
      .select(['status', 'failure_reason'])
      .where('id', '=', stuck.id)
      .executeTakeFirstOrThrow();
    expect(old).toEqual({ status: 'FAILED', failure_reason: 'Gateway order creation abandoned' });
  });

  it('the customer cancels while the worker accepts: one consistent outcome, the worker is free', async () => {
    const world = await createWorld(app.db, { workers: 1 });
    const customer = await signInWithOtp(app, api, 'customer');
    const bookingId = await bookAndPay(world, customer, 11);
    const offer = await app.db
      .selectFrom('booking_assignment')
      .select(['id', 'worker_id'])
      .where('booking_id', '=', bookingId)
      .where('status', '=', 'OFFERED')
      .executeTakeFirstOrThrow();
    const phone = await app.db
      .selectFrom('app_user')
      .select('phone_e164')
      .where('id', '=', offer.worker_id)
      .executeTakeFirstOrThrow();
    const worker = await signInWithOtp(app, api, 'worker', phone.phone_e164 ?? '');

    const [cancel, accept] = await Promise.all([
      api
        .as(customer.accessToken)
        .post(`/customer/bookings/${bookingId}/cancel`, { reason: 'Plans changed' }),
      api.as(worker.accessToken).post(`/worker/offers/${offer.id}/accept`),
    ]);
    expect(cancel.status).toBeLessThan(500);
    expect(accept.status).toBeLessThan(500);
    expect(cancel.status).toBe(200);
    expect(await historyMatches(bookingId)).toEqual({ status: 'CANCELLED', history: 'CANCELLED' });
    // Whatever the order, the worker ends up without the job and without a held slot.
    const active = await app.db
      .selectFrom('worker_reservation')
      .select('id')
      .where('booking_id', '=', bookingId)
      .where('status', 'in', ['HELD', 'ALLOCATED', 'ACCEPTED'])
      .execute();
    expect(active).toHaveLength(0);
    expect((await api.as(worker.accessToken).get('/worker/jobs/current')).body).toBeNull();
  });

  it('operations holds a booking while the customer cancels it: no crash, history agrees', async () => {
    const world = await createWorld(app.db, { workers: 1 });
    const customer = await signInWithOtp(app, api, 'customer');
    const bookingId = await bookAndPay(world, customer, 12);
    const ops = await signInStaff(api, await createStaff(app, ['OPERATIONS_HEAD']));
    const detail = await api.as(ops).get<Json>(`/admin/bookings/${bookingId}`);
    const [hold, cancel] = await Promise.all([
      api.as(ops).post(`/admin/bookings/${bookingId}/hold`, {
        reason: 'Checking with the customer',
        expectedVersion: detail.body['version'],
      }),
      api
        .as(customer.accessToken)
        .post(`/customer/bookings/${bookingId}/cancel`, { reason: 'Not needed' }),
    ]);
    expect(hold.status).toBeLessThan(500);
    expect(cancel.status).toBeLessThan(500);
    // At least one of them happened, and the record is coherent.
    expect([hold.status, cancel.status]).toContain(200);
    const result = await historyMatches(bookingId);
    expect(result.status).toBe(result.history);
    expect(['ON_HOLD', 'CANCELLED']).toContain(result.status);
  });
});
