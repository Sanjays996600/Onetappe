import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionService } from '../../src/auth/session.service.js';
import { inTransaction } from '../../src/database/transaction.js';
import { ApiClient } from '../support/http.js';
import { deliverWebhook, NOIDA_SECTOR_62, runJob, sandbox } from '../support/journey.js';
import { signInWithOtp, type PhoneSession } from '../support/phone-auth.js';
import { createStaff, signInStaff } from '../support/staff.js';
import { createTestApp, createWorld, SYSTEM, type TestApp, type World } from '../support/world.js';

/**
 * Broken object-level authorization (IDOR/BOLA) and function-level authorization, tried
 * the way an attacker would: with a valid session of their own and someone else's ids.
 * The UI hides these actions; the API must refuse them anyway. Someone else's resource is
 * answered exactly like a resource that does not exist (404), so ids cannot be probed.
 */

type Json = Record<string, unknown>;
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** The error code of an API error response ({ error: { code } }). */
const codeOf = (body: unknown) => (body as { error?: { code?: string } }).error?.code;

let app: TestApp;
let api: ApiClient;
let world: World;
let otherCity: World;
let alice: PhoneSession;
let bob: PhoneSession;
let assigned: PhoneSession; // the worker who accepted Alice's booking
let intruder: PhoneSession; // another active worker
let aliceBooking: string;
let alicePayment: string;
let aliceAddress: string;
let aliceOffer: string;

async function workerSession(phone: string) {
  return signInWithOtp(app, api, 'worker', phone);
}

beforeAll(async () => {
  app = await createTestApp();
  api = new ApiClient(app.http);
  world = await createWorld(app.db, { workers: 2, center: NOIDA_SECTOR_62 });
  otherCity = await createWorld(app.db, { workers: 0 });
  const phones = await app.db
    .selectFrom('app_user')
    .select(['id', 'phone_e164'])
    .where('id', 'in', [...world.workerIds])
    .execute();

  alice = await signInWithOtp(app, api, 'customer');
  bob = await signInWithOtp(app, api, 'customer');
  const address = await api.as(alice.accessToken).post<Json>(
    '/customer/addresses',
    {
      contactName: 'Alice',
      contactPhone: alice.phone,
      houseNumber: 'Flat 7, Tower B',
      landmark: 'Opposite the park',
      pincode: world.pincode,
      cityName: 'Noida',
      lat: world.center.lat,
      lng: world.center.lng,
      accessNotes: 'Gate code 4412',
    },
    { 'idempotency-key': randomUUID() },
  );
  aliceAddress = address.body['id'] as string;
  const booking = await api.as(alice.accessToken).post<Json>(
    '/customer/bookings',
    {
      serviceId: world.serviceId,
      addressId: aliceAddress,
      bookingType: 'SCHEDULED',
      startAt: world.at(11).toISOString(),
      expectedTotalPaise: 58_882,
    },
    { 'idempotency-key': randomUUID() },
  );
  aliceBooking = booking.body['id'] as string;
  const pay = await api
    .as(alice.accessToken)
    .post<Json>(`/customer/bookings/${aliceBooking}/payments`);
  alicePayment = pay.body['paymentId'] as string;
  await deliverWebhook(
    api,
    sandbox(app).capture((pay.body['checkout'] as Json)['orderId'] as string),
  );

  // Whoever got the offer is "assigned"; the other worker is the intruder.
  const offer = await app.db
    .selectFrom('booking_assignment')
    .select(['id', 'worker_id'])
    .where('booking_id', '=', aliceBooking)
    .where('status', '=', 'OFFERED')
    .executeTakeFirstOrThrow();
  aliceOffer = offer.id;
  const assignedPhone = phones.find((p) => p.id === offer.worker_id)?.phone_e164 ?? '';
  const intruderPhone = phones.find((p) => p.id !== offer.worker_id)?.phone_e164 ?? '';
  intruder = await workerSession(intruderPhone);
  // The intruder tries to take the offer first.
  expect(
    (await api.as(intruder.accessToken).post(`/worker/offers/${aliceOffer}/accept`)).status,
  ).toBe(404);
  assigned = await workerSession(assignedPhone);
  expect(
    (await api.as(assigned.accessToken).post(`/worker/offers/${aliceOffer}/accept`)).status,
  ).toBe(200);
});

afterAll(async () => {
  await app.close();
});

describe('customers cannot reach another customer’s data', () => {
  const customerRoutes = (id: string, paymentId: string): [Method, string, unknown?][] => [
    ['GET', `/customer/bookings/${id}`],
    ['GET', `/customer/bookings/${id}/timeline`],
    ['GET', `/customer/bookings/${id}/invoice`],
    ['GET', `/customer/bookings/${id}/start-code`],
    ['POST', `/customer/bookings/${id}/payments`],
    ['POST', `/customer/bookings/${id}/payments/${paymentId}/refresh`],
    ['POST', `/customer/bookings/${id}/cancel`, { reason: 'not mine' }],
    [
      'POST',
      `/customer/bookings/${id}/reschedule`,
      { startAt: world.at(15).toISOString(), reason: 'x' },
    ],
    ['POST', `/customer/bookings/${id}/rating`, { score: 1 }],
  ];

  it('every booking route answers someone else’s booking exactly like a missing one', async () => {
    const bobApi = api.as(bob.accessToken);
    for (const [method, path, body] of customerRoutes(aliceBooking, alicePayment)) {
      const theirs = await bobApi.send(method, path, body);
      const missing = await bobApi.send(method, path.replace(aliceBooking, randomUUID()), body);
      expect({ path, status: theirs.status }).toEqual({ path, status: 404 });
      expect({ path, code: codeOf(theirs.body) }).toEqual({
        path,
        code: codeOf(missing.body),
      });
      expect(JSON.stringify(theirs.body)).not.toContain('Alice');
    }
    // Alice's booking is untouched.
    const own = await api.as(alice.accessToken).get<Json>(`/customer/bookings/${aliceBooking}`);
    expect(own.body['status']).toBe('ASSIGNED');
    expect(own.body['rating']).toBeNull();
  });

  it('a customer cannot use another customer’s payment id on their own booking', async () => {
    const bobBooking = await api.as(bob.accessToken).post<Json>(
      '/customer/bookings',
      {
        serviceId: world.serviceId,
        addressId: (
          await api.as(bob.accessToken).post<Json>(
            '/customer/addresses',
            {
              contactName: 'Bob',
              contactPhone: bob.phone,
              houseNumber: '3',
              pincode: world.pincode,
              cityName: 'Noida',
              lat: world.center.lat,
              lng: world.center.lng,
            },
            { 'idempotency-key': randomUUID() },
          )
        ).body['id'],
        bookingType: 'SCHEDULED',
        startAt: world.at(16).toISOString(),
        expectedTotalPaise: 58_882,
      },
      { 'idempotency-key': randomUUID() },
    );
    const res = await api
      .as(bob.accessToken)
      .post(
        `/customer/bookings/${bobBooking.body['id'] as string}/payments/${alicePayment}/refresh`,
      );
    expect(res.status).toBe(404);
  });

  it('addresses, support cases and SOS cannot be tied to someone else’s records', async () => {
    const bobApi = api.as(bob.accessToken);
    expect((await bobApi.post(`/customer/addresses/${aliceAddress}/archive`)).status).toBe(404);
    const booking = await bobApi.post(
      '/customer/bookings',
      {
        serviceId: world.serviceId,
        addressId: aliceAddress,
        bookingType: 'SCHEDULED',
        startAt: world.at(17).toISOString(),
        expectedTotalPaise: 58_882,
      },
      { 'idempotency-key': randomUUID() },
    );
    expect(booking.status).toBe(404);
    const ticket = await bobApi.post(
      '/customer/support-cases',
      { bookingId: aliceBooking, category: 'OTHER', subject: 'hello', description: 'hello there' },
      { 'idempotency-key': randomUUID() },
    );
    expect(ticket.status).toBe(404);
    const sos = await bobApi.post(
      '/customer/sos',
      { bookingId: aliceBooking },
      { 'idempotency-key': randomUUID() },
    );
    expect(sos.status).toBe(404);
    const list = await bobApi.get<{ items: Json[] }>('/customer/bookings');
    expect(list.body.items.map((b) => b['id'])).not.toContain(aliceBooking);
    const addresses = await bobApi.get<Json[]>('/customer/addresses');
    expect(addresses.body.map((a) => a['id'])).not.toContain(aliceAddress);
  });
});

describe('workers only see and act on their own jobs', () => {
  it('another worker can neither read nor move the job, and sees no address', async () => {
    const w = api.as(intruder.accessToken);
    const attempts: [Method, string, unknown?][] = [
      ['GET', `/worker/jobs/${aliceBooking}`],
      ['POST', `/worker/jobs/${aliceBooking}/en-route`],
      ['POST', `/worker/jobs/${aliceBooking}/arrived`],
      ['POST', `/worker/jobs/${aliceBooking}/start`, { code: '1234' }],
      ['POST', `/worker/jobs/${aliceBooking}/complete`],
      ['POST', `/worker/jobs/${aliceBooking}/customer-no-show`, { reason: 'not there' }],
      ['POST', `/worker/jobs/${aliceBooking}/withdraw`, { reason: 'not mine' }],
      ['POST', `/worker/offers/${aliceOffer}/reject`, { reason: 'not mine' }],
    ];
    for (const [method, path, body] of attempts) {
      const res = await w.send(method, path, body);
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
      expect(JSON.stringify(res.body)).not.toContain('Flat 7');
    }
    expect(JSON.stringify((await w.get('/worker/jobs')).body)).not.toContain(aliceBooking);
    expect((await w.get('/worker/jobs/current')).body).toBeNull();
    const sos = await w.post(
      '/worker/sos',
      { bookingId: aliceBooking },
      { 'idempotency-key': randomUUID() },
    );
    expect(sos.status).toBe(404);
  });

  it('the assigned worker sees the address while the job is active, and not after it', async () => {
    const w = api.as(assigned.accessToken);
    const active = await w.get<{ address: Json; customerFirstName: string }>(
      `/worker/jobs/${aliceBooking}`,
    );
    expect(active.body.address['houseNumber']).toBe('Flat 7, Tower B');
    expect(active.body.address['accessNotes']).toBe('Gate code 4412');
    expect(active.body.address['contactPhone']).toBeTruthy();

    await w.post(`/worker/jobs/${aliceBooking}/en-route`);
    await w.post(`/worker/jobs/${aliceBooking}/arrived`);
    const code = await api
      .as(alice.accessToken)
      .get<Json>(`/customer/bookings/${aliceBooking}/start-code`);
    expect(
      (await w.post(`/worker/jobs/${aliceBooking}/start`, { code: code.body['code'] })).status,
    ).toBe(200);
    expect((await w.post(`/worker/jobs/${aliceBooking}/complete`)).status).toBe(200);

    const after = await w.get<{ address: Json }>(`/worker/jobs/${aliceBooking}`);
    expect(after.status).toBe(200);
    // Only the area remains: no door, no gate code, no phone, no exact pin.
    expect(after.body.address).toMatchObject({
      houseNumber: null,
      building: null,
      street: null,
      landmark: null,
      accessNotes: null,
      contactPhone: null,
      lat: null,
      lng: null,
      pincode: world.pincode,
    });
    expect(JSON.stringify(after.body)).not.toContain('Gate code');
    await runJob(app, 'settle-bookings');
    const closed = await w.get<{ address: Json }>(`/worker/jobs/${aliceBooking}`);
    expect(closed.body.address['houseNumber']).toBeNull();
  });
});

describe('staff access follows permissions, cities and apps', () => {
  it('app tokens are only accepted by their own app’s routes', async () => {
    const customerOnAdmin = await api.as(alice.accessToken).get('/admin/bookings');
    expect(customerOnAdmin.status).toBe(403);
    // Configuration routes too (they also require permissions customers never have).
    const config = await api.as(alice.accessToken).get('/admin/config/cities');
    expect(config.status).toBe(403);
    expect(codeOf(config.body)).toBe('WRONG_APP');
    const integrations = await api.as(assigned.accessToken).get('/admin/integrations');
    expect(codeOf(integrations.body)).toBe('WRONG_APP');
    const workerOnCustomer = await api.as(assigned.accessToken).get('/customer/bookings');
    expect(codeOf(workerOnCustomer.body)).toBe('WRONG_APP');
    const staff = await signInStaff(api, await createStaff(app, ['DISPATCHER']));
    const staffOnCustomer = await api.as(staff).get(`/customer/bookings/${aliceBooking}`);
    expect(codeOf(staffOnCustomer.body)).toBe('WRONG_APP');
  });

  it('a city-limited dispatcher cannot open or change a booking in another city', async () => {
    const agent = await signInStaff(
      api,
      await createStaff(app, ['DISPATCHER'], { cityId: otherCity.cityId }),
    );
    const a = api.as(agent);
    expect((await a.get(`/admin/bookings/${aliceBooking}`)).status).toBe(404);
    expect((await a.get(`/admin/bookings/${aliceBooking}/trace`)).status).toBe(404);
    const list = await a.get<{ items: Json[] }>('/admin/bookings');
    expect(JSON.stringify(list.body)).not.toContain(aliceBooking);
    const hold = await a.post(`/admin/bookings/${aliceBooking}/hold`, {
      reason: 'probe',
      expectedVersion: 1,
    });
    expect([403, 404]).toContain(hold.status);
  });

  it('contact details are masked by default; a role without reveal cannot unmask them', async () => {
    for (const role of ['CUSTOMER_SUPPORT', 'AUDITOR']) {
      const token = await signInStaff(api, await createStaff(app, [role]));
      const detail = await api.as(token).get<Json>(`/admin/bookings/${aliceBooking}`);
      expect(detail.status).toBe(200);
      const text = JSON.stringify(detail.body);
      expect(text).not.toContain(alice.phone.slice(-10));
      expect(text).not.toContain('Gate code 4412');
      expect(text).not.toContain('Flat 7, Tower B');
    }
    const auditor = await signInStaff(api, await createStaff(app, ['AUDITOR']));
    const reveal = await api
      .as(auditor)
      .post(`/admin/customers/${alice.user.id}/reveal`, { reason: 'curious' });
    expect(reveal.status).toBe(403);
    expect(codeOf(reveal.body)).toBe('PERMISSION_DENIED');
  });
});

describe('lost or stolen phones', () => {
  it('the owner can sign out of every device at once', async () => {
    const first = await signInWithOtp(app, api, 'customer');
    // The same person signed in on a second phone.
    const second = await inTransaction(app.db, SYSTEM, (tx) =>
      app.http.get(SessionService).create(tx, first.user.id, 'CUSTOMER_APP', {
        ip: null,
        userAgent: 'second phone',
        requestId: randomUUID(),
      }),
    );
    expect((await api.as(second.accessToken).post('/auth/logout-all')).status).toBe(204);
    for (const session of [first, second]) {
      const res = await api.as(session.accessToken).get('/customer/me');
      expect(res.status).toBe(401);
      const refresh = await api.post('/auth/refresh', { refreshToken: session.refreshToken });
      expect(refresh.status).toBe(401);
    }
  });

  it('support can end a customer’s sessions, with a reason, and it is audited', async () => {
    const victim = await signInWithOtp(app, api, 'customer');
    const support = await createStaff(app, ['CUSTOMER_SUPPORT']);
    const token = await signInStaff(api, support);
    const res = await api
      .as(token)
      .post<Json>(`/admin/customers/${victim.user.id}/sessions/revoke`, {
        reason: 'Customer called: phone stolen (verified by date of last booking)',
      });
    expect(res.status).toBe(200);
    expect(res.body['revokedSessions']).toBe(1);
    expect((await api.as(victim.accessToken).get('/customer/me')).status).toBe(401);
    const audit = await app.db
      .selectFrom('audit_log')
      .select(['actor_user_id', 'action', 'reason'])
      .where('entity_id', '=', victim.user.id)
      .where('action', '=', 'LOGOUT')
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ actor_user_id: support.userId, action: 'LOGOUT' });
    expect(audit.reason).toContain('phone stolen');
    // An auditor may look, but not sign people out.
    const auditor = await signInStaff(api, await createStaff(app, ['AUDITOR']));
    const denied = await api
      .as(auditor)
      .post(`/admin/customers/${victim.user.id}/sessions/revoke`, { reason: 'Just checking' });
    expect(denied.status).toBe(403);
  });
});

describe('suspension takes effect on existing sessions', () => {
  it('a suspended worker’s old token no longer reaches jobs, offers or customers', async () => {
    const worker = intruder; // an active worker with a live session
    const ops = await signInStaff(api, await createStaff(app, ['WORKER_OPERATIONS']));
    const suspend = await api.as(ops).post(`/admin/workers/${worker.user.id}/status`, {
      status: 'SUSPENDED',
      reason: 'Safety complaint under investigation',
    });
    expect(suspend.status).toBeLessThan(300);

    const w = api.as(worker.accessToken);
    for (const path of ['/worker/offers', '/worker/jobs', '/worker/jobs/current']) {
      const res = await w.get(path);
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
      expect(codeOf(res.body)).toBe('WORKER_NOT_ACTIVE');
    }
    expect((await w.post('/worker/me/presence', { online: true })).status).toBe(403);
    // They can still see why, reach support and raise an SOS.
    const me = await w.get<Json>('/worker/me');
    expect(me.body['status']).toBe('SUSPENDED');
    const sos = await w.post('/worker/sos', {}, { 'idempotency-key': randomUUID() });
    expect(sos.status).toBeLessThan(300);
    const support = await w.post(
      '/worker/support-cases',
      { category: 'WORKER_PAYOUT', subject: 'Suspension', description: 'Why was I suspended?' },
      { 'idempotency-key': randomUUID() },
    );
    expect(support.status).toBeLessThan(300);
    expect((await w.get('/worker/earnings')).status).toBe(200);
    expect((await w.post('/auth/logout')).status).toBe(204);
  });
});
