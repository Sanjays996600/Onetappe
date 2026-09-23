import { randomUUID } from 'node:crypto';
import { SignJWT, decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestOtpSender } from '../src/auth/otp/otp-sender.js';
import { totpAt, totpStep } from '../src/security/totp.js';
import { realClient } from './support/client.js';
import { ApiClient } from './support/http.js';
import {
  NOIDA_SECTOR_62,
  configureInvoiceIssuer,
  deliverWebhook,
  onboardWorkerViaApi,
  runJob,
  sandbox,
} from './support/journey.js';
import { randomMobile, signInWithOtp } from './support/phone-auth.js';
import { createStaff, signInStaff } from './support/staff.js';
import { createTestApp, createWorld, type TestApp, type World } from './support/world.js';

/**
 * The shared client package (@onetappe/api-client) against the real API: every call the
 * apps make is exercised here and every response is checked against the client's schemas,
 * so a change on either side that breaks the apps fails CI.
 */

type Json = Record<string, unknown>;

let app: TestApp;
let api: ApiClient;
let world: World;
let workerTokens: { accessToken: string; refreshToken: string };

beforeAll(async () => {
  app = await createTestApp();
  api = new ApiClient(app.http);
  world = await createWorld(app.db, {
    workers: 0,
    cityName: 'Noida',
    zoneName: 'Sector 62',
    center: NOIDA_SECTOR_62,
  });
  const onboarded = await onboardWorkerViaApi(
    app,
    api,
    await createStaff(app, ['WORKER_OPERATIONS']),
    world,
  );
  workerTokens = onboarded.session;
  await configureInvoiceIssuer(
    api,
    await signInStaff(api, await createStaff(app, ['SUPER_ADMIN'])),
  );
});

afterAll(async () => {
  await app.close();
});

/** A paid booking made through the raw HTTP helper (the customer client group comes later). */
async function paidBooking(hour: number) {
  const session = await signInWithOtp(app, api, 'customer');
  const customer = api.as(session.accessToken);
  const address = await customer.post<Json>(
    '/customer/addresses',
    {
      contactName: 'Asha Rao',
      contactPhone: session.phone,
      houseNumber: 'A-1',
      pincode: world.pincode,
      cityName: 'Noida',
      lat: world.center.lat,
      lng: world.center.lng,
    },
    { 'idempotency-key': randomUUID() },
  );
  const booking = await customer.post<Json>(
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
  const bookingId = booking.body['id'] as string;
  const pay = await customer.post<Json>(`/customer/bookings/${bookingId}/payments`);
  await deliverWebhook(
    api,
    sandbox(app).capture((pay.body['checkout'] as Json)['orderId'] as string),
  );
  return bookingId;
}

describe('admin panel calls', () => {
  it('staff sign-in with authenticator enrolment, then the operations views and a change', async () => {
    const member = await createStaff(app, ['OPERATIONS_HEAD']);
    const client = realClient(app);

    const step = await client.auth.staff.login({ email: member.email, password: member.password });
    expect(step.step).toBe('MFA_ENROLL');
    if (step.step !== 'MFA_ENROLL') return;
    const tokens = await client.auth.staff.completeMfa({
      challengeToken: step.challengeToken,
      code: totpAt(step.totpSecret, totpStep(new Date())),
    });
    client.signIn(tokens);

    const me = await client.admin.me();
    expect(me.roles).toEqual(['OPERATIONS_HEAD']);
    expect(me.permissions['booking.read']).toBe('ALL');
    expect(me.permissions['user.manage']).toBeUndefined();

    const bookingId = await paidBooking(10);
    const rows = await client.admin.bookings.search({ status: 'CONFIRMED', limit: 200 });
    expect(rows.map((r) => r.id)).toContain(bookingId);

    const detail = await client.admin.bookings.get(bookingId);
    expect(detail.status).toBe('CONFIRMED');
    const trace = await client.admin.bookings.trace(bookingId);
    expect(trace.entries.length).toBeGreaterThan(0);
    await client.admin.systemStatus();

    const held = await client.admin.bookings.hold(bookingId, {
      reason: 'Customer asked us to pause',
      expectedVersion: detail.version,
    });
    const after = 'booking' in held ? held.booking : held;
    expect(after.status).toBe('ON_HOLD');

    // The version seen before the change is now stale.
    await expect(
      client.admin.bookings.releaseHold(bookingId, {
        reason: 'Customer confirmed',
        expectedVersion: detail.version,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'STALE_BOOKING' });
  });

  it('staff management calls (super administrator)', async () => {
    const member = await createStaff(app, ['SUPER_ADMIN']);
    const client = realClient(app);
    const step = await client.auth.staff.login({ email: member.email, password: member.password });
    if (step.step !== 'MFA_ENROLL') throw new Error('expected enrolment');
    client.signIn(
      await client.auth.staff.completeMfa({
        challengeToken: step.challengeToken,
        code: totpAt(step.totpSecret, totpStep(new Date())),
      }),
    );
    const reason = 'Contract check of staff calls';
    const cities = await client.admin.config.cities();
    expect(cities.map((c) => c.id)).toContain(world.cityId);
    const created = await client.admin.staff.invite({
      email: `contract.${Date.now()}@onetappe.test`,
      fullName: 'Contract Check',
      grants: [{ role: 'DISPATCHER', cityId: world.cityId }],
      reason,
    });
    expect(created.invitation.token.length).toBeGreaterThan(20);
    await client.admin.staff.grant(created.userId, { role: 'AUDITOR', cityId: null, reason });
    await client.admin.staff.revoke(created.userId, { role: 'AUDITOR', cityId: null, reason });
    await client.admin.staff.setStatus(created.userId, { status: 'SUSPENDED', reason });
    await client.admin.staff.setStatus(created.userId, { status: 'ACTIVE', reason });
    await client.admin.staff.resetMfa(created.userId, { reason });
    await client.admin.staff.reinvite(created.userId, { reason });
    const listed = (await client.admin.staff.list()).find((m) => m.id === created.userId);
    expect(listed?.roles).toEqual([{ role: 'DISPATCHER', cityId: world.cityId }]);
  });

  it('an expired access token is refreshed transparently', async () => {
    const member = await createStaff(app, ['AUDITOR']);
    const client = realClient(app);
    const step = await client.auth.staff.login({ email: member.email, password: member.password });
    if (step.step !== 'MFA_ENROLL') throw new Error('expected enrolment');
    const tokens = await client.auth.staff.completeMfa({
      challengeToken: step.challengeToken,
      code: totpAt(step.totpSecret, totpStep(new Date())),
    });
    // A token signed with a past expiry is refused as TOKEN_EXPIRED by the API.
    client.signIn({
      accessToken: await expiredCopy(tokens.accessToken),
      refreshToken: tokens.refreshToken,
    });
    expect((await client.admin.me()).roles).toEqual(['AUDITOR']);
    expect(client.tokens()?.refreshToken).not.toBe(tokens.refreshToken); // rotated
  });
});

/** Re-signs the same claims with an expiry in the past, as a token looks after 10 minutes. */
async function expiredCopy(token: string): Promise<string> {
  const claims = decodeJwt(token);
  const past = Math.floor(Date.now() / 1000) - 60;
  return new SignJWT({ sid: claims['sid'], app: claims['app'] })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub ?? '')
    .setIssuer(claims.iss ?? '')
    .setIssuedAt(past - 600)
    .setExpirationTime(past)
    .sign(new TextEncoder().encode(process.env['AUTH_TOKEN_SECRET']));
}

describe('customer and worker app calls: the whole HH60 journey', () => {
  it('sign-in, location, catalogue, quote, booking, payment, job steps, invoice, rating, support', async () => {
    // ---- Customer signs in with the SMS code ----
    const customer = realClient(app);
    const challenge = await customer.auth.customer.requestOtp({ phone: randomMobile() });
    const code = app.http.get(TestOtpSender).latestCodeFor(challenge.phone) ?? '';
    const signedIn = await customer.auth.customer.verifyOtp({
      challengeId: challenge.challengeId,
      phone: challenge.phone,
      code,
    });
    expect(signedIn.user.isNew).toBe(true);
    customer.signIn(signedIn);
    expect((await customer.legal.status()).allAccepted).toBe(true); // nothing published here
    await customer.legal.choose('WHATSAPP', true);
    await customer.customer.updateMe({ fullName: 'Kiran Bedi' });
    expect((await customer.customer.me()).profileComplete).toBe(true);

    // ---- Location and address ----
    const spot = { pincode: world.pincode, lat: world.center.lat + 0.002, lng: world.center.lng };
    expect((await customer.customer.serviceability(spot)).serviceable).toBe(true);
    const address = await customer.customer.addAddress(
      {
        contactName: 'Kiran Bedi',
        contactPhone: challenge.phone,
        houseNumber: 'D-9',
        cityName: 'Noida',
        ...spot,
      },
      randomUUID(),
    );
    expect(address.lat).toBeCloseTo(spot.lat);
    expect((await customer.customer.addresses()).map((a) => a.id)).toContain(address.id);

    // ---- Service, time, price, booking ----
    const catalog = await customer.customer.catalog(spot);
    const service = catalog.categories
      .flatMap((c) => c.services)
      .find((x) => x.id === world.serviceId);
    expect(service?.durationMinutes).toBe(60);
    const detail = await customer.customer.service(world.serviceId);
    const slots = await customer.customer.availability({
      serviceId: world.serviceId,
      addressId: address.id,
      date: world.day,
    });
    const startAt = slots.slots.find((x) => x === world.at(14).toISOString()) ?? '';
    const request = {
      serviceId: world.serviceId,
      addressId: address.id,
      bookingType: 'SCHEDULED' as const,
      startAt,
    };
    const quote = await customer.customer.quote(request);
    const key = randomUUID();
    const booking = await customer.customer.book(
      {
        ...request,
        taskIds: detail.tasks.filter((t) => t.selectedByDefault).map((t) => t.id),
        expectedTotalPaise: quote.totalPaise,
      },
      key,
    );
    expect(booking.status).toBe('PENDING_PAYMENT');
    expect(booking.address.lat).toBeCloseTo(spot.lat);
    // The same request again (network retry) returns the same booking.
    expect(
      (
        await customer.customer.book(
          {
            ...request,
            expectedTotalPaise: quote.totalPaise,
            taskIds: detail.tasks.filter((t) => t.selectedByDefault).map((t) => t.id),
          },
          key,
        )
      ).id,
    ).toBe(booking.id);

    // ---- Payment (server-verified) ----
    const payment = await customer.customer.startPayment(booking.id);
    expect(
      (await customer.customer.refreshPayment(booking.id, payment.paymentId)).booking.status,
    ).toBe('PENDING_PAYMENT');
    await deliverWebhook(api, sandbox(app).capture(payment.checkout.orderId));
    expect((await customer.customer.booking(booking.id)).status).toBe('CONFIRMED');

    // ---- Worker takes the job ----
    const worker = realClient(app, workerTokens);
    expect((await worker.worker.me()).canWork).toBe(true);
    await worker.worker.shifts();
    const offer = (await worker.worker.offers()).find((o) => o.bookingId === booking.id);
    expect(offer).toBeDefined();
    const job = await worker.worker.accept(offer?.offerId ?? '');
    expect(job.status).toBe('ASSIGNED');
    expect((await worker.worker.currentJob())?.bookingId).toBe(booking.id);
    await worker.worker.onTheWay(booking.id);
    await worker.worker.arrived(booking.id);
    const startCode = await customer.customer.startCode(booking.id);
    expect((await worker.worker.start(booking.id, startCode.code)).status).toBe('IN_PROGRESS');
    expect((await customer.customer.booking(booking.id)).worker?.firstName).toBeTruthy();
    expect((await worker.worker.complete(booking.id)).status).toBe('COMPLETED');
    await runJob(app, 'settle-bookings');

    // ---- After the visit ----
    const invoice = await customer.customer.invoice(booking.id);
    expect(invoice.lines.map((l) => l.type)).toEqual(['BASE', 'TAX']);
    expect(invoice.totalPaise).toBe(quote.totalPaise);
    await customer.customer.rate(booking.id, { score: 5, comment: 'Very good' });
    expect((await customer.customer.booking(booking.id)).rating?.score).toBe(5);
    await customer.customer.timeline(booking.id);
    expect((await customer.customer.bookings()).items[0]?.id).toBe(booking.id);
    const inbox = await customer.customer.inbox();
    expect(inbox.length).toBeGreaterThan(0);
    // Messages arrive rendered in the reader's language, not as templates.
    for (const item of inbox) expect(item.body).not.toContain('{{');
    const opened = await customer.customer.openSupportCase(
      {
        bookingId: booking.id,
        category: 'SERVICE_QUALITY',
        subject: 'Kitchen not cleaned fully',
        description: 'The kitchen counter was left wet.',
      },
      randomUUID(),
    );
    expect((await customer.customer.supportCases()).map((c) => c.id)).toContain(opened.id);
    expect((await worker.worker.jobs()).map((j) => j.bookingId)).toContain(booking.id);
    expect((await worker.worker.earnings()).items.length).toBeGreaterThan(0);
    await worker.worker.setOnline(false);
    await customer.customer.registerDevice({
      platform: 'ANDROID',
      pushToken: 'contract-token-0123456789',
    });
    await customer.customer.archiveAddress(address.id);
  });
});
