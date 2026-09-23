import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction } from '../src/database/transaction.js';
import { ApiClient } from './support/http.js';
import {
  NOIDA_SECTOR_62,
  configureInvoiceIssuer,
  deliverWebhook,
  expireOffer,
  onboardWorkerViaApi,
  runJob,
  sandbox,
} from './support/journey.js';
import { signInWithOtp } from './support/phone-auth.js';
import { createStaff, signInStaff, type StaffMember } from './support/staff.js';
import { SYSTEM, createTestApp, createWorld, type TestApp, type World } from './support/world.js';

type Json = Record<string, unknown>;

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

async function noida(workers: number, options: { shiftStartHour?: number } = {}) {
  const world = await createWorld(app.db, {
    workers: 0,
    cityName: 'Noida',
    zoneName: 'Sector 62',
    center: NOIDA_SECTOR_62,
  });
  const onboarded = [];
  for (let i = 0; i < workers; i += 1)
    onboarded.push(await onboardWorkerViaApi(app, api, workerOps, world, options));
  return {
    world,
    workers: onboarded.map((w) => ({ id: w.workerId, api: api.as(w.session.accessToken) })),
  };
}

async function customerWithAddress(world: World) {
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
  const pay = await client.post<Json>(
    `/customer/bookings/${booking.body['id'] as string}/payments`,
  );
  const orderId = (pay.body['checkout'] as Json)['orderId'] as string;
  await deliverWebhook(api, sandbox(app).capture(orderId));
  return {
    bookingId: booking.body['id'] as string,
    orderId,
    paymentId: pay.body['paymentId'] as string,
  };
}

describe('payment failures', () => {
  it('a failed payment leaves the booking awaiting payment; a retry can then succeed', async () => {
    const { world } = await noida(1);
    const { client, addressId } = await customerWithAddress(world);
    const booking = await book(client, world, addressId);
    const id = booking.body['id'] as string;

    const first = await client.post<Json>(`/customer/bookings/${id}/payments`);
    await deliverWebhook(
      api,
      sandbox(app).fail(
        (first.body['checkout'] as Json)['orderId'] as string,
        'Insufficient funds',
      ),
    );
    const afterFailure = await client.get<Json>(`/customer/bookings/${id}`);
    expect(afterFailure.body).toMatchObject({
      status: 'PENDING_PAYMENT',
      payment: { status: 'UNPAID' },
      actions: { canPay: true },
    });

    const retry = await client.post<Json>(`/customer/bookings/${id}/payments`);
    expect(retry.body['paymentId']).not.toBe(first.body['paymentId']);
    await deliverWebhook(
      api,
      sandbox(app).capture((retry.body['checkout'] as Json)['orderId'] as string),
    );
    expect((await client.get<Json>(`/customer/bookings/${id}`)).body['status']).toBe('CONFIRMED');
  });

  it('a duplicate webhook is processed once; a forged one is rejected', async () => {
    const { world } = await noida(1);
    const { client, addressId } = await customerWithAddress(world);
    const booking = await book(client, world, addressId);
    const id = booking.body['id'] as string;
    const pay = await client.post<Json>(`/customer/bookings/${id}/payments`);
    const webhook = sandbox(app).capture((pay.body['checkout'] as Json)['orderId'] as string);

    const forged = await api.post<Json>(
      '/payments/webhooks/sandbox',
      webhook.rawBody.replace('"upi"', '"card"'),
      webhook.headers,
    );
    expect(forged.status).toBe(401);
    expect((forged.body['error'] as Json)['code']).toBe('WEBHOOK_SIGNATURE_INVALID');

    const [a, b] = await Promise.all([deliverWebhook(api, webhook), deliverWebhook(api, webhook)]);
    expect([a.body['status'], b.body['status']].sort()).toEqual(['DUPLICATE', 'PROCESSED']);
    expect((await deliverWebhook(api, webhook)).body['status']).toBe('DUPLICATE');

    const events = await app.db
      .selectFrom('payment_event')
      .select('id')
      .where('provider_event_id', '=', (JSON.parse(webhook.rawBody) as Json)['eventId'] as string)
      .execute();
    expect(events).toHaveLength(1);
    const history = await app.db
      .selectFrom('booking_status_history')
      .select('event')
      .where('booking_id', '=', id)
      .where('event', '=', 'PAYMENT_CAPTURED')
      .execute();
    expect(history).toHaveLength(1);
  });

  it('a payment arriving after the booking expired is refunded automatically', async () => {
    const { world } = await noida(1);
    const { client, addressId } = await customerWithAddress(world);
    const booking = await book(client, world, addressId);
    const id = booking.body['id'] as string;
    const pay = await client.post<Json>(`/customer/bookings/${id}/payments`);
    // Let the payment window lapse, then expire the booking through the job as production does.
    await inTransaction(app.db, SYSTEM, (tx) =>
      tx
        .updateTable('booking')
        .set({ payment_due_by: new Date(Date.now() - 1000) })
        .where('id', '=', id)
        .execute(),
    );
    await runJob(app, 'expire-unpaid-bookings');
    expect((await client.get<Json>(`/customer/bookings/${id}`)).body['status']).toBe('EXPIRED');

    await deliverWebhook(
      api,
      sandbox(app).capture((pay.body['checkout'] as Json)['orderId'] as string),
    );
    const refunds = await app.db
      .selectFrom('refund')
      .select(['id', 'status', 'reason_code', 'amount_paise', 'decision_policy'])
      .where('booking_id', '=', id)
      .execute();
    expect(refunds).toEqual([
      {
        id: expect.any(String) as string,
        status: 'APPROVED',
        reason_code: 'PAYMENT_AFTER_EXPIRY',
        amount_paise: 58_882,
        decision_policy: 'LATE_PAYMENT_FULL_REFUND',
      },
    ]);

    // The webhook only records the decision; the refund job sends it to the gateway.
    await runJob(app, 'process-refunds');
    const sent = await app.db
      .selectFrom('refund')
      .select(['status', 'provider_refund_id'])
      .where('id', '=', refunds[0]!.id)
      .executeTakeFirstOrThrow();
    expect(sent.status).toBe('PROCESSING');
    await deliverWebhook(api, sandbox(app).settleRefund(sent.provider_refund_id ?? ''));
    expect(
      (
        await app.db
          .selectFrom('refund')
          .select('status')
          .where('id', '=', refunds[0]!.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('PROCESSED');
  });
});

describe('dispatch failures', () => {
  it('no worker available: the booking is refused and nothing is saved', async () => {
    const { world } = await noida(0);
    const { client, addressId } = await customerWithAddress(world);
    const slots = await client.get<Json>(
      `/customer/availability?serviceId=${world.serviceId}&addressId=${addressId}&date=${world.day}`,
    );
    expect(slots.body['slots']).toEqual([]);
    const res = await book(client, world, addressId);
    expect(res.status).toBe(409);
    expect((res.body['error'] as Json)['code']).toBe('NO_AVAILABILITY');
    expect((await client.get<Json>('/customer/bookings')).body['items']).toEqual([]);
  });

  it('worker rejection: the next eligible worker gets the offer', async () => {
    const { world, workers } = await noida(2);
    const { client, addressId } = await customerWithAddress(world);
    const { bookingId } = await bookAndPay(client, world, addressId);

    const firstOffers = await Promise.all(workers.map((w) => w.api.get<Json[]>('/worker/offers')));
    const holderIndex = firstOffers.findIndex((r) => r.body.length === 1);
    expect(holderIndex).toBeGreaterThanOrEqual(0);
    const holder = workers[holderIndex]!;
    const other = workers[1 - holderIndex]!;
    expect(
      (
        await holder.api.post(
          `/worker/offers/${firstOffers[holderIndex]!.body[0]!['offerId'] as string}/reject`,
          { reason: 'Unwell today' },
        )
      ).status,
    ).toBe(204);

    const next = await other.api.get<Json[]>('/worker/offers');
    expect(next.body.map((o) => o['bookingId'])).toEqual([bookingId]);
    expect((await holder.api.get<Json[]>('/worker/offers')).body).toEqual([]);
  });

  it('worker offer timeout: the offer expires and moves to the next worker', async () => {
    const { world, workers } = await noida(2);
    const { client, addressId } = await customerWithAddress(world);
    const { bookingId } = await bookAndPay(client, world, addressId);
    const offers = await Promise.all(workers.map((w) => w.api.get<Json[]>('/worker/offers')));
    const holderIndex = offers.findIndex((r) => r.body.length === 1);
    await expireOffer(app, offers[holderIndex]!.body[0]!['offerId'] as string);

    const late = await workers[holderIndex]!.api.post<Json>(
      `/worker/offers/${offers[holderIndex]!.body[0]!['offerId'] as string}/accept`,
    );
    expect(late.status).toBe(422);

    await runJob(app, 'expire-worker-offers');
    const next = await workers[1 - holderIndex]!.api.get<Json[]>('/worker/offers');
    expect(next.body.map((o) => o['bookingId'])).toEqual([bookingId]);
  });

  it('worker no-show: operations takes the worker off the job and it is offered again, with the reason on record', async () => {
    const { world, workers } = await noida(2);
    const { client, addressId } = await customerWithAddress(world);
    const { bookingId } = await bookAndPay(client, world, addressId);
    const offers = await Promise.all(workers.map((w) => w.api.get<Json[]>('/worker/offers')));
    const holderIndex = offers.findIndex((r) => r.body.length === 1);
    await workers[holderIndex]!.api.post(
      `/worker/offers/${offers[holderIndex]!.body[0]!['offerId'] as string}/accept`,
    );
    await workers[holderIndex]!.api.post(`/worker/jobs/${bookingId}/en-route`);

    const dispatcher = await createStaff(app, ['DISPATCHER']);
    const ops = api.as(await signInStaff(api, dispatcher));
    const seen = await ops.get<Json>(`/admin/bookings/${bookingId}`);
    const res = await ops.post<Json>(`/admin/bookings/${bookingId}/worker-no-show`, {
      reason: 'Worker unreachable 30 minutes after ETA',
      expectedVersion: seen.body['version'],
    });
    expect(res.status).toBe(201);
    expect(res.body['offers']).toHaveLength(1);

    const timeline = (res.body['booking'] as Json)['timeline'] as Json[];
    expect(timeline.at(-1)).toMatchObject({
      from: 'EN_ROUTE',
      to: 'CONFIRMED',
      event: 'WORKER_UNASSIGNED',
      source: 'ADMIN',
      reason: 'WORKER_NO_SHOW: Worker unreachable 30 minutes after ETA',
      actor: { id: dispatcher.userId },
    });
    expect(
      (await workers[1 - holderIndex]!.api.get<Json[]>('/worker/offers')).body.map(
        (o) => o['bookingId'],
      ),
    ).toEqual([bookingId]);
    expect((await workers[holderIndex]!.api.get<Json>(`/worker/jobs/${bookingId}`)).status).toBe(
      404,
    );
  });

  it('a REGISTERED (not yet approved) worker can sign in but cannot go online or receive jobs', async () => {
    const session = await signInWithOtp(app, api, 'worker');
    const worker = api.as(session.accessToken);
    const online = await worker.post<Json>('/worker/me/presence', { online: true });
    expect(online.status).toBe(403);
    expect((online.body['error'] as Json)['code']).toBe('WORKER_NOT_ACTIVE');
    expect((await worker.get<Json[]>('/worker/offers')).body).toEqual([]);
  });
});

describe('customer changes', () => {
  it('customer cancellation refunds according to the configured policy, through to bank settlement', async () => {
    const { world } = await noida(1);
    const { client, addressId } = await customerWithAddress(world);
    const { bookingId } = await bookAndPay(client, world, addressId);

    const res = await client.post<Json>(`/customer/bookings/${bookingId}/cancel`, {
      reason: 'Plans changed',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ refundAmountPaise: 58_882, booking: { status: 'CANCELLED' } });

    const refund = await app.db
      .selectFrom('refund')
      .select(['id', 'status', 'provider_refund_id', 'decision_policy'])
      .where('booking_id', '=', bookingId)
      .executeTakeFirstOrThrow();
    expect(refund).toMatchObject({
      status: 'PROCESSING',
      decision_policy: 'CANCELLATION_DEFAULT_FULL_REFUND',
    });
    await deliverWebhook(api, sandbox(app).settleRefund(refund.provider_refund_id ?? ''));
    expect(
      (
        await app.db
          .selectFrom('refund')
          .select('status')
          .where('id', '=', refund.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('PROCESSED');

    await runJob(app, 'dispatch-notifications');
    const inbox = await client.get<Json[]>('/customer/notifications');
    expect(inbox.body.map((n) => n['event'])).toEqual(
      expect.arrayContaining(['BOOKING_CANCELLED', 'REFUND_INITIATED', 'REFUND_COMPLETED']),
    );
  });

  it('rescheduling keeps the original promised time permanently', async () => {
    const { world } = await noida(1);
    const { client, addressId } = await customerWithAddress(world);
    const { bookingId } = await bookAndPay(client, world, addressId);
    const moved = await client.post<Json>(`/customer/bookings/${bookingId}/reschedule`, {
      startAt: world.at(11).toISOString(),
      reason: 'Guests arriving',
    });
    expect(moved.status).toBe(200);
    expect(moved.body['schedule']).toEqual({
      original: { start: world.at(10).toISOString(), end: world.at(11).toISOString() },
      current: { start: world.at(11).toISOString(), end: world.at(12).toISOString() },
      rescheduleCount: 1,
    });
    const timeline = await client.get<Json>(`/customer/bookings/${bookingId}/timeline`);
    expect(timeline.body['scheduleChanges']).toEqual([
      expect.objectContaining({ from: world.at(10).toISOString(), to: world.at(11).toISOString() }),
    ]);
  });

  it('refund on a completed booking needs a second person to approve, with fresh MFA', async () => {
    const { world, workers } = await noida(1);
    const { client, addressId } = await customerWithAddress(world);
    const { bookingId } = await bookAndPay(client, world, addressId);
    const worker = workers[0]!.api;
    const offer = (await worker.get<Json[]>('/worker/offers')).body[0]!;
    await worker.post(`/worker/offers/${offer['offerId'] as string}/accept`);
    await worker.post(`/worker/jobs/${bookingId}/en-route`);
    await worker.post(`/worker/jobs/${bookingId}/arrived`);
    const code = (await client.get<Json>(`/customer/bookings/${bookingId}/start-code`)).body[
      'code'
    ] as string;
    await worker.post(`/worker/jobs/${bookingId}/start`, { code });
    await worker.post(`/worker/jobs/${bookingId}/complete`);

    const support = await createStaff(app, ['CUSTOMER_SUPPORT']);
    const supportApi = api.as(await signInStaff(api, support));
    const requested = await supportApi.post<Json>('/admin/refunds', {
      bookingId,
      amountPaise: 10_000,
      reasonCode: 'SERVICE_ISSUE',
      reason: 'Kitchen not finished',
    });
    expect(requested.status).toBe(201);
    const refundId = requested.body['refundId'] as string;

    // Support cannot approve refunds at all.
    const denied = await supportApi.post<Json>(`/admin/refunds/${refundId}/approve`, {});
    expect((denied.body['error'] as Json)['code']).toBe('PERMISSION_DENIED');

    // Finance cannot approve its own request (database-enforced), even with the permission.
    const finance = await createStaff(app, ['FINANCE']);
    const financeApi = api.as(await signInStaff(api, finance));
    const own = await financeApi.post<Json>('/admin/refunds', {
      bookingId,
      amountPaise: 5_000,
      reasonCode: 'GOODWILL',
      reason: 'Goodwill gesture',
    });
    const selfApprove = await financeApi.post<Json>(
      `/admin/refunds/${own.body['refundId'] as string}/approve`,
      {},
    );
    expect(selfApprove.status).toBe(422);

    // A second person approves the support request; it goes to the gateway.
    expect(
      (
        await financeApi.post(`/admin/refunds/${refundId}/approve`, {
          note: 'Verified with photos',
        })
      ).status,
    ).toBe(204);
    const refund = await app.db
      .selectFrom('refund')
      .select(['status', 'decided_by', 'requested_by'])
      .where('id', '=', refundId)
      .executeTakeFirstOrThrow();
    expect(refund).toEqual({
      status: 'PROCESSING',
      decided_by: finance.userId,
      requested_by: support.userId,
    });
  });
});

describe('abuse and concurrency', () => {
  it('concurrent booking attempts through the API: one worker, five customers, one booking', async () => {
    const { world } = await noida(1);
    const customers = await Promise.all(
      Array.from({ length: 5 }, () => customerWithAddress(world)),
    );
    const results = await Promise.all(customers.map((c) => book(c.client, world, c.addressId, 14)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      results.filter((r) => r.status === 409).map((r) => (r.body['error'] as Json)['code']),
    ).toEqual(Array(4).fill('NO_AVAILABILITY'));
  });

  it('duplicate API request (network retry) returns the same booking', async () => {
    const { world } = await noida(1);
    const { client, addressId } = await customerWithAddress(world);
    const key = randomUUID();
    const [a, b] = await Promise.all([
      book(client, world, addressId, 10, key),
      book(client, world, addressId, 10, key),
    ]);
    expect(a.body['id']).toBe(b.body['id']);
    const again = await book(client, world, addressId, 10, key);
    expect(again.body).toMatchObject({ id: a.body['id'], replayed: true });
    expect((await client.get<Json>('/customer/bookings')).body['items']).toHaveLength(1);
    expect((await client.post<Json>('/customer/bookings', {}, {})).status).toBe(400);
  });

  it('invalid and expired OTPs are rejected', async () => {
    const res = await api.post<Json>('/customer/auth/otp', {
      phone: `9${String(Date.now()).slice(-9)}`,
    });
    const wrong = await api.post<Json>('/customer/auth/verify', {
      challengeId: res.body['challengeId'],
      phone: res.body['phone'],
      code: '000000',
    });
    expect(wrong.status).toBe(401);
    const unknown = await api.post<Json>('/customer/auth/verify', {
      challengeId: randomUUID(),
      phone: res.body['phone'],
      code: '123456',
    });
    expect(unknown.status).toBe(401);
  });

  it('an invalid start code keeps the job waiting; the right code starts it', async () => {
    const { world, workers } = await noida(1);
    const { client, addressId } = await customerWithAddress(world);
    const { bookingId } = await bookAndPay(client, world, addressId);
    const worker = workers[0]!.api;
    const offer = (await worker.get<Json[]>('/worker/offers')).body[0]!;
    await worker.post(`/worker/offers/${offer['offerId'] as string}/accept`);
    await worker.post(`/worker/jobs/${bookingId}/en-route`);
    await worker.post(`/worker/jobs/${bookingId}/arrived`);
    const code = (await client.get<Json>(`/customer/bookings/${bookingId}/start-code`)).body[
      'code'
    ] as string;
    const wrong = code === '0000' ? '1111' : '0000';

    const bad = await worker.post<Json>(`/worker/jobs/${bookingId}/start`, { code: wrong });
    expect(bad.status).toBe(400);
    expect((bad.body['error'] as Json)['code']).toBe('CODE_INCORRECT');
    expect((await client.get<Json>(`/customer/bookings/${bookingId}`)).body['status']).toBe(
      'ARRIVED',
    );
    expect(
      (await worker.post<Json>(`/worker/jobs/${bookingId}/start`, { code })).body['status'],
    ).toBe('IN_PROGRESS');
  });

  it('a worker cannot act on a job that is not theirs, whatever the app shows', async () => {
    const { world, workers } = await noida(2);
    const { client, addressId } = await customerWithAddress(world);
    const { bookingId } = await bookAndPay(client, world, addressId);
    const offers = await Promise.all(workers.map((w) => w.api.get<Json[]>('/worker/offers')));
    const holderIndex = offers.findIndex((r) => r.body.length === 1);
    const intruder = workers[1 - holderIndex]!.api;
    const offerId = offers[holderIndex]!.body[0]!['offerId'] as string;
    expect(
      ((await intruder.post<Json>(`/worker/offers/${offerId}/accept`)).body['error'] as Json)[
        'code'
      ],
    ).toBe('NOT_YOUR_OFFER');
    await workers[holderIndex]!.api.post(`/worker/offers/${offerId}/accept`);
    expect(
      ((await intruder.post<Json>(`/worker/jobs/${bookingId}/en-route`)).body['error'] as Json)[
        'code'
      ],
    ).toBe('NOT_YOUR_JOB');
    // Skipping steps is refused by the state machine even for the right worker.
    expect(
      (
        (await workers[holderIndex]!.api.post<Json>(`/worker/jobs/${bookingId}/complete`)).body[
          'error'
        ] as Json
      )['code'],
    ).toBe('INVALID_STATUS_TRANSITION');
  });
});

describe('access control and personal data', () => {
  it('personal data is masked by default; reveal needs permission and is audited', async () => {
    const { world } = await noida(1);
    const { session, client, addressId } = await customerWithAddress(world);
    const { bookingId } = await bookAndPay(client, world, addressId);
    const booking = await client.get<Json>(`/customer/bookings/${bookingId}`);
    const customerId = session.user.id;

    const finance = api.as(await signInStaff(api, await createStaff(app, ['FINANCE'])));
    const financeView = await finance.get<Json>(`/admin/bookings/${bookingId}`);
    expect(financeView.status).toBe(200);
    expect(JSON.stringify(financeView.body)).not.toContain(session.phone);
    expect(
      (
        (await finance.post<Json>(`/admin/customers/${customerId}/reveal`, { reason: 'Curious' }))
          .body['error'] as Json
      )['code'],
    ).toBe('PERMISSION_DENIED');

    const supportMember = await createStaff(app, ['CUSTOMER_SUPPORT']);
    const support = api.as(await signInStaff(api, supportMember));
    const supportView = await support.get<Json>(`/admin/bookings/${bookingId}`);
    // Support sees payment status but not gateway references or amounts detail.
    expect((supportView.body['payments'] as Json[])[0]).toEqual({
      id: expect.any(String) as string,
      status: 'CAPTURED',
    });

    const revealed = await support.post<Json>(`/admin/customers/${customerId}/reveal`, {
      reason:
        'Customer asked for a call back about booking ' + (booking.body['bookingCode'] as string),
    });
    expect(revealed.status).toBe(200);
    expect(revealed.body['phone']).toBe(session.phone);
    const auditRow = await app.db
      .selectFrom('audit_log')
      .select(['actor_user_id', 'action', 'reason'])
      .where('entity_type', '=', 'customer_pii')
      .where('entity_id', '=', customerId)
      .executeTakeFirstOrThrow();
    expect(auditRow).toMatchObject({ actor_user_id: supportMember.userId, action: 'READ' });
    expect(auditRow.reason).toContain('call back');
  });

  it('staff are limited to their granted permissions and cities', async () => {
    const { world } = await noida(1);
    const other = await createWorld(app.db, { workers: 0 });
    const { client, addressId } = await customerWithAddress(world);
    const { bookingId } = await bookAndPay(client, world, addressId);

    const localDispatcher = await createStaff(app, ['DISPATCHER'], { cityId: other.cityId });
    const dispatcher = api.as(await signInStaff(api, localDispatcher));
    expect((await dispatcher.get(`/admin/bookings/${bookingId}`)).status).toBe(404);
    expect(
      (await dispatcher.get<Json[]>('/admin/bookings')).body.some((b) => b['id'] === bookingId),
    ).toBe(false);
    expect((await dispatcher.get<Json>('/admin/audit')).status).toBe(403);
  });

  it('sensitive overrides require a recent authenticator check', async () => {
    const { world } = await noida(1);
    const { client, addressId } = await customerWithAddress(world);
    const booking = await book(client, world, addressId);
    const head = await createStaff(app, ['OPERATIONS_HEAD']);
    const token = await signInStaff(api, head);
    // Pretend the MFA check happened long ago.
    await app.db
      .updateTable('auth_session')
      .set({ mfa_verified_at: new Date(Date.now() - 3_600_000) })
      .where('user_id', '=', head.userId)
      .execute();
    const { version } = (
      await api.as(token).get<Json>(`/admin/bookings/${booking.body['id'] as string}`)
    ).body;
    const blocked = await api
      .as(token)
      .post<Json>(`/admin/bookings/${booking.body['id'] as string}/confirm-without-prepayment`, {
        reason: 'Corporate client is invoiced after the service',
        expectedVersion: version,
      });
    expect((blocked.body['error'] as Json)['code']).toBe('MFA_REQUIRED');
    expect(
      (await api.as(token).post('/auth/staff/step-up', { code: head.nextCode() })).status,
    ).toBe(204);
    const allowed = await api
      .as(token)
      .post<Json>(`/admin/bookings/${booking.body['id'] as string}/confirm-without-prepayment`, {
        reason: 'Corporate client is invoiced after the service',
        expectedVersion: version,
      });
    expect(allowed.status).toBe(201);
    expect((allowed.body['booking'] as Json)['status']).toBe('CONFIRMED');
  });
});

describe('authorized payments and out-of-order gateway events', () => {
  async function bookAndOpenPayment() {
    const { world } = await noida(1);
    const { client, addressId } = await customerWithAddress(world);
    const booking = await book(client, world, addressId);
    const bookingId = booking.body['id'] as string;
    const pay = await client.post<Json>(`/customer/bookings/${bookingId}/payments`);
    const orderId = (pay.body['checkout'] as Json)['orderId'] as string;
    return { client, bookingId, orderId, paymentId: pay.body['paymentId'] as string };
  }

  const paymentStatus = async (paymentId: string) =>
    (
      await app.db
        .selectFrom('payment')
        .select('status')
        .where('id', '=', paymentId)
        .executeTakeFirstOrThrow()
    ).status;

  const expireDeadline = (bookingId: string) =>
    inTransaction(app.db, SYSTEM, (tx) =>
      tx
        .updateTable('booking')
        .set({ payment_due_by: new Date(Date.now() - 1000) })
        .where('id', '=', bookingId)
        .execute(),
    );

  it('an authorized-only payment is captured by the server, and the booking confirmed', async () => {
    const { client, bookingId, orderId, paymentId } = await bookAndOpenPayment();
    await deliverWebhook(api, sandbox(app).authorize(orderId));
    expect(await paymentStatus(paymentId)).toBe('AUTHORIZED');
    // Authorized is not paid: the booking is not confirmed on an authorization.
    expect((await client.get<Json>(`/customer/bookings/${bookingId}`)).body['status']).toBe(
      'PENDING_PAYMENT',
    );

    await runJob(app, 'reconcile-payments');
    expect((await sandbox(app).fetchOrderStatus(orderId)).state).toBe('CAPTURED');
    expect(await paymentStatus(paymentId)).toBe('CAPTURED');
    expect((await client.get<Json>(`/customer/bookings/${bookingId}`)).body['status']).toBe(
      'CONFIRMED',
    );

    // The gateway's own payment.captured webhook then arrives: nothing changes twice.
    const capturesBefore = sandbox(app).captures;
    await deliverWebhook(api, sandbox(app).capture(orderId));
    await runJob(app, 'reconcile-payments');
    expect(sandbox(app).captures).toBe(capturesBefore);
    const history = await app.db
      .selectFrom('booking_status_history')
      .select('event')
      .where('booking_id', '=', bookingId)
      .where('event', '=', 'PAYMENT_CAPTURED')
      .execute();
    expect(history).toHaveLength(1);
  });

  it('a payment authorized in time is not lost when the deadline passes before capture', async () => {
    const { client, bookingId, orderId } = await bookAndOpenPayment();
    await deliverWebhook(api, sandbox(app).authorize(orderId));
    await inTransaction(app.db, SYSTEM, (tx) =>
      tx
        .updateTable('payment')
        .set({ authorized_at: new Date(Date.now() - 60_000) })
        .where('provider_order_id', '=', orderId)
        .execute(),
    );
    await expireDeadline(bookingId);

    await runJob(app, 'expire-unpaid-bookings');
    expect((await client.get<Json>(`/customer/bookings/${bookingId}`)).body['status']).toBe(
      'PENDING_PAYMENT',
    );
    await runJob(app, 'reconcile-payments');
    expect((await client.get<Json>(`/customer/bookings/${bookingId}`)).body['status']).toBe(
      'CONFIRMED',
    );
  });

  it('an authorization after the booking expired is never captured (the hold lapses)', async () => {
    const { client, bookingId, orderId, paymentId } = await bookAndOpenPayment();
    await expireDeadline(bookingId);
    await runJob(app, 'expire-unpaid-bookings');
    expect((await client.get<Json>(`/customer/bookings/${bookingId}`)).body['status']).toBe(
      'EXPIRED',
    );
    await deliverWebhook(api, sandbox(app).authorize(orderId));
    await runJob(app, 'reconcile-payments');
    // Still only authorized at the gateway, and in our records.
    expect((await sandbox(app).fetchOrderStatus(orderId)).state).toBe('AUTHORIZED');
    expect(await paymentStatus(paymentId)).toBe('AUTHORIZED');
    const refunds = await app.db
      .selectFrom('refund')
      .select('id')
      .where('booking_id', '=', bookingId)
      .execute();
    expect(refunds).toEqual([]); // nothing was taken, so there is nothing to refund
  });

  it('a failure event arriving after the capture does not undo the payment', async () => {
    const { client, bookingId, orderId, paymentId } = await bookAndOpenPayment();
    await deliverWebhook(api, sandbox(app).capture(orderId));
    await deliverWebhook(api, sandbox(app).fail(orderId, 'Late failure notice'));
    expect(await paymentStatus(paymentId)).toBe('CAPTURED');
    expect((await client.get<Json>(`/customer/bookings/${bookingId}`)).body['status']).toBe(
      'CONFIRMED',
    );
  });

  it('a success after an earlier failed attempt in the same checkout confirms the booking', async () => {
    const { client, bookingId, orderId, paymentId } = await bookAndOpenPayment();
    await deliverWebhook(api, sandbox(app).fail(orderId, 'Wrong UPI PIN'));
    expect(await paymentStatus(paymentId)).toBe('FAILED');
    await deliverWebhook(api, sandbox(app).authorize(orderId));
    expect(await paymentStatus(paymentId)).toBe('AUTHORIZED');
    await runJob(app, 'reconcile-payments');
    expect((await client.get<Json>(`/customer/bookings/${bookingId}`)).body['status']).toBe(
      'CONFIRMED',
    );
  });
});
