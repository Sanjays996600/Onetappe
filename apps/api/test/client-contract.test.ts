import { randomUUID } from 'node:crypto';
import { SignJWT, decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpAt, totpStep } from '../src/security/totp.js';
import { realClient } from './support/client.js';
import { ApiClient } from './support/http.js';
import {
  NOIDA_SECTOR_62,
  deliverWebhook,
  onboardWorkerViaApi,
  sandbox,
} from './support/journey.js';
import { signInWithOtp } from './support/phone-auth.js';
import { createStaff } from './support/staff.js';
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

beforeAll(async () => {
  app = await createTestApp();
  api = new ApiClient(app.http);
  world = await createWorld(app.db, {
    workers: 0,
    cityName: 'Noida',
    zoneName: 'Sector 62',
    center: NOIDA_SECTOR_62,
  });
  await onboardWorkerViaApi(app, api, await createStaff(app, ['WORKER_OPERATIONS']), world);
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
