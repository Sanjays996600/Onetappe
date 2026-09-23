import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction } from '../../src/database/transaction.js';
import { TestOtpSender } from '../../src/auth/otp/otp-sender.js';
import { FakeMessaging } from '../support/fake-messaging.js';
import { ApiClient } from '../support/http.js';
import { runJob } from '../support/journey.js';
import { signInWithOtp, type PhoneSession } from '../support/phone-auth.js';
import { createStaff, signInStaff, type StaffMember } from '../support/staff.js';
import { createTestApp, SYSTEM, type TestApp } from '../support/world.js';

/**
 * An SOS is not just a button: the incident is recorded, the on-call safety staff are
 * paged at once by SMS and email, paging widens until a person acknowledges, every step
 * is on the incident's append-only timeline, and nothing can switch the pages off.
 */

type Json = Record<string, unknown>;
const codeOf = (body: unknown) => (body as { error?: { code?: string } }).error?.code;
const mobile = () => `+919${String(randomInt(100_000_000, 999_999_999))}`;

let fake: FakeMessaging;
let app: TestApp;
let api: ApiClient;
let customer: PhoneSession;
let lead: { member: StaffMember; token: string; phone: string };
let backup: { member: StaffMember; token: string; phone: string };

async function safetyStaff() {
  const member = await createStaff(app, ['SAFETY']);
  return { member, token: await signInStaff(api, member), phone: mobile() };
}

async function events(incidentId: string) {
  return app.db
    .selectFrom('safety_incident_event')
    .select(['event_type', 'body', 'actor_user_id'])
    .where('incident_id', '=', incidentId)
    .orderBy('id')
    .execute();
}

async function pagesTo(incidentId: string) {
  return app.db
    .selectFrom('notification as n')
    .innerJoin('notification_template as t', 't.id', 'n.template_id')
    .select(['n.user_id', 'n.channel'])
    .where('t.code', '=', 'SAFETY_ALERT')
    .where('n.dedupe_key', 'like', `SAFETY_ALERT:${incidentId}:%`)
    .execute();
}

/** Moves the next paging round into the past (as if the wait had elapsed). */
async function makeNextPageDue(incidentId: string) {
  await inTransaction(app.db, SYSTEM, (tx) =>
    tx
      .updateTable('safety_incident')
      .set({ next_page_at: new Date(Date.now() - 1000) })
      .where('id', '=', incidentId)
      .where('next_page_at', 'is not', null)
      .execute(),
  );
}

async function sos(): Promise<string> {
  const res = await api
    .as(customer.accessToken)
    .post<Json>('/customer/sos', { note: 'Help' }, { 'idempotency-key': randomUUID() });
  expect(res.status).toBeLessThan(300);
  return res.body['id'] as string;
}

beforeAll(async () => {
  fake = await FakeMessaging.start();
  app = await createTestApp(fake.env());
  api = new ApiClient(app.http);
  // The DLT template registered with MSG91 for safety pages (configuration).
  await inTransaction(app.db, SYSTEM, (tx) =>
    tx
      .updateTable('notification_template')
      .set({ provider_template_id: 'dlt-safety-alert' })
      .where('code', '=', 'SAFETY_ALERT')
      .where('channel', '=', 'SMS')
      .execute(),
  );
  customer = await signInWithOtp(app, api, 'customer');
  lead = await safetyStaff();
  backup = await safetyStaff();
});

afterAll(async () => {
  await app.close();
  await fake.close();
});

describe('the on-call roster', () => {
  it('only safety staff with a mobile number can be on call, with a fresh authenticator check', async () => {
    const ops = await signInStaff(api, await createStaff(app, ['DISPATCHER']));
    const refused = await api.as(lead.token).post('/admin/safety/on-call', {
      userId: (
        await app.db
          .selectFrom('user_role')
          .select('user_id')
          .where('role_code', '=', 'DISPATCHER')
          .executeTakeFirstOrThrow()
      ).user_id,
      level: 1,
      phone: mobile(),
      reason: 'Night cover',
    });
    expect(codeOf(refused.body)).toBe('NOT_SAFETY_STAFF');
    // A dispatcher cannot change the roster at all.
    const forbidden = await api.as(ops).post('/admin/safety/on-call', {
      userId: lead.member.userId,
      level: 1,
      phone: lead.phone,
      reason: 'Night cover',
    });
    expect(forbidden.status).toBe(403);

    for (const [who, level] of [
      [lead, 1],
      [backup, 2],
    ] as const) {
      const added = await api.as(lead.token).post<Json[]>('/admin/safety/on-call', {
        userId: who.member.userId,
        level,
        phone: who.phone,
        reason: 'Pilot safety rota',
      });
      expect(added.status).toBeLessThan(300);
    }
    const roster = await api.as(lead.token).get<Json[]>('/admin/safety/on-call');
    expect(roster.body.map((r) => r['level'])).toEqual([1, 2]);
    // Numbers are masked even for safety staff.
    expect(JSON.stringify(roster.body)).not.toContain(lead.phone.slice(-10));
  });

  it('a staff member’s number cannot be used to sign in to a phone app', async () => {
    const phone = lead.phone;
    const request = await api.post<Json>('/customer/auth/otp', { phone });
    const code = app.http.get(TestOtpSender).latestCodeFor(request.body['phone'] as string);
    const verify = await api.post('/customer/auth/verify', {
      challengeId: request.body['challengeId'],
      phone,
      code,
    });
    expect(verify.status).toBe(403);
    expect(codeOf(verify.body)).toBe('STAFF_ACCOUNT');
  });

  it('safety pages cannot be switched off from the panel', async () => {
    const admin = await signInStaff(api, await createStaff(app, ['SUPER_ADMIN']));
    const off = await api.as(admin).send('PUT', '/admin/config/notifications/routes', {
      event: 'SAFETY_ALERT',
      channel: 'SMS',
      isEnabled: false,
      reason: 'Too many messages',
    });
    expect(codeOf(off.body)).toBe('SAFETY_ALERT_REQUIRED');
  });
});

describe('an SOS pages people until someone acknowledges it', () => {
  it('pages level 1 at once, widens to level 2, and stops when acknowledged', async () => {
    const incidentId = await sos();

    // Page 1: level 1 only, by SMS and email, recorded on the timeline.
    let pages = await pagesTo(incidentId);
    expect(new Set(pages.map((p) => p.user_id))).toEqual(new Set([lead.member.userId]));
    expect(pages.map((p) => p.channel).sort()).toEqual(['EMAIL', 'SMS']);
    await runJob(app, 'dispatch-notifications');
    const smsToLead = fake.sms.filter((m) => m.recipient['mobiles'] === lead.phone.slice(1));
    expect(smsToLead).toHaveLength(1);
    expect(smsToLead[0]?.templateId).toBe('dlt-safety-alert');
    // The page carries no name, address or location of the person in trouble.
    expect(JSON.stringify(smsToLead[0]?.recipient)).not.toMatch(/lat|lng|address|Sector/i);

    // Not due yet: nothing more.
    await runJob(app, 'page-safety-incidents');
    expect(await pagesTo(incidentId)).toHaveLength(2);

    // Nobody answered: page 2 adds level 2 and repeats level 1.
    await makeNextPageDue(incidentId);
    await runJob(app, 'page-safety-incidents');
    pages = await pagesTo(incidentId);
    expect(pages).toHaveLength(6);
    expect(new Set(pages.map((p) => p.user_id))).toEqual(
      new Set([lead.member.userId, backup.member.userId]),
    );

    // The backup acknowledges; paging stops, and a second acknowledgement changes nothing.
    const ack = await api
      .as(backup.token)
      .post<Json>(`/admin/safety-incidents/${incidentId}/acknowledge`);
    expect(ack.status).toBe(200);
    expect(ack.body['acknowledged_by']).toBe(backup.member.userId);
    await api.as(lead.token).post(`/admin/safety-incidents/${incidentId}/acknowledge`);
    await makeNextPageDue(incidentId);
    await runJob(app, 'page-safety-incidents');
    expect(await pagesTo(incidentId)).toHaveLength(6);

    const timeline = await events(incidentId);
    expect(timeline.map((e) => e.event_type)).toEqual(['NOTE', 'PAGED', 'PAGED', 'ACKNOWLEDGED']);
    expect(timeline[3]?.actor_user_id).toBe(backup.member.userId);
    // The timeline cannot be rewritten.
    await expect(
      inTransaction(app.db, SYSTEM, (tx) =>
        tx
          .updateTable('safety_incident_event')
          .set({ body: 'nothing happened' })
          .where('incident_id', '=', incidentId)
          .execute(),
      ),
    ).rejects.toThrow();
  });

  it('acting on an incident acknowledges it; closing needs a second person', async () => {
    const incidentId = await sos();
    const took = await api.as(lead.token).post(`/admin/safety-incidents/${incidentId}/actions`, {
      note: 'Called the customer; police informed',
      takeCommand: true,
    });
    expect(took.status).toBeLessThan(300);
    const incident = await app.db
      .selectFrom('safety_incident')
      .select(['acknowledged_by', 'next_page_at'])
      .where('id', '=', incidentId)
      .executeTakeFirstOrThrow();
    expect(incident).toEqual({ acknowledged_by: lead.member.userId, next_page_at: null });
    const selfClose = await api
      .as(lead.token)
      .post(`/admin/safety-incidents/${incidentId}/actions`, {
        note: 'All fine now',
        status: 'CLOSED',
      });
    expect(selfClose.status).toBeGreaterThanOrEqual(400);
  });

  it('with nobody on call, the gap is recorded and paging keeps trying', async () => {
    const entries = await app.db
      .selectFrom('safety_on_call')
      .select('id')
      .where('removed_at', 'is', null)
      .execute();
    for (const { id } of entries) {
      await api
        .as(lead.token)
        .post(`/admin/safety/on-call/${id}/remove`, { reason: 'End of pilot rota' });
    }
    const incidentId = await sos();
    expect((await events(incidentId)).map((e) => e.event_type)).toEqual(['NOTE', 'NO_ONE_ON_CALL']);
    const row = await app.db
      .selectFrom('safety_incident')
      .select('next_page_at')
      .where('id', '=', incidentId)
      .executeTakeFirstOrThrow();
    expect(row.next_page_at).not.toBeNull();
  });

  it('the SMS provider being down does not stop escalation', async () => {
    await api.as(lead.token).post('/admin/safety/on-call', {
      userId: lead.member.userId,
      level: 1,
      phone: lead.phone,
      reason: 'Back on rota',
    });
    fake.down = true;
    try {
      const incidentId = await sos();
      await runJob(app, 'dispatch-notifications');
      await makeNextPageDue(incidentId);
      await runJob(app, 'page-safety-incidents');
      const types = (await events(incidentId)).map((e) => e.event_type);
      expect(types).toEqual(['NOTE', 'PAGED', 'PAGED']);
    } finally {
      fake.down = false;
    }
  });
});
