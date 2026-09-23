import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StaffAdminService } from '../src/admin/staff-admin.service.js';
import { inTransaction } from '../src/database/transaction.js';
import { totpAt, totpStep } from '../src/security/totp.js';
import { ApiClient } from './support/http.js';
import { signInWithOtp } from './support/phone-auth.js';
import { createStaff, signInStaff, type StaffMember } from './support/staff.js';
import { SYSTEM, createTestApp, type TestApp } from './support/world.js';

type Json = Record<string, unknown>;
type ErrorBody = { error: { code: string } };

let app: TestApp;
let api: ApiClient;
let admin: StaffMember;
let adminApi: ApiClient;

beforeAll(async () => {
  app = await createTestApp();
  api = new ApiClient(app.http);
  admin = await createStaff(app, ['SUPER_ADMIN']);
  adminApi = api.as(await signInStaff(api, admin));
});

afterAll(async () => {
  await app.close();
});

let n = 0;
const email = () => `new.staff.${Date.now()}.${(n += 1)}@onetappe.test`;
const STRONG = 'a long and varied passphrase 42';

/** Signs in with a password, enrolling the authenticator; returns a client and the secret. */
async function firstSignIn(address: string, password: string) {
  const login = await api.post<Json>('/auth/staff/login', { email: address, password });
  expect(login.status).toBe(200);
  expect(login.body['step']).toBe('MFA_ENROLL');
  const secret = login.body['totpSecret'] as string;
  const mfa = await api.post<Json>('/auth/staff/mfa', {
    challengeToken: login.body['challengeToken'],
    code: totpAt(secret, totpStep(new Date())),
  });
  expect(mfa.status).toBe(200);
  return api.as(mfa.body['accessToken'] as string);
}

async function invite(grants: Array<{ role: string; cityId?: string | null }>, address = email()) {
  const res = await adminApi.post<Json>('/admin/staff', {
    email: address,
    fullName: 'Meera Iyer',
    grants,
    reason: 'Joining the finance team',
  });
  expect(res.status).toBe(201);
  const invitation = res.body['invitation'] as { token: string; expiresAt: string };
  return { userId: res.body['userId'] as string, token: invitation.token, email: address };
}

describe('inviting staff', () => {
  it('invitation → own password → authenticator → access; the link works once', async () => {
    const invited = await invite([{ role: 'FINANCE' }]);

    // No password exists until the invitation is accepted.
    expect(
      (await api.post('/auth/staff/login', { email: invited.email, password: STRONG })).status,
    ).toBe(401);

    const weak = await api.post<ErrorBody>('/auth/staff/invitation/accept', {
      token: invited.token,
      password: 'short',
    });
    expect(weak.body.error.code).toBe('PASSWORD_WEAK');
    expect(
      (await api.post('/auth/staff/invitation/accept', { token: invited.token, password: STRONG }))
        .status,
    ).toBe(204);
    const reused = await api.post<ErrorBody>('/auth/staff/invitation/accept', {
      token: invited.token,
      password: STRONG,
    });
    expect(reused.body.error.code).toBe('INVITATION_INVALID');

    const finance = await firstSignIn(invited.email, STRONG);
    expect((await finance.get('/admin/config/tax-rates')).status).toBe(200);
    expect((await finance.get('/admin/staff')).status).toBe(403); // not user.manage

    // Who granted what, when and why is on record.
    const audit = await app.db
      .selectFrom('audit_log')
      .select(['action', 'reason', 'actor_user_id'])
      .where('entity_type', '=', 'user_role')
      .where(sql<boolean>`after ->> 'user_id' = ${invited.userId}`)
      .execute();
    expect(audit).toEqual([
      { action: 'INSERT', reason: 'Joining the finance team', actor_user_id: admin.userId },
    ]);
    const listed = (await adminApi.get<Json[]>('/admin/staff')).body.find(
      (s) => s['id'] === invited.userId,
    );
    expect(listed).toMatchObject({
      mfaEnrolled: true,
      roles: [{ role: 'FINANCE', cityId: null }],
    });
  });

  it('expired invitations are refused', async () => {
    const invited = await invite([{ role: 'DISPATCHER' }]);
    await inTransaction(app.owner, SYSTEM, (tx) =>
      tx
        .updateTable('staff_invitation')
        .set({
          created_at: sql<Date>`now() - interval '4 days'`,
          expires_at: sql<Date>`now() - interval '1 day'`,
        })
        .where('user_id', '=', invited.userId)
        .execute(),
    );
    const res = await api.post<ErrorBody>('/auth/staff/invitation/accept', {
      token: invited.token,
      password: STRONG,
    });
    expect(res.body.error.code).toBe('INVITATION_INVALID');
  });

  it('only user.manage, with a recent authenticator check and a reason', async () => {
    const opsHead = api.as(await signInStaff(api, await createStaff(app, ['OPERATIONS_HEAD'])));
    const body = {
      email: email(),
      fullName: 'X Y',
      grants: [{ role: 'DISPATCHER' }],
      reason: 'Hiring',
    };
    expect((await opsHead.post('/admin/staff', body)).status).toBe(403);
    expect((await adminApi.post('/admin/staff', { ...body, reason: undefined })).status).toBe(400);

    const stale = await createStaff(app, ['SUPER_ADMIN']);
    const staleApi = api.as(await signInStaff(api, stale));
    await app.db
      .updateTable('auth_session')
      .set({ mfa_verified_at: sql<Date>`now() - interval '1 hour'` })
      .where('user_id', '=', stale.userId)
      .execute();
    const res = await staleApi.post<ErrorBody>('/admin/staff', body);
    expect(res.body.error.code).toBe('MFA_REQUIRED');
  });

  it('refuses unknown or non-staff roles, and duplicate emails', async () => {
    const badRole = await adminApi.post<ErrorBody>('/admin/staff', {
      email: email(),
      fullName: 'X Y',
      grants: [{ role: 'CUSTOMER' }],
      reason: 'Trying a customer role',
    });
    expect(badRole.body.error.code).toBe('ROLE_INVALID');
    const address = email();
    await invite([{ role: 'AUDITOR' }], address);
    const again = await adminApi.post<ErrorBody>('/admin/staff', {
      email: address.toUpperCase(),
      fullName: 'X Y',
      grants: [{ role: 'AUDITOR' }],
      reason: 'Second account for the same person',
    });
    expect(again.body.error.code).toBe('STAFF_EMAIL_TAKEN');
  });
});

describe('changing access', () => {
  async function activeMember(roles: string[]) {
    const member = await createStaff(app, roles);
    return { member, client: api.as(await signInStaff(api, member)) };
  }

  it('revoking a role takes effect on the very next request', async () => {
    const { member, client } = await activeMember(['AUDITOR']);
    expect((await client.get('/admin/system/status')).status).toBe(200);
    const revoked = await adminApi.post(`/admin/staff/${member.userId}/roles/revoke`, {
      role: 'AUDITOR',
      cityId: null,
      reason: 'Audit engagement finished',
    });
    expect(revoked.status).toBe(204);
    expect((await client.get('/admin/system/status')).status).toBe(403);
  });

  it('suspending signs the person out everywhere; reactivating lets them sign in again', async () => {
    const { member, client } = await activeMember(['DISPATCHER']);
    await adminApi.post(`/admin/staff/${member.userId}/status`, {
      status: 'SUSPENDED',
      reason: 'Left the company',
    });
    expect((await client.get('/admin/bookings')).status).toBe(401);
    expect(
      (await api.post('/auth/staff/login', { email: member.email, password: member.password }))
        .status,
    ).toBe(401);
    await adminApi.post(`/admin/staff/${member.userId}/status`, {
      status: 'ACTIVE',
      reason: 'Rejoined',
    });
    expect((await api.as(await signInStaff(api, member)).get('/admin/bookings')).status).toBe(200);
  });

  it('a lost authenticator is reset: sessions end and the next sign-in enrols again', async () => {
    const { member, client } = await activeMember(['DISPATCHER']);
    expect(
      (
        await adminApi.post(`/admin/staff/${member.userId}/reset-mfa`, {
          reason: 'Phone lost, identity confirmed by video call',
        })
      ).status,
    ).toBe(204);
    expect((await client.get('/admin/bookings')).status).toBe(401);
    const login = await api.post<Json>('/auth/staff/login', {
      email: member.email,
      password: member.password,
    });
    expect(login.body['step']).toBe('MFA_ENROLL');
  });

  it('a new invitation resets a forgotten password and ends existing sessions', async () => {
    const { member, client } = await activeMember(['DISPATCHER']);
    const again = await adminApi.post<Json>(`/admin/staff/${member.userId}/invitation`, {
      reason: 'Forgot password',
    });
    await api.post('/auth/staff/invitation/accept', {
      token: again.body['token'],
      password: STRONG,
    });
    expect((await client.get('/admin/bookings')).status).toBe(401);
    expect(
      (await api.post('/auth/staff/login', { email: member.email, password: member.password }))
        .status,
    ).toBe(401);
    expect(
      (await api.post('/auth/staff/login', { email: member.email, password: STRONG })).status,
    ).toBe(200);
  });

  it('nobody changes their own access', async () => {
    for (const [path, body] of [
      [
        `/admin/staff/${admin.userId}/roles`,
        { role: 'FINANCE', cityId: null, reason: 'More access' },
      ],
      [`/admin/staff/${admin.userId}/status`, { status: 'SUSPENDED', reason: 'Testing' }],
      [`/admin/staff/${admin.userId}/reset-mfa`, { reason: 'Testing' }],
      [`/admin/staff/${admin.userId}/invitation`, { reason: 'Testing' }],
    ] as const) {
      const res = await adminApi.post<ErrorBody>(path, body);
      expect(res.body.error.code, path).toBe('SELF_CHANGE_FORBIDDEN');
    }
  });

  it('customer and worker accounts cannot be turned into staff', async () => {
    const customer = await signInWithOtp(app, api, 'customer');
    const res = await adminApi.post<ErrorBody>(`/admin/staff/${customer.user.id}/roles`, {
      role: 'SUPER_ADMIN',
      cityId: null,
      reason: 'Escalation attempt',
    });
    expect(res.status).toBe(404);
    const invitation = await adminApi.post(`/admin/staff/${customer.user.id}/invitation`, {
      reason: 'Give them a password',
    });
    expect(invitation.status).toBe(404);
  });
});

/** Runs `work` while every active super administrator except `keep` is suspended. */
async function withOnlySuperAdmins(keep: string[], work: () => Promise<void>): Promise<void> {
  const others = await app.owner
    .selectFrom('user_role as r')
    .innerJoin('app_user as u', 'u.id', 'r.user_id')
    .select('u.id')
    .where('r.role_code', '=', 'SUPER_ADMIN')
    .where('r.revoked_at', 'is', null)
    .where('u.status', '=', 'ACTIVE')
    .where('u.id', 'not in', keep.length > 0 ? keep : ['00000000-0000-0000-0000-000000000000'])
    .execute();
  const ids = [...new Set(others.map((o) => o.id))];
  const setStatus = (status: string) =>
    ids.length === 0
      ? Promise.resolve()
      : inTransaction(app.owner, SYSTEM, (tx) =>
          tx.updateTable('app_user').set({ status }).where('id', 'in', ids).execute(),
        );
  await setStatus('SUSPENDED');
  try {
    await work();
  } finally {
    await setStatus('ACTIVE');
  }
}

describe('there is always a super administrator', () => {
  it('one super administrator may remove another', async () => {
    const second = await createStaff(app, ['SUPER_ADMIN']);
    const res = await adminApi.post(`/admin/staff/${second.userId}/roles/revoke`, {
      role: 'SUPER_ADMIN',
      cityId: null,
      reason: 'Handing over',
    });
    expect(res.status).toBe(204);
  });

  // Through the API the caller is itself another super administrator, so this guard is a
  // second line of defence (e.g. if user.manage is ever given to another role).
  it('the last active super administrator cannot be removed or suspended', async () => {
    const staff = app.http.get(StaffAdminService);
    const context = { ...SYSTEM, reason: 'Guard check' };
    await withOnlySuperAdmins([admin.userId], async () => {
      await expect(staff.setStatus(context, admin.userId, 'SUSPENDED')).rejects.toMatchObject({
        code: 'LAST_SUPER_ADMIN',
      });
      await expect(
        staff.revoke(context, admin.userId, { role: 'SUPER_ADMIN', cityId: null }),
      ).rejects.toMatchObject({ code: 'LAST_SUPER_ADMIN' });
    });
  });
});

describe('first super administrator of a new environment', () => {
  const cli = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../src/staff-bootstrap.cli.ts',
  );
  const run = (address: string) =>
    promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', cli, '--email', address, '--name', 'First Admin'],
      { env: { ...process.env } },
    );

  it('is refused once a super administrator exists', async () => {
    await expect(run(email())).rejects.toMatchObject({
      stderr: expect.stringContaining('already exists') as string,
    });
  });

  it('creates the account with an invitation when none exists', async () => {
    const address = email();
    let output = '';
    await withOnlySuperAdmins([], async () => {
      output = (await run(address)).stdout;
    });
    const token = output.split('\n')[2]?.trim() ?? '';
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(
      (await api.post('/auth/staff/invitation/accept', { token, password: STRONG })).status,
    ).toBe(204);
    const first = await firstSignIn(address, STRONG);
    expect((await first.get('/admin/staff')).status).toBe(200);
  });
});
