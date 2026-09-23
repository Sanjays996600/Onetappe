import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inTransaction } from '../src/database/transaction.js';
import { FakeZoho } from './support/fake-zoho.js';
import { ApiClient } from './support/http.js';
import { runJob } from './support/journey.js';
import { signInWithOtp } from './support/phone-auth.js';
import { createStaff, signInStaff } from './support/staff.js';
import {
  SYSTEM,
  createTestApp,
  createWorld,
  customerContext,
  type TestApp,
  type World,
} from './support/world.js';

type Json = Record<string, unknown>;
type ErrorBody = { error: { code: string } };

const DESK_SETTINGS = {
  departmentId: '77001',
  fields: {
    caseCode: 'cf_onetappe_case_code',
    bookingCode: 'cf_onetappe_booking_code',
    customerId: 'cf_onetappe_customer_id',
    category: 'cf_onetappe_category',
  },
  statusMap: { Escalated: 'IN_PROGRESS' },
  safetyTickets: true,
};
const CRM_SETTINGS = { contactIdField: 'OneTappe_Customer_ID', bookingModule: null };

let zoho: FakeZoho;
let app: TestApp;
let api: ApiClient;
let world: World;
let opsToken: string;
let hour = 8;

async function setSetting(key: string, value: unknown): Promise<void> {
  await inTransaction(app.db, SYSTEM, (tx) =>
    tx
      .insertInto('business_setting')
      .values({ key, value: JSON.stringify(value), description: 'Zoho integration test' })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(value) }))
      .execute(),
  );
}

beforeAll(async () => {
  zoho = await FakeZoho.start();
  app = await createTestApp(zoho.env());
  api = new ApiClient(app.http);
  world = await createWorld(app.db, { workers: 6 });
  await setSetting('zoho.desk', DESK_SETTINGS);
  await setSetting('zoho.crm', CRM_SETTINGS);
  const opsHead = await createStaff(app, ['OPERATIONS_HEAD']);
  opsToken = await signInStaff(api, opsHead);
});

afterAll(async () => {
  await app.close();
  await zoho.close();
});

beforeEach(async () => {
  // Each test starts with a healthy integration and nothing left over from the last one.
  zoho.down = false;
  await app.db
    .updateTable('integration_target_state')
    .set({ paused_until: null, pause_reason: null, consecutive_failures: 0 })
    .execute();
  await inTransaction(app.db, SYSTEM, (tx) =>
    tx
      .updateTable('integration_event')
      .set({ status: 'DISCARDED', resolution_note: 'test isolation' })
      .where('status', 'in', ['PENDING', 'PROCESSING', 'DEAD'])
      .execute(),
  );
});

/** A signed-in customer with a name (as Zoho contacts need one). */
async function customer() {
  const session = await signInWithOtp(app, api, 'customer');
  const client = api.as(session.accessToken);
  await client.patch('/customer/me', { fullName: 'Kavita Rao' });
  return { session, client, bookingId: null };
}

/** A signed-in customer with a booking (created through the engine). */
async function customerWithBooking() {
  const session = await signInWithOtp(app, api, 'customer');
  const client = api.as(session.accessToken);
  await client.patch('/customer/me', { fullName: 'Kavita Rao' });
  const address = await client.post<Json>(
    '/customer/addresses',
    {
      contactName: 'Kavita Rao',
      contactPhone: session.phone,
      houseNumber: 'F-9',
      pincode: world.pincode,
      cityName: 'Noida',
      lat: world.center.lat,
      lng: world.center.lng,
    },
    { 'idempotency-key': randomUUID() },
  );
  hour = hour >= 17 ? 9 : hour + 1;
  const booking = await app.creation.create(
    world.bookingInput(
      { userId: session.user.id, addressId: address.body['id'] as string },
      world.at(hour),
    ),
    customerContext(session.user.id),
  );
  return { session, client, bookingId: booking.id, bookingCode: booking.bookingCode };
}

async function openCase(client: ApiClient, bookingId: string | null) {
  const res = await client.post<Json>(
    '/customer/support-cases',
    {
      bookingId,
      category: 'SERVICE_QUALITY',
      subject: 'Bathroom not cleaned',
      description: 'The bathroom was skipped.',
      desiredResolution: 'Redo the bathroom',
    },
    { 'idempotency-key': randomUUID() },
  );
  expect(res.status).toBe(201);
  return { caseId: res.body['id'] as string, caseCode: res.body['caseCode'] as string };
}

function eventsFor(aggregateId: string) {
  return app.db
    .selectFrom('integration_event')
    .select(['id', 'event_type', 'status', 'attempts', 'last_error', 'next_attempt_at'])
    .where('aggregate_id', '=', aggregateId)
    .orderBy('id')
    .execute();
}

/** Makes waiting events due now (instead of waiting out the backoff). */
async function makeDue(): Promise<void> {
  await app.db
    .updateTable('integration_event')
    .set({ next_attempt_at: sql<Date>`now()` })
    .where('status', '=', 'PENDING')
    .execute();
}

const deliver = () => runJob(app, 'deliver-integration-events');

describe('support case → Zoho Desk ticket', () => {
  it('creates the ticket after the case is saved, with One Tappe references', async () => {
    const { session, client, bookingId, bookingCode } = await customerWithBooking();
    const { caseId, caseCode } = await openCase(client, bookingId);

    // The case exists before Zoho has heard of it.
    expect((await eventsFor(caseId)).map((e) => [e.event_type, e.status])).toEqual([
      ['DESK_CASE_CREATE', 'PENDING'],
    ]);
    await deliver();

    const [ticket] = zoho.ticketsFor(caseCode);
    expect(ticket).toMatchObject({
      departmentId: '77001',
      subject: `[${caseCode}] Bathroom not cleaned`,
      cf: {
        cf_onetappe_case_code: caseCode,
        cf_onetappe_booking_code: bookingCode,
        cf_onetappe_customer_id: session.user.id,
        cf_onetappe_category: 'SERVICE_QUALITY',
      },
    });
    expect(ticket?.description).toContain(bookingCode);
    expect(zoho.contacts.get(ticket?.contactId ?? '')).toMatchObject({ mobile: session.phone });

    const link = await app.db
      .selectFrom('external_link')
      .select(['external_id', 'external_ref'])
      .where('target', '=', 'ZOHO_DESK')
      .where('entity_type', '=', 'support_case')
      .where('internal_id', '=', caseId)
      .executeTakeFirstOrThrow();
    expect(link.external_id).toBe(ticket?.id);
    expect((await eventsFor(caseId))[0]?.status).toBe('SUCCEEDED');
  });

  it('a Zoho outage never blocks bookings or support cases; tickets follow once Zoho is back', async () => {
    zoho.down = true;
    // Booking goes through while Zoho is unreachable (it records a CRM sync event).
    const { client, bookingId } = await customerWithBooking();
    const { caseId, caseCode } = await openCase(client, bookingId);

    await deliver();
    const [waiting] = await eventsFor(caseId);
    expect(waiting).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(waiting?.last_error).toMatch(/unreachable|could not be reached/);
    expect(zoho.ticketsFor(caseCode)).toHaveLength(0);

    // The customer's view is unaffected.
    const cases = await client.get<Json[]>('/customer/support-cases');
    expect(cases.body.map((c) => c['id'])).toContain(caseId);

    zoho.down = false;
    await makeDue();
    await deliver();
    expect(zoho.ticketsFor(caseCode)).toHaveLength(1);
    expect((await eventsFor(caseId))[0]?.status).toBe('SUCCEEDED');
  });

  it('a lost response (ticket created, answer never arrived) does not create a second ticket', async () => {
    const { client, bookingId } = await customer();
    const { caseId, caseCode } = await openCase(client, bookingId);
    zoho.failNext(/^POST \/desk\/api\/v1\/tickets$/, { kind: 'drop-after-create' });

    await deliver();
    expect((await eventsFor(caseId))[0]?.status).toBe('PENDING');
    expect(zoho.ticketsFor(caseCode)).toHaveLength(1); // Zoho did create it

    await makeDue();
    await deliver();
    expect(zoho.ticketsFor(caseCode)).toHaveLength(1); // found, not re-created
    expect((await eventsFor(caseId))[0]?.status).toBe('SUCCEEDED');
  });

  it('two workers delivering at once still create exactly one ticket per case', async () => {
    const created: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { client, bookingId } = await customer();
      created.push((await openCase(client, bookingId)).caseCode);
    }
    const dispatcher = app.http.get(
      (await import('../src/integrations/integration-dispatcher.service.js')).IntegrationDispatcher,
    );
    await Promise.all([dispatcher.deliverDue('parallel-a'), dispatcher.deliverDue('parallel-b')]);
    for (const code of created) expect(zoho.ticketsFor(code)).toHaveLength(1);
  });

  it('a worker that dies mid-delivery leaves the event to be picked up again, without duplicates', async () => {
    const { client, bookingId } = await customer();
    const { caseId, caseCode } = await openCase(client, bookingId);
    // Simulate a crash after claiming: PROCESSING with an expired lease.
    await app.db
      .updateTable('integration_event')
      .set({
        status: 'PROCESSING',
        attempts: 1,
        locked_by: 'crashed-worker',
        locked_until: sql<Date>`now() - interval '1 second'`,
      })
      .where('aggregate_id', '=', caseId)
      .execute();
    await deliver();
    expect(zoho.ticketsFor(caseCode)).toHaveLength(1);
    expect((await eventsFor(caseId))[0]).toMatchObject({ status: 'SUCCEEDED', attempts: 2 });
  });
});

describe('failure handling', () => {
  it('a rate limit pauses the whole target without spending attempts; operations can resume it', async () => {
    const { client, bookingId } = await customer();
    const { caseId, caseCode } = await openCase(client, bookingId);
    zoho.failNext(/^POST \/desk\/api\/v1\/tickets$/, {
      kind: 'status',
      status: 429,
      headers: { 'retry-after': '120' },
      body: { errorCode: 'RATE_LIMIT_EXCEEDED' },
    });
    await deliver();
    expect((await eventsFor(caseId))[0]).toMatchObject({ status: 'PENDING', attempts: 0 });

    const status = await api.as(opsToken).get<{ targets: Json[] }>('/admin/integrations');
    const desk = status.body.targets.find((t) => t['target'] === 'ZOHO_DESK');
    expect(desk).toMatchObject({ healthy: false, pending: 1 });
    expect(desk?.['pausedUntil']).not.toBeNull();

    await deliver(); // still paused: nothing is sent
    expect(zoho.ticketsFor(caseCode)).toHaveLength(0);

    const resumed = await api
      .as(opsToken)
      .post('/admin/integrations/ZOHO_DESK/resume', { note: 'Zoho confirmed limits reset' });
    expect(resumed.status).toBe(204);
    await makeDue();
    await deliver();
    expect(zoho.ticketsFor(caseCode)).toHaveLength(1);
  });

  it('refreshes an expired access token once and carries on', async () => {
    const { client, bookingId } = await customer();
    const { caseCode } = await openCase(client, bookingId);
    await deliver(); // obtains a token
    const before = zoho.tokenRequests;

    zoho.revokeTokens();
    const second = await customer();
    const { caseCode: nextCode } = await openCase(second.client, second.bookingId);
    await deliver();
    expect(zoho.tokenRequests - before).toBe(1);
    expect(zoho.ticketsFor(caseCode)).toHaveLength(1);
    expect(zoho.ticketsFor(nextCode)).toHaveLength(1);
  });

  it('rejected credentials pause delivery and are visible; events are kept, not dropped', async () => {
    const { client, bookingId } = await customer();
    const { caseId } = await openCase(client, bookingId);
    zoho.revokeTokens();
    const realToken = zoho.refreshToken;
    zoho.refreshToken = 'rotated-by-someone-else';
    await app.db
      .updateTable('integration_credential')
      .set({ expires_at: sql<Date>`now()` })
      .execute();

    await deliver();
    expect((await eventsFor(caseId))[0]?.status).toBe('PENDING');
    const status = await api
      .as(opsToken)
      .get<{ zohoToken: Json; targets: Json[] }>('/admin/integrations');
    expect(status.body.zohoToken['lastError']).toContain('invalid_code');
    expect(status.body.targets.find((t) => t['target'] === 'ZOHO_DESK')?.['pauseReason']).toContain(
      'CREDENTIALS',
    );
    zoho.refreshToken = realToken;
  });

  it('a request Zoho refuses outright is parked as DEAD, and can be retried after a fix (audited)', async () => {
    const { client, bookingId } = await customer();
    const { caseId, caseCode } = await openCase(client, bookingId);
    zoho.failNext(/^POST \/desk\/api\/v1\/tickets$/, {
      kind: 'status',
      status: 422,
      body: { errorCode: 'INVALID_DATA', message: 'departmentId is invalid' },
    });
    await deliver();
    const [dead] = await eventsFor(caseId);
    expect(dead).toMatchObject({ status: 'DEAD' });
    expect(dead?.last_error).toContain('departmentId is invalid');

    const listed = await api.as(opsToken).get<Json[]>('/admin/integrations/events?status=DEAD');
    expect(listed.body.map((e) => e['id'])).toContain(dead?.id);

    const retried = await api
      .as(opsToken)
      .post(`/admin/integrations/events/${String(dead?.id)}/retry`, {
        note: 'Department id corrected in settings',
      });
    expect(retried.status).toBe(204);
    await deliver();
    expect(zoho.ticketsFor(caseCode)).toHaveLength(1);
    const audit = await app.db
      .selectFrom('audit_log')
      .select(['reason', 'actor_role'])
      .where('entity_type', '=', 'integration_event')
      .where('entity_id', '=', String(dead?.id))
      .execute();
    expect(audit).toEqual([
      { reason: 'Department id corrected in settings', actor_role: 'OPERATIONS_HEAD' },
    ]);
  });

  it('missing configuration pauses delivery instead of losing events', async () => {
    await setSetting('zoho.desk', { departmentId: 'not-a-number', fields: {} });
    const { client, bookingId } = await customer();
    const { caseId } = await openCase(client, bookingId);
    await deliver();
    expect((await eventsFor(caseId))[0]?.status).toBe('PENDING');
    const state = await app.db
      .selectFrom('integration_target_state')
      .select('pause_reason')
      .where('target', '=', 'ZOHO_DESK')
      .executeTakeFirstOrThrow();
    expect(state.pause_reason).toContain('CONFIGURATION');
    await setSetting('zoho.desk', DESK_SETTINGS);
  });

  it('retrying failures back off and eventually park as DEAD; the circuit breaker pauses the target', async () => {
    const { client, bookingId } = await customer();
    const { caseId } = await openCase(client, bookingId);
    zoho.down = true;
    for (let i = 0; i < 5; i += 1) {
      await app.db.updateTable('integration_target_state').set({ paused_until: null }).execute();
      await makeDue();
      await deliver();
    }
    const [event] = await eventsFor(caseId);
    expect(event).toMatchObject({ status: 'PENDING', attempts: 5 });
    const state = await app.db
      .selectFrom('integration_target_state')
      .select(['paused_until', 'consecutive_failures'])
      .where('target', '=', 'ZOHO_DESK')
      .executeTakeFirstOrThrow();
    expect(state.consecutive_failures).toBeGreaterThanOrEqual(5);
    expect(state.paused_until).not.toBeNull();

    for (let i = 0; i < 3; i += 1) {
      await app.db.updateTable('integration_target_state').set({ paused_until: null }).execute();
      await makeDue();
      await deliver();
    }
    expect((await eventsFor(caseId))[0]).toMatchObject({ status: 'DEAD', attempts: 8 });
  });
});

describe('Zoho Desk → One Tappe', () => {
  async function caseWithTicket() {
    const { client, bookingId } = await customer();
    const { caseId, caseCode } = await openCase(client, bookingId);
    await deliver();
    const ticket = zoho.ticketsFor(caseCode)[0];
    if (!ticket) throw new Error('ticket not created');
    return { client, caseId, ticket };
  }

  it('refuses webhooks without the shared key', async () => {
    const res = await api.post<ErrorBody>('/integrations/zoho-desk/webhook', [
      { payload: { id: '1' } },
    ]);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('WEBHOOK_KEY_INVALID');
  });

  it('a Desk update is read back from Zoho (not from the webhook body) and shown to the customer', async () => {
    const { client, caseId, ticket } = await caseWithTicket();
    ticket.status = 'Closed';
    ticket.statusType = 'Closed';
    ticket.resolution = 'A cleaner revisited and finished the bathroom.';

    // The body claims something else entirely; only the ticket id is used.
    const res = await api.post<Json>(
      '/integrations/zoho-desk/webhook',
      [
        {
          eventType: 'Ticket_Update',
          payload: { id: ticket.id, status: 'Open', resolution: 'forged' },
        },
      ],
      { 'x-onetappe-webhook-key': zoho.env()['ZOHO_DESK_WEBHOOK_SECRET'] ?? '' },
    );
    expect(res.body).toEqual({ received: 1 });
    await deliver();

    const cases = await client.get<Json[]>('/customer/support-cases');
    expect(cases.body.find((c) => c['id'] === caseId)).toMatchObject({
      status: 'RESOLVED',
      resolution: 'A cleaner revisited and finished the bathroom.',
    });
  });

  it('the periodic pull catches changes whose webhook never arrived', async () => {
    const { caseId, ticket } = await caseWithTicket();
    ticket.status = 'Escalated';
    await runJob(app, 'pull-zoho-desk-updates');
    await deliver();
    const row = await app.db
      .selectFrom('support_case')
      .select('status')
      .where('id', '=', caseId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('IN_PROGRESS');
  });

  it('a case worked in Zoho Desk cannot have its status changed in One Tappe (notes still allowed)', async () => {
    const { caseId } = await caseWithTicket();
    const support = await createStaff(app, ['CUSTOMER_SUPPORT']);
    const staff = api.as(await signInStaff(api, support));
    const change = await staff.post<ErrorBody>(`/admin/support-cases/${caseId}/actions`, {
      status: 'RESOLVED',
      resolution: 'Done',
    });
    expect(change.status).toBe(422);
    expect(change.body.error.code).toBe('CASE_MANAGED_IN_ZOHO_DESK');
    const note = await staff.post(`/admin/support-cases/${caseId}/actions`, {
      note: 'Called the customer',
    });
    expect(note.status).toBeLessThan(300);
  });
});

describe('Zoho CRM', () => {
  it('upserts each customer once, keyed on the One Tappe id, and keeps it up to date', async () => {
    const session = await signInWithOtp(app, api, 'customer');
    const client = api.as(session.accessToken);
    await client.patch('/customer/me', { fullName: 'Arjun Mehta' });
    await client.patch('/customer/me', { fullName: 'Arjun K Mehta' });
    await deliver();
    await makeDue();
    await deliver();

    const contacts = [...(zoho.crm.get('Contacts')?.values() ?? [])].filter(
      (c) => c['OneTappe_Customer_ID'] === session.user.id,
    );
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({
      First_Name: 'Arjun K',
      Last_Name: 'Mehta',
      Mobile: session.phone,
    });
  });
});

describe('safety escalations', () => {
  it('opens a reference ticket without the incident narrative', async () => {
    const { client, bookingId } = await customerWithBooking();
    const sos = await client.post<Json>(
      '/customer/sos',
      { bookingId, note: 'Private details that must stay in One Tappe', lat: null, lng: null },
      { 'idempotency-key': randomUUID() },
    );
    await deliver();
    const [ticket] = zoho.ticketsFor(sos.body['incidentCode'] as string);
    expect(ticket?.subject).toContain('Safety escalation');
    expect(ticket?.description).not.toContain('Private details');
    expect(ticket?.priority).toBe('High');
  });
});
