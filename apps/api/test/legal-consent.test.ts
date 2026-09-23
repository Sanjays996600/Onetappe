import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction } from '../src/database/transaction.js';
import { ApiClient } from './support/http.js';
import { NOIDA_SECTOR_62, onboardWorkerViaApi } from './support/journey.js';
import { signInWithOtp } from './support/phone-auth.js';
import { createStaff, signInStaff, type StaffMember } from './support/staff.js';
import { SYSTEM, createTestApp, createWorld, type TestApp, type World } from './support/world.js';

type Json = Record<string, unknown>;
type ErrorBody = { error: { code: string; details: Json } };

let app: TestApp;
let api: ApiClient;
let admin: ApiClient;
let workerOps: StaffMember;
let world: World;
const published: string[] = [];

beforeAll(async () => {
  app = await createTestApp();
  api = new ApiClient(app.http);
  admin = api.as(await signInStaff(api, await createStaff(app, ['SUPER_ADMIN'])));
  workerOps = await createStaff(app, ['WORKER_OPERATIONS']);
  world = await createWorld(app.db, {
    workers: 0,
    cityName: 'Noida',
    zoneName: 'Sector 62',
    center: NOIDA_SECTOR_62,
  });
  await onboardWorkerViaApi(app, api, workerOps, world); // before any terms exist
});

// Published documents are immutable and apply to everyone. Remove this file's documents
// (a test-only cleanup, as the schema owner) so other test files are not gated by them.
afterAll(async () => {
  if (published.length > 0) {
    await sql`ALTER TABLE consent_record DISABLE TRIGGER USER`.execute(app.owner);
    await sql`ALTER TABLE legal_document DISABLE TRIGGER USER`.execute(app.owner);
    try {
      await app.owner
        .deleteFrom('consent_record')
        .where('legal_document_id', 'in', published)
        .execute();
      await app.owner.deleteFrom('legal_document').where('id', 'in', published).execute();
    } finally {
      await sql`ALTER TABLE consent_record ENABLE TRIGGER USER`.execute(app.owner);
      await sql`ALTER TABLE legal_document ENABLE TRIGGER USER`.execute(app.owner);
    }
  }
  await app.close();
});

async function publish(code: string, version: string, locale = 'en') {
  const res = await admin.post<Json>('/admin/config/legal-documents', {
    code,
    version,
    locale,
    title: `${code} ${version} (${locale})`,
    url: `https://onetappe.example/legal/${code.toLowerCase()}/${version}/${locale}`,
    contentSha256: createHash('sha256').update(`${code}${version}${locale}`).digest('hex'),
    effectiveFrom: new Date().toISOString(),
    reason: 'Counsel-approved text',
  });
  expect(res.status).toBe(201);
  published.push(res.body['id'] as string);
  return res.body['id'] as string;
}

async function customer() {
  const session = await signInWithOtp(app, api, 'customer');
  const client = api.as(session.accessToken);
  const address = await client.post<Json>(
    '/customer/addresses',
    {
      contactName: 'Kavya Menon',
      contactPhone: session.phone,
      houseNumber: 'D-4',
      pincode: world.pincode,
      cityName: 'Noida',
      lat: world.center.lat,
      lng: world.center.lng,
    },
    { 'idempotency-key': randomUUID() },
  );
  const book = (hour: number) =>
    client.post<Json & ErrorBody>(
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
  return { session, client, book };
}

describe('customer terms', () => {
  it('once published, booking waits for acceptance of the exact current versions', async () => {
    const termsEn = await publish('CUSTOMER_TERMS', '2026.1', 'en');
    const termsHi = await publish('CUSTOMER_TERMS', '2026.1', 'hi');
    const privacy = await publish('PRIVACY_NOTICE', '2026.1', 'en');

    // Shown before sign-up: Hindi where it exists, English otherwise.
    const shown = await api.get<Json[]>('/legal/documents?app=CUSTOMER_APP&locale=hi');
    expect(shown.body.map((d) => [d['code'], d['locale']])).toEqual([
      ['CUSTOMER_TERMS', 'hi'],
      ['PRIVACY_NOTICE', 'en'],
    ]);

    const { client, book } = await customer();
    const refused = await book(10);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('LEGAL_ACCEPTANCE_REQUIRED');
    expect((await client.get<Json>('/me/consents')).body['allAccepted']).toBe(false);

    expect(
      (await client.post('/me/consents/accept', { documentIds: [termsHi, privacy] })).status,
    ).toBe(204);
    // Accepting again changes nothing.
    await client.post('/me/consents/accept', { documentIds: [termsHi, privacy] });
    const status = await client.get<Json>('/me/consents');
    expect(status.body['allAccepted']).toBe(true);
    expect((await book(10)).status).toBe(201);

    const rows = await app.db
      .selectFrom('consent_record')
      .select(['purpose', 'source', 'legal_document_id'])
      .where('legal_document_id', 'in', [termsEn, termsHi, privacy])
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        { purpose: 'TERMS', source: 'CUSTOMER_APP', legal_document_id: termsHi },
        { purpose: 'PRIVACY', source: 'CUSTOMER_APP', legal_document_id: privacy },
      ]),
    );

    // A new version needs a new acceptance; accepting an outdated one is refused.
    await publish('CUSTOMER_TERMS', '2026.2', 'en');
    expect((await book(11)).body.error.code).toBe('LEGAL_ACCEPTANCE_REQUIRED');
    const outdated = await client.post<ErrorBody>('/me/consents/accept', {
      documentIds: [termsEn],
    });
    expect(outdated.body.error.code).toBe('LEGAL_DOCUMENT_NOT_CURRENT');
  });

  it('a published document can never be changed', async () => {
    const id = await publish('CANCELLATION_POLICY', '2026.1');
    await expect(
      inTransaction(app.db, SYSTEM, (tx) =>
        tx
          .updateTable('legal_document')
          .set({ url: 'https://evil.example' })
          .where('id', '=', id)
          .execute(),
      ),
    ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
  });

  it('publishing needs settings.manage, a recent authenticator check and an https link', async () => {
    const ops = api.as(await signInStaff(api, await createStaff(app, ['OPERATIONS_HEAD'])));
    const body = {
      code: 'CUSTOMER_TERMS',
      version: '9.9',
      locale: 'en',
      title: 'Terms',
      url: 'https://onetappe.example/t',
      contentSha256: 'a'.repeat(64),
      effectiveFrom: new Date().toISOString(),
      reason: 'Counsel-approved text',
    };
    expect((await ops.post('/admin/config/legal-documents', body)).status).toBe(403);
    expect(
      (
        await admin.post('/admin/config/legal-documents', {
          ...body,
          url: 'http://insecure.example',
        })
      ).status,
    ).toBe(400);
  });
});

describe('optional choices', () => {
  it('WhatsApp consent can be given and withdrawn; withdrawal is kept on record', async () => {
    const { session, client } = await customer();
    expect((await client.post('/me/consents/WHATSAPP', { granted: true })).status).toBe(204);
    const on = await client.get<{ optional: Json[] }>('/me/consents');
    expect(on.body.optional).toContainEqual({ purpose: 'WHATSAPP', granted: true });
    await client.post('/me/consents/WHATSAPP', { granted: false });
    const off = await client.get<{ optional: Json[] }>('/me/consents');
    expect(off.body.optional).toContainEqual({ purpose: 'WHATSAPP', granted: false });

    const history = await app.db
      .selectFrom('consent_record')
      .select(['purpose', 'withdrawn_at'])
      .where('user_id', '=', session.user.id)
      .where('purpose', '=', 'WHATSAPP')
      .execute();
    expect(history).toHaveLength(1);
    expect(history[0]?.withdrawn_at).not.toBeNull();
  });

  it('refuses choices that do not belong to the app', async () => {
    const { client } = await customer();
    const res = await client.post<ErrorBody>('/me/consents/WORKER_TRACKING', { granted: true });
    expect(res.body.error.code).toBe('CONSENT_PURPOSE_INVALID');
    expect((await client.post('/me/consents/TERMS', { granted: true })).status).toBe(400);
  });
});

describe('worker terms', () => {
  it('a worker cannot go online until the worker terms are accepted', async () => {
    const terms = await publish('WORKER_TERMS', '2026.1');
    const onboarded = await onboardWorkerViaApi(app, api, workerOps, world, { goOnline: false });
    const worker = api.as(onboarded.session.accessToken);
    const refused = await worker.post<ErrorBody>('/worker/me/presence', { online: true });
    expect(refused.body.error.code).toBe('LEGAL_ACCEPTANCE_REQUIRED');
    const docs = await api.get<Json[]>('/legal/documents?app=WORKER_APP');
    const ids = docs.body.map((d) => d['id'] as string);
    expect(ids).toContain(terms);
    expect((await worker.post('/me/consents/accept', { documentIds: ids })).status).toBe(204);
    expect((await worker.post('/worker/me/presence', { online: true })).status).toBe(200);
  });
});
