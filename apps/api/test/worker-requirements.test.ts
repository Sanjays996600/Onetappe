import { randomInt } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction } from '../src/database/transaction.js';
import { ApiClient } from './support/http.js';
import { createStaff, signInStaff } from './support/staff.js';
import { SYSTEM, createTestApp, createWorld, type TestApp, type World } from './support/world.js';

/**
 * G4: training modules and worker requirements are configuration, changed through the API
 * with a permission, a reason, a fresh authenticator check and an audit record. Adding a
 * requirement is immediate; removing one needs a second person, and the database refuses a
 * removal that was not approved. No staff role holds these permissions yet (a business
 * decision), so the tests grant them through roles that exist only in the test database.
 */

type Json = Record<string, unknown>;

const MANAGER_ROLE = 'TEST_REQUIREMENT_MANAGER';
const APPROVER_ROLE = 'TEST_REQUIREMENT_APPROVER';
const BOTH_ROLE = 'TEST_REQUIREMENT_BOTH';

let app: TestApp;
let api: ApiClient;
let manager: ApiClient;
let managerId: string;
let approver: ApiClient;
let approverId: string;
let world: World;

async function testRole(code: string, permissions: string[]) {
  await inTransaction(app.db, SYSTEM, async (tx) => {
    await tx
      .insertInto('role')
      .values({ code, name: code, description: 'Test-only role', is_staff: true })
      .onConflict((oc) => oc.column('code').doNothing())
      .execute();
    for (const permission of permissions) {
      await tx
        .insertInto('role_permission')
        .values({ role_code: code, permission_code: permission })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
  });
}

async function staffClient(roles: string[], options: { cityId?: string } = {}) {
  const member = await createStaff(app, roles, options);
  return { id: member.userId, client: api.as(await signInStaff(api, member)) };
}

async function ineligibility(workerId: string): Promise<string | null> {
  const { rows } = await sql<{ reason: string | null }>`
    SELECT worker_ineligibility_reason(
      ${workerId}::uuid, ${world.serviceId}::uuid, ${world.zoneId}::uuid,
      tstzrange(now() + interval '1 day', now() + interval '1 day 2 hours')
    ) AS reason
  `.execute(app.db);
  return rows[0]?.reason ?? null;
}

async function requirements(): Promise<{ verification: string[]; training: string[] }> {
  const [verification, training] = await Promise.all([
    app.db
      .selectFrom('service_verification_requirement')
      .select('verification_type')
      .where('service_id', '=', world.serviceId)
      .execute(),
    app.db
      .selectFrom('service_training_requirement')
      .select('module_code')
      .where('service_id', '=', world.serviceId)
      .execute(),
  ]);
  return {
    verification: verification.map((r) => r.verification_type).sort(),
    training: training.map((r) => r.module_code).sort(),
  };
}

function uniqueCode(prefix: string): string {
  return `${prefix}_${String(Date.now()).slice(-6)}${String(randomInt(1000))}`;
}

beforeAll(async () => {
  app = await createTestApp();
  api = new ApiClient(app.http);
  const read = 'worker_requirement.read';
  await testRole(MANAGER_ROLE, [read, 'worker_requirement.manage']);
  await testRole(APPROVER_ROLE, [read, 'worker_requirement.approve_relaxation']);
  await testRole(BOTH_ROLE, [
    read,
    'worker_requirement.manage',
    'worker_requirement.approve_relaxation',
  ]);
  ({ id: managerId, client: manager } = await staffClient([MANAGER_ROLE]));
  ({ id: approverId, client: approver } = await staffClient([APPROVER_ROLE]));
});

afterAll(async () => {
  // Worker approval checks the requirements of every active service, so leave the shared
  // test database as found: remove what these tests added, through the two-person flow.
  const open = await app.db
    .selectFrom('worker_requirement_relaxation')
    .select(['id', 'requested_by'])
    .where('service_id', '=', world.serviceId)
    .where('status', '=', 'PENDING')
    .execute();
  for (const r of open) {
    await inTransaction(
      app.db,
      { ...SYSTEM, actorUserId: r.requested_by, reason: 'Test cleanup' },
      (tx) =>
        tx
          .updateTable('worker_requirement_relaxation')
          .set({ status: 'WITHDRAWN', decided_at: new Date(), decision_note: 'Test cleanup' })
          .where('id', '=', r.id)
          .execute(),
    );
  }
  const { verification } = await requirements();
  for (const extra of verification.filter((v) => !['IDENTITY', 'POLICE'].includes(v))) {
    const request = await manager.post<Json>('/admin/config/worker-requirements/relaxations', {
      kind: 'VERIFICATION',
      serviceId: world.serviceId,
      verificationType: extra,
      reason: 'Test cleanup',
    });
    await approver.post(
      `/admin/config/worker-requirements/relaxations/${request.body['id'] as string}/approve`,
      { note: 'Test cleanup' },
    );
  }
  expect((await requirements()).verification).toEqual(['IDENTITY', 'POLICE']);
  await app.close();
});

describe('authority', () => {
  it('no existing staff role holds the new permissions (assignment is a business decision)', async () => {
    const grants = await app.db
      .selectFrom('role_permission')
      .select(['role_code', 'permission_code'])
      .where('permission_code', 'like', 'worker_requirement.%')
      .where('role_code', 'not like', 'TEST_%')
      .execute();
    expect(grants).toEqual([]);
  });

  it('staff without the permissions cannot read or change requirements', async () => {
    world = await createWorld(app.db, { workers: 1 });
    for (const role of ['SUPER_ADMIN', 'WORKER_OPERATIONS', 'OPERATIONS_HEAD']) {
      const { client } = await staffClient([role]);
      expect((await client.get('/admin/config/worker-requirements')).status).toBe(403);
      const add = await client.post(
        `/admin/config/services/${world.serviceId}/verification-requirements`,
        { verificationType: 'PHOTO', reason: 'Photo needed for the badge' },
      );
      expect(add.status).toBe(403);
      const relax = await client.post('/admin/config/worker-requirements/relaxations', {
        kind: 'VERIFICATION',
        serviceId: world.serviceId,
        verificationType: 'POLICE',
        reason: 'Trying to weaken the rules',
      });
      expect(relax.status).toBe(403);
    }
    expect((await requirements()).verification).toEqual(['IDENTITY', 'POLICE']);
  });

  it('a role limited to one city cannot change rules that apply everywhere', async () => {
    const { client } = await staffClient([MANAGER_ROLE], { cityId: world.cityId });
    const response = await client.post<Json>(
      `/admin/config/services/${world.serviceId}/verification-requirements`,
      { verificationType: 'PHOTO', reason: 'Photo needed for the badge' },
    );
    expect(response.status).toBe(403);
    expect((response.body['error'] as Json)['code']).toBe('CITY_SCOPE_REQUIRED');
  });
});

describe('training modules', () => {
  it('are created and edited with a reason, validated and audited', async () => {
    const code = uniqueCode('SAFETY');
    const created = await manager.post<Json>('/admin/config/training-modules', {
      code,
      name: 'Safety at the customer home',
      reason: 'New safety module for all house help',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ code, is_active: true });

    expect(
      (
        await manager.post('/admin/config/training-modules', {
          code,
          name: 'Again',
          reason: 'Duplicate code',
        })
      ).status,
    ).toBe(409);
    for (const invalid of [
      { code: 'lower', name: 'Bad code', reason: 'Validation check' },
      { code: 'OK_CODE', name: 'No reason' },
      { code: 'OK_CODE', name: 'x', reason: 'Name too short' },
      { code: 'OK_CODE', name: 'Extra field', reason: 'Validation check', isRequired: true },
    ]) {
      expect((await manager.post('/admin/config/training-modules', invalid)).status).toBe(400);
    }

    const renamed = await manager.patch<Json>(`/admin/config/training-modules/${code}`, {
      name: 'Safety in the home',
      reason: 'Clearer name',
    });
    expect(renamed.body).toMatchObject({ code, name: 'Safety in the home' });

    const audit = await app.db
      .selectFrom('audit_log')
      .select(['action', 'actor_user_id', 'reason'])
      .where('entity_type', '=', 'training_module')
      .where('entity_id', '=', code)
      .orderBy('id')
      .execute();
    expect(audit).toEqual([
      {
        action: 'INSERT',
        actor_user_id: managerId,
        reason: 'New safety module for all house help',
      },
      { action: 'UPDATE', actor_user_id: managerId, reason: 'Clearer name' },
    ]);
  });

  it('a module a service requires cannot be switched off, by the API or by SQL', async () => {
    const response = await manager.patch<Json>('/admin/config/training-modules/HOUSE_HELP_BASICS', {
      isActive: false,
      reason: 'Trying to retire a required module',
    });
    expect(response.status).toBe(422);
    expect((response.body['error'] as Json)['code']).toBe('TRAINING_MODULE_REQUIRED');
    await expect(
      inTransaction(app.db, SYSTEM, (tx) =>
        tx
          .updateTable('training_module')
          .set({ is_active: false })
          .where('code', '=', 'HOUSE_HELP_BASICS')
          .execute(),
      ),
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATED' });
    await expect(
      inTransaction(app.db, SYSTEM, (tx) =>
        tx.deleteFrom('training_module').where('code', '=', 'HOUSE_HELP_BASICS').execute(),
      ),
    ).rejects.toMatchObject({ code: 'HISTORY_IS_PERMANENT' });
  });
});

describe('adding requirements', () => {
  it('takes effect for the next allocation and reports who is affected', async () => {
    const worker = world.workerIds[0] ?? '';
    expect(await ineligibility(worker)).toBeNull();

    const added = await manager.post<Json>(
      `/admin/config/services/${world.serviceId}/verification-requirements`,
      { verificationType: 'PHOTO', reason: 'Photo needed for the badge' },
    );
    expect(added.status).toBe(201);
    expect(added.body['impact']).toEqual({ permittedWorkers: 1, workersNotMeetingIt: 1 });
    expect(await ineligibility(worker)).toBe('VERIFICATION_MISSING:PHOTO');

    const again = await manager.post<Json>(
      `/admin/config/services/${world.serviceId}/verification-requirements`,
      { verificationType: 'PHOTO', reason: 'Photo needed for the badge' },
    );
    expect((again.body['error'] as Json)['code']).toBe('REQUIREMENT_EXISTS');

    const audit = await app.db
      .selectFrom('audit_log')
      .select(['action', 'actor_user_id', 'reason', 'after'])
      .where('entity_type', '=', 'service_verification_requirement')
      .where('entity_id', '=', world.serviceId)
      .where('action', '=', 'INSERT')
      .where('actor_user_id', '=', managerId)
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.after).toMatchObject({ verification_type: 'PHOTO' });
  });

  it('a training requirement needs an existing, active module', async () => {
    const unknown = await manager.post<Json>(
      `/admin/config/services/${world.serviceId}/training-requirements`,
      { moduleCode: 'NO_SUCH_MODULE', reason: 'Checking validation' },
    );
    expect(unknown.status).toBe(404);

    const code = uniqueCode('RETIRED');
    await manager.post('/admin/config/training-modules', {
      code,
      name: 'Retired module',
      reason: 'Module that will be switched off',
    });
    await manager.patch(`/admin/config/training-modules/${code}`, {
      isActive: false,
      reason: 'Switching it off',
    });
    const inactive = await manager.post<Json>(
      `/admin/config/services/${world.serviceId}/training-requirements`,
      { moduleCode: code, reason: 'Requiring an inactive module' },
    );
    expect(inactive.status).toBe(422);
    expect((inactive.body['error'] as Json)['code']).toBe('TRAINING_MODULE_INACTIVE');
  });
});

describe('removing requirements needs two people', () => {
  it('request, refuse self-approval, approve by another person: the requirement is removed', async () => {
    const worker = world.workerIds[0] ?? '';
    const request = await manager.post<Json>('/admin/config/worker-requirements/relaxations', {
      kind: 'VERIFICATION',
      serviceId: world.serviceId,
      verificationType: 'PHOTO',
      reason: 'Badge photos postponed until the studio is ready',
    });
    expect(request.status).toBe(201);
    expect(request.body).toMatchObject({ status: 'PENDING', requested_by: managerId });
    const id = request.body['id'] as string;

    // Still required while waiting.
    expect(await ineligibility(worker)).toBe('VERIFICATION_MISSING:PHOTO');

    const duplicate = await manager.post<Json>('/admin/config/worker-requirements/relaxations', {
      kind: 'VERIFICATION',
      serviceId: world.serviceId,
      verificationType: 'PHOTO',
      reason: 'Asking twice',
    });
    expect((duplicate.body['error'] as Json)['code']).toBe('RELAXATION_ALREADY_REQUESTED');

    // The requester cannot approve (no permission), and someone holding both cannot approve
    // their own request.
    expect(
      (
        await manager.post(`/admin/config/worker-requirements/relaxations/${id}/approve`, {
          note: 'Approving my own request',
        })
      ).status,
    ).toBe(403);
    const both = await staffClient([BOTH_ROLE]);
    const ownRequest = await both.client.post<Json>(
      '/admin/config/worker-requirements/relaxations',
      {
        kind: 'TRAINING',
        serviceId: world.serviceId,
        moduleCode: 'HOUSE_HELP_BASICS',
        reason: 'Training postponed this month',
      },
    );
    const ownApproval = await both.client.post<Json>(
      `/admin/config/worker-requirements/relaxations/${ownRequest.body['id'] as string}/approve`,
      { note: 'Approving my own request' },
    );
    expect(ownApproval.status).toBe(403);
    expect((ownApproval.body['error'] as Json)['code']).toBe('OWN_REQUEST');
    expect((await requirements()).training).toEqual(['HOUSE_HELP_BASICS']);

    // An approval needs a note.
    expect(
      (await approver.post(`/admin/config/worker-requirements/relaxations/${id}/approve`, {}))
        .status,
    ).toBe(400);

    const approved = await approver.post<Json>(
      `/admin/config/worker-requirements/relaxations/${id}/approve`,
      { note: 'Agreed with operations for the pilot month' },
    );
    expect(approved.status).toBe(201);
    expect(approved.body).toMatchObject({ status: 'APPLIED', decided_by: approverId });
    expect((await requirements()).verification).toEqual(['IDENTITY', 'POLICE']);
    expect(await ineligibility(worker)).toBeNull();

    const again = await approver.post<Json>(
      `/admin/config/worker-requirements/relaxations/${id}/approve`,
      { note: 'Approving twice' },
    );
    expect((again.body['error'] as Json)['code']).toBe('RELAXATION_NOT_PENDING');

    const removal = await app.db
      .selectFrom('audit_log')
      .select(['actor_user_id', 'reason', 'before'])
      .where('entity_type', '=', 'service_verification_requirement')
      .where('entity_id', '=', world.serviceId)
      .where('action', '=', 'DELETE')
      .execute();
    expect(removal).toEqual([
      {
        actor_user_id: approverId,
        reason: 'Agreed with operations for the pilot month',
        before: { service_id: world.serviceId, verification_type: 'PHOTO' },
      },
    ]);

    // Clean up the other open request so later tests start clean.
    await both.client.post(
      `/admin/config/worker-requirements/relaxations/${ownRequest.body['id'] as string}/withdraw`,
      { note: 'No longer needed' },
    );
  });

  it('a rejection keeps the requirement; only the requester can withdraw', async () => {
    const request = await manager.post<Json>('/admin/config/worker-requirements/relaxations', {
      kind: 'VERIFICATION',
      serviceId: world.serviceId,
      verificationType: 'POLICE',
      reason: 'Police checks take too long',
    });
    const id = request.body['id'] as string;
    expect(
      (await approver.post(`/admin/config/worker-requirements/relaxations/${id}/reject`, {}))
        .status,
    ).toBe(400);
    const rejected = await approver.post<Json>(
      `/admin/config/worker-requirements/relaxations/${id}/reject`,
      { note: 'Police verification stays mandatory' },
    );
    expect(rejected.body).toMatchObject({ status: 'REJECTED', decided_by: approverId });
    expect((await requirements()).verification).toEqual(['IDENTITY', 'POLICE']);

    const second = await manager.post<Json>('/admin/config/worker-requirements/relaxations', {
      kind: 'VERIFICATION',
      serviceId: world.serviceId,
      verificationType: 'POLICE',
      reason: 'Asking again with more detail',
    });
    const secondId = second.body['id'] as string;
    const other = await staffClient([MANAGER_ROLE]);
    const notMine = await other.client.post<Json>(
      `/admin/config/worker-requirements/relaxations/${secondId}/withdraw`,
      { note: 'Withdrawing someone else' },
    );
    expect((notMine.body['error'] as Json)['code']).toBe('NOT_REQUESTER');
    const withdrawn = await manager.post<Json>(
      `/admin/config/worker-requirements/relaxations/${secondId}/withdraw`,
      { note: 'Withdrawn after discussion' },
    );
    expect(withdrawn.body).toMatchObject({ status: 'WITHDRAWN' });
    expect((await requirements()).verification).toEqual(['IDENTITY', 'POLICE']);
  });

  it('asking to remove a requirement that does not exist is refused', async () => {
    const response = await manager.post<Json>('/admin/config/worker-requirements/relaxations', {
      kind: 'VERIFICATION',
      serviceId: world.serviceId,
      verificationType: 'FITNESS',
      reason: 'Removing something not required',
    });
    expect(response.status).toBe(404);
  });
});

describe('the database enforces the same rules', () => {
  it('refuses removing, editing or truncating requirements without an approved relaxation', async () => {
    await expect(
      inTransaction(app.db, SYSTEM, (tx) =>
        tx
          .deleteFrom('service_verification_requirement')
          .where('service_id', '=', world.serviceId)
          .execute(),
      ),
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATED' });
    await expect(
      inTransaction(app.db, SYSTEM, (tx) =>
        tx
          .updateTable('service_verification_requirement')
          .set({ verification_type: 'PHOTO' })
          .where('service_id', '=', world.serviceId)
          .where('verification_type', '=', 'POLICE')
          .execute(),
      ),
    ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
    await expect(
      inTransaction(app.db, SYSTEM, (tx) =>
        tx
          .deleteFrom('service_training_requirement')
          .where('service_id', '=', world.serviceId)
          .execute(),
      ),
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATED' });
    // The application role may not truncate at all; the owner is stopped by a trigger.
    await expect(sql`TRUNCATE service_verification_requirement`.execute(app.db)).rejects.toThrow(
      /permission denied|cannot be truncated/,
    );
    expect((await requirements()).verification).toEqual(['IDENTITY', 'POLICE']);
  });

  it('an approval cannot be forged, reused later or given by the requester', async () => {
    const asStaff = (userId: string) => ({ ...SYSTEM, actorUserId: userId, reason: 'SQL check' });
    // Inserted directly as approved: refused.
    await expect(
      inTransaction(app.db, asStaff(managerId), (tx) =>
        tx
          .insertInto('worker_requirement_relaxation')
          .values({
            service_id: world.serviceId,
            requirement_kind: 'VERIFICATION',
            verification_type: 'POLICE',
            reason: 'Forged approval',
            requested_by: managerId,
            status: 'APPLIED',
            decided_by: approverId,
            decided_at: new Date(),
            applied_txid: 1,
          })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS_TRANSITION' });

    // Approved by the requester: refused by the four-eyes check.
    const [pending] = await inTransaction(app.db, asStaff(managerId), (tx) =>
      tx
        .insertInto('worker_requirement_relaxation')
        .values({
          service_id: world.serviceId,
          requirement_kind: 'VERIFICATION',
          verification_type: 'POLICE',
          reason: 'Checking the database rules',
          requested_by: managerId,
        })
        .returning('id')
        .execute(),
    );
    await expect(
      inTransaction(app.db, asStaff(managerId), (tx) =>
        tx
          .updateTable('worker_requirement_relaxation')
          .set({
            status: 'APPLIED',
            decided_by: managerId,
            decided_at: new Date(),
            applied_txid: sql<number>`txid_current()`,
          })
          .where('id', '=', pending?.id ?? '')
          .execute(),
      ),
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATED' });

    // Properly approved earlier (PHOTO, first test above), then required again: that old
    // approval cannot be used to remove the new requirement.
    await manager.post(`/admin/config/services/${world.serviceId}/verification-requirements`, {
      verificationType: 'PHOTO',
      reason: 'Photo needed again',
    });
    await expect(
      inTransaction(app.db, asStaff(approverId), (tx) =>
        tx
          .deleteFrom('service_verification_requirement')
          .where('service_id', '=', world.serviceId)
          .where('verification_type', '=', 'PHOTO')
          .execute(),
      ),
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATED' });
    expect((await requirements()).verification).toEqual(['IDENTITY', 'PHOTO', 'POLICE']);
  });
});
