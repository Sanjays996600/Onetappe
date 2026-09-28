import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction } from '../../src/database/transaction.js';
import type { SignedWebhook } from '../../src/payments/providers/sandbox.provider.js';
import { ApiClient } from '../support/http.js';
import {
  NOIDA_SECTOR_62,
  configureInvoiceIssuer,
  deliverWebhook,
  onboardWorkerViaApi,
  runJob,
  sandbox,
} from '../support/journey.js';
import { signInWithOtp } from '../support/phone-auth.js';
import { createStaff, signInStaff, type StaffMember } from '../support/staff.js';
import { SYSTEM, createTestApp, createWorld, type TestApp, type World } from '../support/world.js';

/**
 * G6: a gateway payment confirms a booking only when it matches the order exactly, to the
 * paisa and the currency, whichever way it arrives (webhook, "I have paid" refresh,
 * reconciliation). Anything else is recorded once for investigation and changes nothing.
 */

type Json = Record<string, unknown>;

const PRICE_PAISE = 58_882;

let app: TestApp;
let api: ApiClient;
let workerOps: StaffMember;

beforeAll(async () => {
  app = await createTestApp();
  api = new ApiClient(app.http);
  workerOps = await createStaff(app, ['WORKER_OPERATIONS']);
  const superAdmin = await createStaff(app, ['SUPER_ADMIN']);
  await configureInvoiceIssuer(api, await signInStaff(api, superAdmin));
});

afterAll(async () => {
  await app.close();
});

async function unpaidBooking() {
  const world: World = await createWorld(app.db, {
    workers: 0,
    cityName: 'Noida',
    zoneName: 'Sector 62',
    center: NOIDA_SECTOR_62,
  });
  await onboardWorkerViaApi(app, api, workerOps, world);
  const session = await signInWithOtp(app, api, 'customer');
  const client = api.as(session.accessToken);
  await client.patch('/customer/me', { fullName: 'Rahul Verma' });
  const address = await client.post<Json>(
    '/customer/addresses',
    {
      contactName: 'Rahul Verma',
      contactPhone: session.phone,
      houseNumber: 'B-7',
      pincode: world.pincode,
      cityName: 'Noida',
      lat: world.center.lat + 0.002,
      lng: world.center.lng + 0.002,
    },
    { 'idempotency-key': randomUUID() },
  );
  const booking = await client.post<Json>(
    '/customer/bookings',
    {
      serviceId: world.serviceId,
      addressId: address.body['id'] as string,
      bookingType: 'SCHEDULED',
      startAt: world.at(10).toISOString(),
      expectedTotalPaise: PRICE_PAISE,
    },
    { 'idempotency-key': randomUUID() },
  );
  const bookingId = booking.body['id'] as string;
  const pay = await client.post<Json>(`/customer/bookings/${bookingId}/payments`);
  return {
    client,
    bookingId,
    paymentId: pay.body['paymentId'] as string,
    orderId: (pay.body['checkout'] as Json)['orderId'] as string,
  };
}

async function bookingStatus(client: ApiClient, bookingId: string): Promise<string> {
  return (await client.get<Json>(`/customer/bookings/${bookingId}`)).body['status'] as string;
}

async function payment(paymentId: string) {
  return app.db
    .selectFrom('payment')
    .select(['status', 'captured_amount_paise', 'captured_at'])
    .where('id', '=', paymentId)
    .executeTakeFirstOrThrow();
}

function eventIdOf(webhook: SignedWebhook): string {
  return (JSON.parse(webhook.rawBody) as Json)['eventId'] as string;
}

async function storedEvents(eventId: string) {
  return app.db
    .selectFrom('payment_event')
    .select(['processing_error', 'signature_verified', 'payload', 'processed_at'])
    .where('provider_event_id', '=', eventId)
    .execute();
}

async function capturedHistory(bookingId: string): Promise<number> {
  const rows = await app.db
    .selectFrom('booking_status_history')
    .select('id')
    .where('booking_id', '=', bookingId)
    .where('event', '=', 'PAYMENT_CAPTURED')
    .execute();
  return rows.length;
}

/** "Payment successful" messages per channel (one channel sends at most one each). */
async function paymentNotifications(bookingId: string): Promise<Record<string, number>> {
  const rows = await app.db
    .selectFrom('notification')
    .select(['channel', (eb) => eb.fn.countAll<string>().as('n')])
    .where('booking_id', '=', bookingId)
    .where('dedupe_key', 'like', 'PAYMENT_SUCCESSFUL:%')
    .groupBy('channel')
    .execute();
  return Object.fromEntries(rows.map((r) => [r.channel, Number(r.n)]));
}

/** Exactly one "payment successful" message on every channel that sent one. */
async function expectNotifiedOnce(bookingId: string) {
  const perChannel = await paymentNotifications(bookingId);
  expect(Object.keys(perChannel).length).toBeGreaterThan(0);
  expect(Object.values(perChannel).every((n) => n === 1)).toBe(true);
}

/** The booking was not moved on by a payment that did not match. */
async function expectUntouched(client: ApiClient, bookingId: string, paymentId: string) {
  expect(await bookingStatus(client, bookingId)).toBe('PENDING_PAYMENT');
  expect((await payment(paymentId)).status).not.toBe('CAPTURED');
  expect((await payment(paymentId)).captured_amount_paise).toBeNull();
  expect(await capturedHistory(bookingId)).toBe(0);
  expect(await paymentNotifications(bookingId)).toEqual({});
}

describe('payment webhook: amount and currency', () => {
  it('confirms the booking when the payment matches the order exactly', async () => {
    const b = await unpaidBooking();
    const webhook = sandbox(app).capture(b.orderId);
    expect((await deliverWebhook(api, webhook)).body['status']).toBe('PROCESSED');

    expect(await bookingStatus(b.client, b.bookingId)).toBe('CONFIRMED');
    expect(await payment(b.paymentId)).toMatchObject({
      status: 'CAPTURED',
      captured_amount_paise: PRICE_PAISE,
    });
    const [event] = await storedEvents(eventIdOf(webhook));
    expect(event).toMatchObject({ processing_error: null, signature_verified: true });
    expect(event?.processed_at).not.toBeNull();
  });

  it('never confirms a payment of a different amount, and records it for investigation', async () => {
    const b = await unpaidBooking();
    for (const amountPaise of [PRICE_PAISE - 1, PRICE_PAISE + 1, 100]) {
      const webhook = sandbox(app).capture(b.orderId, { amountPaise });
      expect((await deliverWebhook(api, webhook)).status).toBe(200);
      const [event] = await storedEvents(eventIdOf(webhook));
      expect(event?.processing_error).toBe(
        `AMOUNT_MISMATCH expected ${String(PRICE_PAISE)} got ${String(amountPaise)}`,
      );
    }
    await expectUntouched(b.client, b.bookingId, b.paymentId);
  });

  it('never confirms a payment in another currency, even for the same number', async () => {
    const b = await unpaidBooking();
    const webhook = sandbox(app).capture(b.orderId, { currency: 'USD' });
    await deliverWebhook(api, webhook);
    const [event] = await storedEvents(eventIdOf(webhook));
    expect(event?.processing_error).toBe('CURRENCY_MISMATCH expected INR got USD');
    await expectUntouched(b.client, b.bookingId, b.paymentId);
  });

  it('never confirms a payment whose currency is missing', async () => {
    const b = await unpaidBooking();
    const webhook = sandbox(app).capture(b.orderId, { currency: null });
    await deliverWebhook(api, webhook);
    expect((await storedEvents(eventIdOf(webhook)))[0]?.processing_error).toBe('CURRENCY_MISSING');
    await expectUntouched(b.client, b.bookingId, b.paymentId);
  });

  it('does not accept, and never captures, an authorization for the wrong amount', async () => {
    const b = await unpaidBooking();
    const capturesBefore = sandbox(app).captures;
    const webhook = sandbox(app).authorize(b.orderId, { amountPaise: PRICE_PAISE * 2 });
    await deliverWebhook(api, webhook);
    expect((await storedEvents(eventIdOf(webhook)))[0]?.processing_error).toBe(
      `AMOUNT_MISMATCH expected ${String(PRICE_PAISE)} got ${String(PRICE_PAISE * 2)}`,
    );
    expect((await payment(b.paymentId)).status).toBe('CREATED');

    // "I have paid" asks the gateway, which reports the same wrong authorization: still no
    // capture and no confirmation.
    await b.client.post(`/customer/bookings/${b.bookingId}/payments/${b.paymentId}/refresh`);
    await runJob(app, 'reconcile-payments');
    expect(sandbox(app).captures).toBe(capturesBefore);
    await expectUntouched(b.client, b.bookingId, b.paymentId);
  });

  it('the server-side status check applies the same rule as the webhook', async () => {
    const b = await unpaidBooking();
    // The gateway holds a capture for the wrong amount, and its webhook is lost.
    sandbox(app).capture(b.orderId, { amountPaise: 1 });
    const refresh = await b.client.post<Json>(
      `/customer/bookings/${b.bookingId}/payments/${b.paymentId}/refresh`,
    );
    expect(refresh.status).toBe(200);
    const events = await app.db
      .selectFrom('payment_event')
      .select(['event_type', 'processing_error'])
      .where('payment_id', '=', b.paymentId)
      .execute();
    expect(events).toEqual([
      {
        event_type: 'status.fetch',
        processing_error: `AMOUNT_MISMATCH expected ${String(PRICE_PAISE)} got 1`,
      },
    ]);
    await expectUntouched(b.client, b.bookingId, b.paymentId);
  });

  it('a late event with different money never changes a correctly confirmed booking', async () => {
    const b = await unpaidBooking();
    await deliverWebhook(api, sandbox(app).capture(b.orderId));
    expect(await bookingStatus(b.client, b.bookingId)).toBe('CONFIRMED');

    const odd = sandbox(app).capture(b.orderId, { amountPaise: 1 });
    await deliverWebhook(api, odd);
    expect((await storedEvents(eventIdOf(odd)))[0]?.processing_error).toBe(
      `AMOUNT_MISMATCH expected ${String(PRICE_PAISE)} got 1`,
    );
    expect(await bookingStatus(b.client, b.bookingId)).toBe('CONFIRMED');
    expect(await payment(b.paymentId)).toMatchObject({
      status: 'CAPTURED',
      captured_amount_paise: PRICE_PAISE,
    });
    expect(await capturedHistory(b.bookingId)).toBe(1);
  });
});

describe('payment webhook: delivery', () => {
  it('a duplicate or repeated delivery is processed once', async () => {
    const b = await unpaidBooking();
    const webhook = sandbox(app).capture(b.orderId);
    const concurrent = await Promise.all(
      Array.from({ length: 5 }, () => deliverWebhook(api, webhook)),
    );
    expect(concurrent.map((r) => r.body['status']).sort()).toEqual([
      'DUPLICATE',
      'DUPLICATE',
      'DUPLICATE',
      'DUPLICATE',
      'PROCESSED',
    ]);
    for (let i = 0; i < 3; i += 1) {
      expect((await deliverWebhook(api, webhook)).body['status']).toBe('DUPLICATE');
    }
    expect(await storedEvents(eventIdOf(webhook))).toHaveLength(1);
    expect(await capturedHistory(b.bookingId)).toBe(1);
    await expectNotifiedOnce(b.bookingId);
    expect(await bookingStatus(b.client, b.bookingId)).toBe('CONFIRMED');
  });

  it('a repeated mismatched event is recorded once and still confirms nothing', async () => {
    const b = await unpaidBooking();
    const webhook = sandbox(app).capture(b.orderId, { amountPaise: 1 });
    for (let i = 0; i < 4; i += 1) await deliverWebhook(api, webhook);
    expect(await storedEvents(eventIdOf(webhook))).toHaveLength(1);
    await expectUntouched(b.client, b.bookingId, b.paymentId);
  });

  it('rejects forged or unsigned webhooks without storing them', async () => {
    const b = await unpaidBooking();
    const genuine = sandbox(app).capture(b.orderId, { amountPaise: 1 });
    // An attacker "fixes" the amount so that it would match.
    const tamperedBody = genuine.rawBody.replace(
      '"amountPaise":1',
      `"amountPaise":${String(PRICE_PAISE)}`,
    );
    expect(tamperedBody).not.toBe(genuine.rawBody);
    const attempts: Array<Record<string, string>> = [
      genuine.headers, // original signature over a different body
      { 'content-type': 'application/json' }, // no signature at all
      {
        'content-type': 'application/json',
        'x-sandbox-signature': createHmac('sha256', 'not-the-webhook-secret')
          .update(tamperedBody)
          .digest('hex'),
      },
      { 'content-type': 'application/json', 'x-sandbox-signature': 'deadbeef' },
    ];
    for (const headers of attempts) {
      const response = await api.post<Json>('/payments/webhooks/sandbox', tamperedBody, headers);
      expect(response.status).toBe(401);
      expect((response.body['error'] as Json)['code']).toBe('WEBHOOK_SIGNATURE_INVALID');
    }
    expect(await storedEvents(eventIdOf(genuine))).toHaveLength(0);
    await expectUntouched(b.client, b.bookingId, b.paymentId);
  });

  it('records a genuine event for an order we do not know, and changes nothing', async () => {
    // A real, signed gateway event for an order that is not ours (another integration on
    // the same account, or a test sent from the dashboard).
    const foreign = await sandbox(app).createOrder({
      paymentId: randomUUID(),
      bookingCode: 'NOT-OURS',
      amountPaise: 12_345,
      currency: 'INR',
    });
    const webhook = sandbox(app).capture(foreign.providerOrderId);
    const response = await deliverWebhook(api, webhook);
    expect(response.status).toBe(200);
    expect(response.body['status']).toBe('PROCESSED');
    const [event] = await storedEvents(eventIdOf(webhook));
    expect(event?.processing_error).toBe('UNKNOWN_ORDER');
    const linked = await app.db
      .selectFrom('payment')
      .select('id')
      .where('provider_order_id', '=', foreign.providerOrderId)
      .execute();
    expect(linked).toEqual([]);
  });

  it('a webhook delayed past the server-side confirmation changes nothing twice', async () => {
    const b = await unpaidBooking();
    // The customer taps "I have paid"; the server asks the gateway and confirms.
    const webhook = sandbox(app).capture(b.orderId);
    await b.client.post(`/customer/bookings/${b.bookingId}/payments/${b.paymentId}/refresh`);
    expect(await bookingStatus(b.client, b.bookingId)).toBe('CONFIRMED');

    // The gateway's own webhook arrives much later.
    expect((await deliverWebhook(api, webhook)).body['status']).toBe('PROCESSED');
    expect((await storedEvents(eventIdOf(webhook)))[0]?.processing_error).toBeNull();
    expect(await capturedHistory(b.bookingId)).toBe(1);
    await expectNotifiedOnce(b.bookingId);
    expect(await payment(b.paymentId)).toMatchObject({
      status: 'CAPTURED',
      captured_amount_paise: PRICE_PAISE,
    });
  });
});

describe('refund webhook: amount and currency', () => {
  it('flags a refund settled for a different amount instead of accepting it silently', async () => {
    const b = await unpaidBooking();
    // The booking expires unpaid, then the payment arrives: it is refunded automatically.
    await inTransaction(app.db, SYSTEM, (tx) =>
      tx
        .updateTable('booking')
        .set({ payment_due_by: new Date(Date.now() - 1000) })
        .where('id', '=', b.bookingId)
        .execute(),
    );
    await runJob(app, 'expire-unpaid-bookings');
    await deliverWebhook(api, sandbox(app).capture(b.orderId));
    await runJob(app, 'process-refunds');
    const refund = await app.db
      .selectFrom('refund')
      .select(['id', 'provider_refund_id', 'amount_paise'])
      .where('booking_id', '=', b.bookingId)
      .executeTakeFirstOrThrow();
    expect(refund.provider_refund_id).not.toBeNull();

    const settled = sandbox(app).settleRefund(refund.provider_refund_id ?? '', {
      amountPaise: refund.amount_paise - 100,
    });
    await deliverWebhook(api, settled);
    expect((await storedEvents(eventIdOf(settled)))[0]?.processing_error).toBe(
      `AMOUNT_MISMATCH expected ${String(refund.amount_paise)} got ${String(refund.amount_paise - 100)}`,
    );
    // The gateway's word on whether money went back still stands; finance reviews the amount.
    const after = await app.db
      .selectFrom('refund')
      .select('status')
      .where('id', '=', refund.id)
      .executeTakeFirstOrThrow();
    expect(after.status).toBe('PROCESSED');
  });
});
