import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction } from '../src/database/transaction.js';
import { ApiClient } from './support/http.js';
import { signInWithOtp } from './support/phone-auth.js';
import { createStaff, signInStaff } from './support/staff.js';
import { SYSTEM, createTestApp, createWorld, type TestApp, type World } from './support/world.js';

type Json = Record<string, unknown>;
type ErrorBody = { error: { code: string; message: string } };

let app: TestApp;
let api: ApiClient;
let superAdmin: ApiClient;
let finance: ApiClient;
let opsHead: ApiClient;

beforeAll(async () => {
  app = await createTestApp();
  api = new ApiClient(app.http);
  superAdmin = api.as(await signInStaff(api, await createStaff(app, ['SUPER_ADMIN'])));
  finance = api.as(await signInStaff(api, await createStaff(app, ['FINANCE'])));
  opsHead = api.as(await signInStaff(api, await createStaff(app, ['OPERATIONS_HEAD'])));
});

afterAll(async () => {
  await app.close();
});

const unique = () => randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();

/** A signed-in customer with an address in the world's zone. */
async function customerIn(world: World) {
  const session = await signInWithOtp(app, api, 'customer');
  const client = api.as(session.accessToken);
  const address = await client.post<Json>(
    '/customer/addresses',
    {
      contactName: 'Pooja Nair',
      contactPhone: session.phone,
      houseNumber: 'K-3',
      pincode: world.pincode,
      cityName: 'Noida',
      lat: world.center.lat,
      lng: world.center.lng,
    },
    { 'idempotency-key': randomUUID() },
  );
  return { client, addressId: address.body['id'] as string };
}

function quote(
  client: ApiClient,
  world: World,
  addressId: string,
  hour: number,
  promoCode: string | null = null,
) {
  return client.post<Json & ErrorBody>('/customer/quotes', {
    serviceId: world.serviceId,
    addressId,
    bookingType: 'SCHEDULED',
    startAt: world.at(hour).toISOString(),
    promoCode,
  });
}

describe('service areas', () => {
  it('sets up a new city end to end and the serviceability check reflects it', async () => {
    const code = unique();
    const city = await superAdmin.post<Json>('/admin/config/cities', {
      code: `GZB${code}`,
      name: 'Ghaziabad',
      stateName: 'Uttar Pradesh',
      timeZone: 'Asia/Kolkata',
      reason: 'Expansion pilot preparation',
    });
    expect(city.status).toBe(201);
    expect(city.body['is_active']).toBe(false); // nothing goes live by accident
    const cityId = city.body['id'] as string;
    const zone = await superAdmin.post<Json>('/admin/config/zones', {
      cityId,
      code: `IND${code}`,
      name: 'Indirapuram',
      centerLat: 28.6412,
      centerLng: 77.3712,
      serviceRadiusM: 3000,
      reason: 'First zone',
    });
    const pincode = `2010${String(Math.floor(Math.random() * 90) + 10)}`;
    await superAdmin.post('/admin/config/pincodes', {
      code: pincode,
      cityId,
      reason: 'Indirapuram pincode',
    });
    await superAdmin.post('/admin/config/localities', {
      zoneId: zone.body['id'],
      pincode,
      name: `Niti Khand ${code}`,
      reason: 'First locality',
    });

    const probe = `/admin/config/serviceability-check?pincode=${pincode}&lat=28.642&lng=77.372`;
    expect((await superAdmin.get<Json>(probe)).body['serviceable']).toBe(false); // still inactive

    for (const [path, reason] of [
      [`/admin/config/cities/${cityId}`, 'Go live'],
      [`/admin/config/zones/${zone.body['id'] as string}`, 'Go live'],
      [`/admin/config/pincodes/${pincode}`, 'Go live'],
    ] as const) {
      expect((await superAdmin.patch(path, { isActive: true, reason })).status).toBe(200);
    }
    const locality = await superAdmin.get<Json[]>(
      `/admin/config/localities?zoneId=${zone.body['id'] as string}`,
    );
    await superAdmin.patch(`/admin/config/localities/${locality.body[0]?.['id'] as string}`, {
      isActive: true,
      reason: 'Go live',
    });
    expect((await superAdmin.get<Json>(probe)).body['serviceable']).toBe(true);
    // Outside the zone radius the same pincode is not served.
    const far = await superAdmin.get<Json>(
      `/admin/config/serviceability-check?pincode=${pincode}&lat=28.75&lng=77.5`,
    );
    expect(far.body['serviceable']).toBe(false);

    const audit = await app.db
      .selectFrom('audit_log')
      .select(['action', 'reason'])
      .where('entity_type', '=', 'zone')
      .where('entity_id', '=', zone.body['id'] as string)
      .orderBy('id')
      .execute();
    expect(audit.map((a) => a.reason)).toEqual(['First zone', 'Go live']);
  });

  it('every change needs a reason', async () => {
    const res = await superAdmin.post<ErrorBody>('/admin/config/cities', {
      code: `X${unique()}`,
      name: 'Nowhere',
      stateName: 'Nowhere',
      timeZone: 'Asia/Kolkata',
    });
    expect(res.status).toBe(400);
  });

  it('a city-scoped manager can change only their own city', async () => {
    const mine = await createWorld(app.db, { workers: 0 });
    const other = await createWorld(app.db, { workers: 0 });
    const scoped = api.as(
      await signInStaff(api, await createStaff(app, ['OPERATIONS_HEAD'], { cityId: mine.cityId })),
    );
    expect(
      (
        await scoped.patch(`/admin/config/zones/${mine.zoneId}`, {
          serviceRadiusM: 4000,
          reason: 'Wider coverage',
        })
      ).status,
    ).toBe(200);
    const denied = await scoped.patch<ErrorBody>(`/admin/config/zones/${other.zoneId}`, {
      serviceRadiusM: 4000,
      reason: 'Wider coverage',
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('OUTSIDE_CITY_SCOPE');
    const newCity = await scoped.post<ErrorBody>('/admin/config/cities', {
      code: `S${unique()}`,
      name: 'Somewhere',
      stateName: 'Somewhere',
      timeZone: 'Asia/Kolkata',
      reason: 'Should not be allowed',
    });
    expect(newCity.body.error.code).toBe('CITY_SCOPE_REQUIRED');
  });
});

describe('operating hours', () => {
  it('bookings and availability respect the zone’s hours; service hours override; ending restores', async () => {
    const world = await createWorld(app.db, { workers: 2 });
    const { client, addressId } = await customerIn(world);
    const weekday = new Date(`${world.day}T12:00:00+05:30`).getUTCDay() || 7;

    const zoneHours = await opsHead.post<Json>('/admin/config/operating-hours', {
      zoneId: world.zoneId,
      weekday,
      openMinute: 10 * 60,
      closeMinute: 14 * 60,
      reason: 'Launch hours 10:00-14:00',
    });
    expect(zoneHours.status).toBe(201);

    const book = (hour: number) =>
      client.post<Json & ErrorBody>(
        '/customer/bookings',
        {
          serviceId: world.serviceId,
          addressId,
          bookingType: 'SCHEDULED',
          startAt: world.at(hour).toISOString(),
          expectedTotalPaise: 58_882,
        },
        { 'idempotency-key': randomUUID() },
      );
    const late = await book(16);
    expect(late.status).toBe(422);
    expect(late.body.error.code).toBe('OUTSIDE_OPERATING_HOURS');
    const ok = await book(11);
    expect(ok.status).toBe(201);

    const slots = await client.get<{ slots: string[] }>(
      `/customer/availability?serviceId=${world.serviceId}&addressId=${addressId}&date=${world.day}`,
    );
    const hours = slots.body.slots.map((s) => new Date(s).getTime());
    expect(hours.length).toBeGreaterThan(0);
    expect(Math.min(...hours)).toBeGreaterThanOrEqual(world.at(10).getTime());
    // A 60-minute visit must also end by 14:00.
    expect(Math.max(...hours)).toBeLessThanOrEqual(world.at(13).getTime());

    // Hours for this service replace the zone's general hours.
    const serviceHours = await opsHead.post<Json>('/admin/config/operating-hours', {
      zoneId: world.zoneId,
      serviceId: world.serviceId,
      weekday,
      openMinute: 15 * 60,
      closeMinute: 18 * 60,
      reason: 'House help runs afternoons only',
    });
    expect((await book(16)).status).toBe(201);
    expect((await book(12)).body.error.code).toBe('OUTSIDE_OPERATING_HOURS');

    for (const id of [serviceHours.body['id'], zoneHours.body['id']] as string[]) {
      const ended = await opsHead.post(`/admin/config/operating-hours/${id}/end`, {
        reason: 'Hours removed',
      });
      expect(ended.status).toBe(201);
    }
    expect((await book(9)).status).toBe(201); // no hours configured: unrestricted again
  });

  it('the database refuses rewriting hours instead of ending them', async () => {
    const world = await createWorld(app.db, { workers: 0 });
    const created = await opsHead.post<Json>('/admin/config/operating-hours', {
      zoneId: world.zoneId,
      weekday: 1,
      openMinute: 600,
      closeMinute: 900,
      reason: 'Monday hours',
    });
    await expect(
      inTransaction(app.db, SYSTEM, (tx) =>
        tx
          .updateTable('operating_hours')
          .set({ close_minute: 1200 })
          .where('id', '=', created.body['id'] as string)
          .execute(),
      ),
    ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
  });
});

describe('prices, payouts and taxes', () => {
  it('replacing a price changes new quotes only; bookings keep the price they were given', async () => {
    const world = await createWorld(app.db, { workers: 2 });
    const { client, addressId } = await customerIn(world);
    const before = await quote(client, world, addressId, 10);
    expect(before.body['totalPaise']).toBe(58_882);

    const booked = await client.post<Json>(
      '/customer/bookings',
      {
        serviceId: world.serviceId,
        addressId,
        bookingType: 'SCHEDULED',
        startAt: world.at(10).toISOString(),
        expectedTotalPaise: 58_882,
      },
      { 'idempotency-key': randomUUID() },
    );

    const rules = await finance.get<Json[]>(
      `/admin/config/price-rules?serviceId=${world.serviceId}`,
    );
    const current = rules.body[0];
    const replaced = await finance.post<Json>(
      `/admin/config/price-rules/${current?.['id'] as string}/replace`,
      {
        baseAmountPaise: 59_900,
        effectiveFrom: new Date().toISOString(),
        reason: 'Price revision approved by management',
      },
    );
    expect(replaced.status).toBe(201);

    const after = await quote(client, world, addressId, 12);
    expect(after.body['totalPaise']).toBe(70_682); // 59,900 + 18% GST
    const existing = await client.get<Json>(`/customer/bookings/${booked.body['id'] as string}`);
    expect(
      existing.body['totalPaise'] ?? (existing.body['price'] as Json | undefined)?.['totalPaise'],
    ).toBe(58_882);
  });

  it('the database refuses rewriting an amount or ending a rule in the past', async () => {
    const world = await createWorld(app.db, { workers: 0 });
    const rule = await app.db
      .selectFrom('price_rule')
      .select('id')
      .where('service_id', '=', world.serviceId)
      .executeTakeFirstOrThrow();
    await expect(
      inTransaction(app.db, SYSTEM, (tx) =>
        tx
          .updateTable('price_rule')
          .set({ base_amount_paise: 1 })
          .where('id', '=', rule.id)
          .execute(),
      ),
    ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
    await expect(
      inTransaction(app.db, SYSTEM, (tx) =>
        tx
          .updateTable('price_rule')
          .set({ valid_to: new Date('2021-01-01T00:00:00Z') })
          .where('id', '=', rule.id)
          .execute(),
      ),
    ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
    const pastStart = await finance.post<ErrorBody>('/admin/config/price-rules', {
      serviceId: world.serviceId,
      baseAmountPaise: 100,
      taxRateCode: 'GST18',
      validFrom: '2021-01-01T00:00:00Z',
      reason: 'Backdated price',
    });
    expect(pastStart.status).toBe(400);
  });

  it('money changes need a recent authenticator check', async () => {
    const member = await createStaff(app, ['FINANCE']);
    const token = await signInStaff(api, member);
    await app.db
      .updateTable('auth_session')
      .set({ mfa_verified_at: sql<Date>`now() - interval '20 minutes'` })
      .where('user_id', '=', member.userId)
      .execute();
    const world = await createWorld(app.db, { workers: 0 });
    const res = await api.as(token).post<ErrorBody>('/admin/config/payout-rules', {
      serviceId: world.serviceId,
      basePayoutPaise: 32_000,
      validFrom: new Date(Date.now() + 60_000).toISOString(),
      reason: 'Payout revision',
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MFA_REQUIRED');
  });

  it('previews the customer quote and the worker payout from the live rules', async () => {
    const world = await createWorld(app.db, { workers: 0 });
    const res = await finance.post<Json>('/admin/config/pricing/preview', {
      serviceId: world.serviceId,
      zoneId: world.zoneId,
      startAt: world.at(11).toISOString(),
    });
    expect(res.status).toBe(200);
    expect((res.body['quote'] as Json)['totalPaise']).toBe(58_882);
    expect(res.body['payout']).toMatchObject({
      basePayoutPaise: 30_000,
      travelAllowancePaise: 3_000,
    });
  });

  it('a tax rate (which has no on/off switch) can be ended', async () => {
    const tax = await finance.post<Json>('/admin/config/tax-rates', {
      code: `T${unique()}`,
      name: 'Test levy',
      rateBp: 500,
      effectiveFrom: new Date(Date.now() + 60_000).toISOString(),
      reason: 'New levy',
    });
    expect(tax.status).toBe(201);
    const endAt = new Date(Date.now() + 3_600_000).toISOString();
    const ended = await finance.post<Json>(
      `/admin/config/tax-rates/${tax.body['id'] as string}/end`,
      {
        at: endAt,
        reason: 'Levy withdrawn',
      },
    );
    expect(ended.status).toBe(201);
    expect(new Date(ended.body['effective_to'] as string).toISOString()).toBe(endAt);
    const again = await finance.post<ErrorBody>(
      `/admin/config/tax-rates/${tax.body['id'] as string}/end`,
      { at: new Date(Date.now() + 7_200_000).toISOString(), reason: 'Moving the end' },
    );
    expect(again.status).toBe(201); // not yet ended, so the end may still move forward
  });

  it('only finance (pricing.manage) can change prices', async () => {
    const world = await createWorld(app.db, { workers: 0 });
    const res = await opsHead.post('/admin/config/price-rules', {
      serviceId: world.serviceId,
      baseAmountPaise: 100,
      taxRateCode: 'GST18',
      validFrom: new Date().toISOString(),
      reason: 'Not my job',
    });
    expect(res.status).toBe(403);
  });
});

describe('catalogue', () => {
  it('a new service starts switched off and cannot go live without a price and a payout', async () => {
    const world = await createWorld(app.db, { workers: 0 });
    const category = await app.db
      .selectFrom('service')
      .select('category_id')
      .where('id', '=', world.serviceId)
      .executeTakeFirstOrThrow();
    const service = await superAdmin.post<Json>('/admin/config/services', {
      categoryId: category.category_id,
      code: `DEEP_CLEAN_${unique()}`,
      name: 'Deep cleaning',
      durationMinutes: 240,
      bufferBeforeMinutes: 30,
      bufferAfterMinutes: 30,
      workersRequired: 2,
      supportsInstant: false,
      supportsScheduled: true,
      minLeadTimeMinutes: 720,
      maxAdvanceDays: 30,
      paymentHoldMinutes: 15,
      offerTimeoutSeconds: 300,
      requiresStartCode: true,
      sortOrder: 2,
      reason: 'New service: deep cleaning',
    });
    expect(service.status).toBe(201);
    expect(service.body['is_active']).toBe(false);
    const live = await superAdmin.patch<ErrorBody>(
      `/admin/config/services/${service.body['id'] as string}`,
      {
        isActive: true,
        reason: 'Launch',
      },
    );
    expect(live.status).toBe(422);
    expect(live.body.error.code).toBe('SERVICE_NOT_READY');
  });
});

describe('promotions', () => {
  it('a promotion applies to quotes, can be switched off, and its discount cannot be rewritten', async () => {
    const world = await createWorld(app.db, { workers: 1 });
    const { client, addressId } = await customerIn(world);
    const code = `WELCOME${unique()}`;
    const created = await opsHead.post<Json>('/admin/config/promotions', {
      code,
      description: 'Launch offer: Rs 100 off',
      discountType: 'FLAT',
      value: 10_000,
      validFrom: new Date(Date.now() - 60_000).toISOString(),
      validTo: new Date(Date.now() + 86_400_000).toISOString(),
      serviceIds: [world.serviceId],
      reason: 'Launch campaign',
    });
    expect(created.status).toBe(201);
    const discounted = await quote(client, world, addressId, 11, code);
    expect(discounted.body['totalPaise']).toBeLessThan(58_882);

    await opsHead.patch(`/admin/config/promotions/${created.body['id'] as string}`, {
      isActive: false,
      reason: 'Campaign ended early',
    });
    expect((await quote(client, world, addressId, 11, code)).status).toBeGreaterThanOrEqual(400);

    await expect(
      inTransaction(app.db, SYSTEM, (tx) =>
        tx
          .updateTable('promotion')
          .set({ value: 50_000 })
          .where('id', '=', created.body['id'] as string)
          .execute(),
      ),
    ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
  });
});

describe('settings and notifications', () => {
  it('only known settings with a valid shape can be saved', async () => {
    const unknown = await superAdmin.send<ErrorBody>('PUT', '/admin/settings/invoice.issur', {
      value: { legalName: 'x' },
      description: 'typo',
      reason: 'Typo in the key',
    });
    expect(unknown.status).toBe(404);
    const invalid = await superAdmin.send<ErrorBody>('PUT', '/admin/settings/invoice.issuer', {
      value: { legalName: 'One Tappe', gstin: 'bad', address: 'Sector 62, Noida', series: 'OT' },
      description: 'Issuer',
      reason: 'Set invoice issuer',
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('SETTING_INVALID');
  });

  it('publishing a template retires the previous version; routes can be switched', async () => {
    const admin = api.as(await signInStaff(api, await createStaff(app, ['SUPER_ADMIN'])));
    const published = await admin.post<Json>('/admin/config/notifications/templates', {
      event: 'WORKER_ARRIVED',
      channel: 'PUSH',
      locale: 'en',
      title: 'Your helper is here',
      body: 'Your helper has arrived for booking {{bookingCode}}.',
      reason: 'Friendlier wording',
    });
    expect(published.status).toBe(201);
    const active = await app.db
      .selectFrom('notification_template')
      .select(['version', 'is_active'])
      .where('code', '=', 'WORKER_ARRIVED')
      .where('channel', '=', 'PUSH')
      .where('locale', '=', 'en')
      .where('is_active', '=', true)
      .execute();
    expect(active).toEqual([{ version: published.body['version'], is_active: true }]);

    const route = await admin.send<Json>('PUT', '/admin/config/notifications/routes', {
      event: 'WORKER_ARRIVED',
      channel: 'SMS',
      isEnabled: false,
      reason: 'Push is enough for arrival',
    });
    expect(route.body['is_enabled']).toBe(false);
  });
});
