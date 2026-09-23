import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient } from './support/http.js';
import { signInWithOtp } from './support/phone-auth.js';
import {
  createTestApp,
  createWorld,
  customerContext,
  type TestApp,
  type World,
} from './support/world.js';

type Json = Record<string, unknown>;
type ErrorBody = { error: { code: string } };

let app: TestApp;
let api: ApiClient;
let world: World;

beforeAll(async () => {
  app = await createTestApp();
  api = new ApiClient(app.http);
  world = await createWorld(app.db, { workers: 4 });
});

afterAll(async () => {
  await app.close();
});

/** A signed-in customer with a saved address and one booking. */
async function customerWithBooking(hour: number) {
  const session = await signInWithOtp(app, api, 'customer');
  const client = api.as(session.accessToken);
  const address = await client.post<Json>(
    '/customer/addresses',
    {
      contactName: 'Meera Joshi',
      contactPhone: session.phone,
      houseNumber: 'D-12',
      pincode: world.pincode,
      cityName: 'Noida',
      lat: world.center.lat + 0.001,
      lng: world.center.lng + 0.001,
    },
    { 'idempotency-key': randomUUID() },
  );
  const customer = { userId: session.user.id, addressId: address.body['id'] as string };
  const booking = await app.creation.create(
    world.bookingInput(customer, world.at(hour)),
    customerContext(customer.userId),
  );
  return { session, client, bookingId: booking.id };
}

const complaint = (bookingId: string) => ({
  bookingId,
  category: 'SERVICE_QUALITY',
  subject: 'Kitchen not cleaned properly',
  description: 'The kitchen counter was left dirty.',
  desiredResolution: 'Please send someone to redo it',
});

describe('support cases from the customer app', () => {
  it('opens a case for the customer’s own booking and requires an idempotency key', async () => {
    const { client, bookingId } = await customerWithBooking(9);

    const withoutKey = await client.post<ErrorBody>(
      '/customer/support-cases',
      complaint(bookingId),
    );
    expect(withoutKey.status).toBe(400);
    expect(withoutKey.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const opened = await client.post<Json>('/customer/support-cases', complaint(bookingId), {
      'idempotency-key': randomUUID(),
    });
    expect(opened.status).toBe(201);
    expect(opened.body).toMatchObject({ status: 'OPEN', replayed: false });
    expect(opened.body['caseCode']).toMatch(/^SC\d{7}$/);
    // With Zoho switched off (this environment), nothing is queued for it.
    const queued = await app.db
      .selectFrom('integration_event')
      .select('id')
      .where('aggregate_id', '=', opened.body['id'] as string)
      .execute();
    expect(queued).toEqual([]);
  });

  it('cannot attach a case to someone else’s booking', async () => {
    const owner = await customerWithBooking(11);
    const other = await customerWithBooking(13);
    const res = await other.client.post<ErrorBody>(
      '/customer/support-cases',
      complaint(owner.bookingId),
      { 'idempotency-key': randomUUID() },
    );
    expect(res.status).toBe(404);
  });

  it('a retried request returns the same case instead of opening a second one', async () => {
    const { session, client, bookingId } = await customerWithBooking(15);
    const key = randomUUID();
    const first = await client.post<Json>('/customer/support-cases', complaint(bookingId), {
      'idempotency-key': key,
    });
    const retry = await client.post<Json>('/customer/support-cases', complaint(bookingId), {
      'idempotency-key': key,
    });
    expect(retry.body).toMatchObject({ id: first.body['id'], replayed: true });

    const cases = await app.db
      .selectFrom('support_case')
      .select('id')
      .where('raised_by_user_id', '=', session.user.id)
      .execute();
    expect(cases).toHaveLength(1);
  });

  it('simultaneous retries with one key still create exactly one case', async () => {
    const { session, client, bookingId } = await customerWithBooking(17);
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        client.post<Json>('/customer/support-cases', complaint(bookingId), {
          'idempotency-key': key,
        }),
      ),
    );
    expect(new Set(results.map((r) => r.body['id'])).size).toBe(1);
    const cases = await app.db
      .selectFrom('support_case')
      .select('id')
      .where('raised_by_user_id', '=', session.user.id)
      .execute();
    expect(cases).toHaveLength(1);
  });

  it('rejects the same key reused for a different request', async () => {
    const { client, bookingId } = await customerWithBooking(10);
    const key = randomUUID();
    await client.post('/customer/support-cases', complaint(bookingId), { 'idempotency-key': key });
    const reused = await client.post<ErrorBody>(
      '/customer/support-cases',
      { ...complaint(bookingId), subject: 'Something else entirely' },
      { 'idempotency-key': key },
    );
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('SOS', () => {
  it('raises a critical incident once per key and never twice for a retry', async () => {
    const { session, client, bookingId } = await customerWithBooking(12);
    const key = randomUUID();
    const sos = { bookingId, note: 'I feel unsafe', lat: world.center.lat, lng: world.center.lng };
    const first = await client.post<Json>('/customer/sos', sos, { 'idempotency-key': key });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ severity: 'CRITICAL', replayed: false });
    const retry = await client.post<Json>('/customer/sos', sos, { 'idempotency-key': key });
    expect(retry.body).toMatchObject({ id: first.body['id'], replayed: true });

    const incidents = await app.db
      .selectFrom('safety_incident')
      .select('id')
      .where('reported_by_user_id', '=', session.user.id)
      .execute();
    expect(incidents).toHaveLength(1);
  });
});

describe('saved addresses', () => {
  it('a retried save returns the same address and does not change the default again', async () => {
    const session = await signInWithOtp(app, api, 'customer');
    const client = api.as(session.accessToken);
    const body = {
      contactName: 'Meera Joshi',
      contactPhone: session.phone,
      houseNumber: 'E-5',
      pincode: world.pincode,
      cityName: 'Noida',
      lat: world.center.lat,
      lng: world.center.lng,
      isDefault: true,
    };
    const key = randomUUID();
    const first = await client.post<Json>('/customer/addresses', body, { 'idempotency-key': key });
    const retry = await client.post<Json>('/customer/addresses', body, { 'idempotency-key': key });
    expect(retry.body['id']).toBe(first.body['id']);
    const list = await client.get<Json[]>('/customer/addresses');
    expect(list.body).toHaveLength(1);
  });
});
