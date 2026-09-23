import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { inTransaction } from '../src/database/transaction.js';
import { FakeMessaging } from './support/fake-messaging.js';
import { ApiClient } from './support/http.js';
import { deliverWebhook, runJob, sandbox } from './support/journey.js';
import { signInWithOtp } from './support/phone-auth.js';
import { SYSTEM, createTestApp, createWorld, type TestApp, type World } from './support/world.js';

type Json = Record<string, unknown>;

let fake: FakeMessaging;
let app: TestApp;
let api: ApiClient;
let world: World;
let hour = 8;

beforeAll(async () => {
  fake = await FakeMessaging.start();
  app = await createTestApp(fake.env());
  api = new ApiClient(app.http);
  world = await createWorld(app.db, { workers: 8 });
  // The DLT template registered with MSG91 for the confirmation SMS (configuration).
  await setSmsTemplateId('BOOKING_CONFIRMED', 'dlt-booking-confirmed');
});

afterAll(async () => {
  await setRoute('BOOKING_CONFIRMED', 'SMS', true);
  await app.close();
  await fake.close();
});

async function setSmsTemplateId(code: string, templateId: string | null) {
  await inTransaction(app.db, SYSTEM, (tx) =>
    tx
      .updateTable('notification_template')
      .set({ provider_template_id: templateId })
      .where('code', '=', code)
      .where('channel', '=', 'SMS')
      .execute(),
  );
}

async function setRoute(event: string, channel: string, enabled: boolean) {
  await inTransaction(app.db, SYSTEM, (tx) =>
    tx
      .updateTable('notification_route')
      .set({ is_enabled: enabled })
      .where('event_code', '=', event)
      .where('channel', '=', channel)
      .execute(),
  );
}

/** A customer with registered phones, who books and pays. */
async function paidBooking(devices: string[] = [`fcm-${randomUUID()}`]) {
  const session = await signInWithOtp(app, api, 'customer');
  const client = api.as(session.accessToken);
  for (const token of devices) {
    expect(
      (await client.post('/customer/devices', { platform: 'ANDROID', pushToken: token })).status,
    ).toBeLessThan(300);
  }
  const address = await client.post<Json>(
    '/customer/addresses',
    {
      contactName: 'Neha Gupta',
      contactPhone: session.phone,
      houseNumber: 'H-4',
      pincode: world.pincode,
      cityName: 'Noida',
      lat: world.center.lat,
      lng: world.center.lng,
    },
    { 'idempotency-key': randomUUID() },
  );
  hour = hour >= 17 ? 9 : hour + 1;
  const booking = await client.post<Json>(
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
  const pay = await client.post<Json>(`/customer/bookings/${bookingId}/payments`);
  await deliverWebhook(
    api,
    sandbox(app).capture((pay.body['checkout'] as Json)['orderId'] as string),
  );
  return { session, client, bookingId, devices };
}

function notificationsFor(bookingId: string, code: string) {
  return app.db
    .selectFrom('notification as n')
    .innerJoin('notification_template as t', 't.id', 'n.template_id')
    .select(['n.channel', 'n.status', 'n.attempts', 'n.skipped_reason', 'n.last_error'])
    .where('n.booking_id', '=', bookingId)
    .where('t.code', '=', code)
    .orderBy('n.channel')
    .execute();
}

/** Runs the dispatcher until the queue is drained (earlier test files leave messages queued). */
async function dispatch(): Promise<void> {
  for (let round = 0; round < 100; round += 1) {
    const result = await runJob(app, 'dispatch-notifications');
    if (result.processed === 0) return;
  }
  throw new Error('Notification queue did not drain');
}

describe('delivery through the configured providers', () => {
  it('a confirmed booking reaches the customer by push (FCM), SMS (MSG91 DLT template) and in-app', async () => {
    const { session, bookingId, devices } = await paidBooking();
    await dispatch();

    const confirmed = await notificationsFor(bookingId, 'BOOKING_CONFIRMED');
    expect(confirmed.map((n) => [n.channel, n.status])).toEqual([
      ['IN_APP', 'SENT'],
      ['PUSH', 'SENT'],
      ['SMS', 'SENT'],
    ]);
    const push = fake.pushes.find(
      (p) => p.token === devices[0] && p.data['event'] === 'BOOKING_CONFIRMED',
    );
    expect(push?.data['bookingId']).toBe(bookingId);
    const sms = fake.sms.find((s) => s.recipient['mobiles'] === session.phone.replace('+', ''));
    expect(sms?.templateId).toBe('dlt-booking-confirmed');
    expect(sms?.recipient).toHaveProperty('bookingCode');
  });

  it('an uninstalled app (UNREGISTERED token) is retired; other devices still get the message', async () => {
    const good = `fcm-${randomUUID()}`;
    const bad = `fcm-${randomUUID()}`;
    fake.invalidTokens.add(bad);
    const { bookingId } = await paidBooking([bad, good]);
    await dispatch();

    const [push] = (await notificationsFor(bookingId, 'BOOKING_CONFIRMED')).filter(
      (n) => n.channel === 'PUSH',
    );
    expect(push?.status).toBe('SENT');
    const devices = await app.db
      .selectFrom('user_device')
      .select(['push_token', 'disabled_at'])
      .where('push_token', 'in', [good, bad])
      .execute();
    expect(devices.find((d) => d.push_token === bad)?.disabled_at).not.toBeNull();
    expect(devices.find((d) => d.push_token === good)?.disabled_at).toBeNull();
  });

  it('a provider outage leaves the booking intact; messages are retried and delivered later', async () => {
    fake.down = true;
    const { client, bookingId } = await paidBooking();
    expect((await client.get<Json>(`/customer/bookings/${bookingId}`)).body['status']).toBe(
      'CONFIRMED',
    );
    await dispatch();
    const failed = (await notificationsFor(bookingId, 'BOOKING_CONFIRMED')).filter(
      (n) => n.channel === 'PUSH',
    );
    expect(failed[0]).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(failed[0]?.last_error).toContain('unreachable');

    fake.down = false;
    await app.db
      .updateTable('notification')
      .set({ next_attempt_at: new Date() })
      .where('booking_id', '=', bookingId)
      .execute();
    await dispatch();
    const retried = (await notificationsFor(bookingId, 'BOOKING_CONFIRMED')).filter(
      (n) => n.channel === 'PUSH',
    );
    expect(retried[0]).toMatchObject({ status: 'SENT', attempts: 2 });
  });

  it('an SMS without a registered DLT template fails at once (retrying cannot help) and is visible', async () => {
    await setSmsTemplateId('BOOKING_CONFIRMED', null);
    try {
      const { bookingId } = await paidBooking();
      await dispatch();
      const sms = (await notificationsFor(bookingId, 'BOOKING_CONFIRMED')).find(
        (n) => n.channel === 'SMS',
      );
      expect(sms).toMatchObject({ status: 'FAILED', attempts: 5 });
      expect(sms?.last_error).toContain('template');
    } finally {
      await setSmsTemplateId('BOOKING_CONFIRMED', 'dlt-booking-confirmed');
    }
  });
});

describe('routing is configuration', () => {
  it('a channel switched off for an event is not used', async () => {
    await setRoute('BOOKING_CONFIRMED', 'SMS', false);
    try {
      const { bookingId } = await paidBooking();
      const channels = (await notificationsFor(bookingId, 'BOOKING_CONFIRMED')).map(
        (n) => n.channel,
      );
      expect(channels).toEqual(['IN_APP', 'PUSH']);
    } finally {
      await setRoute('BOOKING_CONFIRMED', 'SMS', true);
    }
  });

  it('a message queued before its route was switched off is skipped, not sent', async () => {
    const { bookingId } = await paidBooking();
    await setRoute('BOOKING_CONFIRMED', 'SMS', false);
    try {
      await dispatch();
      const sms = (await notificationsFor(bookingId, 'BOOKING_CONFIRMED')).find(
        (n) => n.channel === 'SMS',
      );
      expect(sms).toMatchObject({ status: 'SKIPPED', skipped_reason: 'ROUTE_DISABLED' });
    } finally {
      await setRoute('BOOKING_CONFIRMED', 'SMS', true);
    }
  });

  it('WhatsApp needs the customer’s opt-in; email goes through ZeptoMail when the customer has an address', async () => {
    await inTransaction(app.db, SYSTEM, async (tx) => {
      for (const channel of ['WHATSAPP', 'EMAIL'] as const) {
        await tx
          .insertInto('notification_template')
          .values({
            code: 'BOOKING_CONFIRMED',
            channel,
            locale: 'en',
            version: 1,
            title: 'Booking confirmed',
            body: 'Your booking {{bookingCode}} is confirmed.',
          })
          .onConflict((oc) => oc.doNothing())
          .execute();
        await tx
          .insertInto('notification_route')
          .values({ event_code: 'BOOKING_CONFIRMED', channel })
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
    });
    try {
      const session = await signInWithOtp(app, api, 'customer');
      await api.as(session.accessToken).patch('/customer/me', { email: 'neha@example.com' });
      const { bookingId } = await paidBookingFor(session);
      await dispatch();
      const all = await notificationsFor(bookingId, 'BOOKING_CONFIRMED');
      expect(all.find((n) => n.channel === 'WHATSAPP')).toMatchObject({
        status: 'SKIPPED',
        skipped_reason: 'NO_CONSENT',
      });
      expect(all.find((n) => n.channel === 'EMAIL')?.status).toBe('SENT');
      expect(fake.emails.find((e) => e.to === 'neha@example.com')?.text).toContain('is confirmed');
    } finally {
      await setRoute('BOOKING_CONFIRMED', 'WHATSAPP', false);
      await setRoute('BOOKING_CONFIRMED', 'EMAIL', false);
    }
  });
});

async function paidBookingFor(session: Awaited<ReturnType<typeof signInWithOtp>>) {
  const client = api.as(session.accessToken);
  const address = await client.post<Json>(
    '/customer/addresses',
    {
      contactName: 'Neha Gupta',
      contactPhone: session.phone,
      houseNumber: 'H-5',
      pincode: world.pincode,
      cityName: 'Noida',
      lat: world.center.lat,
      lng: world.center.lng,
    },
    { 'idempotency-key': randomUUID() },
  );
  hour = hour >= 17 ? 9 : hour + 1;
  const booking = await client.post<Json>(
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
  const pay = await client.post<Json>(`/customer/bookings/${bookingId}/payments`);
  await deliverWebhook(
    api,
    sandbox(app).capture((pay.body['checkout'] as Json)['orderId'] as string),
  );
  return { bookingId };
}

describe('provider configuration rules', () => {
  const base = {
    ...process.env,
    APP_ENV: 'staging',
    OTP_PROVIDER: 'msg91',
    MSG91_AUTH_KEY: 'k',
    MSG91_TEMPLATE_ID: 't',
    METRICS_TOKEN: 'metrics-token-0123456789-abcdefghijkl',
    STORAGE_PROVIDER: 's3',
    S3_BUCKET: 'onetappe-staging-documents',
    MALWARE_SCANNER: 'clamav',
  };

  it('refuses the log provider outside local/test (it would mark messages sent without sending)', () => {
    expect(() =>
      loadEnv({
        ...base,
        PUSH_PROVIDER: 'log',
        SMS_PROVIDER: 'none',
        EMAIL_PROVIDER: 'none',
        WHATSAPP_PROVIDER: 'none',
      }),
    ).toThrow(/PUSH_PROVIDER=log is only allowed locally/);
  });

  it('requires HTTPS endpoints outside local/test', () => {
    expect(() =>
      loadEnv({
        ...base,
        PUSH_PROVIDER: 'none',
        SMS_PROVIDER: 'none',
        EMAIL_PROVIDER: 'none',
        WHATSAPP_PROVIDER: 'none',
        MSG91_API_URL: 'http://control.msg91.com',
      }),
    ).toThrow(/MSG91_API_URL must use HTTPS/);
  });

  it('accepts a staging setup with real providers or channels switched off', () => {
    expect(() =>
      loadEnv({
        ...base,
        PUSH_PROVIDER: 'none',
        SMS_PROVIDER: 'msg91',
        EMAIL_PROVIDER: 'none',
        WHATSAPP_PROVIDER: 'none',
      }),
    ).not.toThrow();
  });
});

describe('document storage configuration rules', () => {
  const base = {
    ...process.env,
    APP_ENV: 'staging',
    OTP_PROVIDER: 'msg91',
    MSG91_AUTH_KEY: 'k',
    MSG91_TEMPLATE_ID: 't',
    METRICS_TOKEN: 'metrics-token-0123456789-abcdefghijkl',
    PUSH_PROVIDER: 'none',
    SMS_PROVIDER: 'none',
    EMAIL_PROVIDER: 'none',
    WHATSAPP_PROVIDER: 'none',
  };

  it('outside local/test, documents must go to S3 and be scanned', () => {
    expect(() =>
      loadEnv({ ...base, STORAGE_PROVIDER: 'local', MALWARE_SCANNER: 'clamav' }),
    ).toThrow(/must use STORAGE_PROVIDER=s3/);
    expect(() =>
      loadEnv({ ...base, STORAGE_PROVIDER: 's3', S3_BUCKET: 'b', MALWARE_SCANNER: 'none' }),
    ).toThrow(/must use MALWARE_SCANNER=clamav/);
  });

  it('production also requires a customer-managed KMS key', () => {
    expect(() =>
      loadEnv({
        ...base,
        APP_ENV: 'production',
        STORAGE_PROVIDER: 's3',
        S3_BUCKET: 'b',
        MALWARE_SCANNER: 'clamav',
      }),
    ).toThrow(/S3_KMS_KEY_ID/);
  });
});
