import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction } from '../src/database/transaction.js';
import { DOCUMENT_STORAGE } from '../src/storage/document-storage.js';
import type { LocalDocumentStorage } from '../src/storage/local-document-storage.js';
import { ApiClient } from './support/http.js';
import { TEST_JPEG, runJob } from './support/journey.js';
import { signInWithOtp, type PhoneSession } from './support/phone-auth.js';
import { createStaff, signInStaff } from './support/staff.js';
import { SYSTEM, createTestApp, type TestApp } from './support/world.js';

type Json = Record<string, unknown>;
type ErrorBody = { error: { code: string } };

let app: TestApp;
let api: ApiClient;
let staffToken: string;

beforeAll(async () => {
  app = await createTestApp();
  api = new ApiClient(app.http);
  staffToken = await signInStaff(api, await createStaff(app, ['WORKER_OPERATIONS']));
});

afterAll(async () => {
  await app.close();
});

async function worker(): Promise<{ session: PhoneSession; client: ApiClient }> {
  const session = await signInWithOtp(app, api, 'worker');
  return { session, client: api.as(session.accessToken) };
}

/** Requests an upload target, uploads `bytes` to it and returns the document id. */
async function upload(
  client: ApiClient,
  bytes: Buffer,
  contentType = 'image/jpeg',
  type = 'IDENTITY',
) {
  const target = await client.post<{ documentId: string; upload: { url: string; method: string } }>(
    '/worker/me/documents',
    { verificationType: type, contentType },
  );
  expect(target.status).toBe(201);
  const url = new URL(target.body.upload.url);
  const put = await app.http.inject({
    method: 'PUT',
    url: `${url.pathname}${url.search}`,
    headers: { 'content-type': 'application/octet-stream' },
    payload: bytes,
  });
  expect(put.statusCode).toBe(204);
  return target.body.documentId;
}

function submit(client: ApiClient, documentId: string, type = 'IDENTITY') {
  return client.post<ErrorBody>('/worker/me/verifications', {
    verificationType: type,
    documentId,
    referenceLast4: '4321',
  });
}

const documentRow = (id: string) =>
  app.db
    .selectFrom('stored_document')
    .select([
      'status',
      'rejection_reason',
      'detected_content_type',
      'sha256',
      'object_key',
      'deleted_reason',
    ])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();

describe('upload checks', () => {
  it('refuses a file whose bytes are not the declared type, and deletes it', async () => {
    const { client } = await worker();
    const id = await upload(
      client,
      Buffer.from('<html><script>alert(1)</script></html>'),
      'image/png',
    );
    const res = await submit(client, id);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DOCUMENT_TYPE_MISMATCH');
    const row = await documentRow(id);
    expect(row).toMatchObject({ status: 'REJECTED', rejection_reason: 'TYPE_MISMATCH' });
    const storage = app.http.get<LocalDocumentStorage>(DOCUMENT_STORAGE);
    expect(await storage.head(row.object_key)).toBeNull();
  });

  it('refuses declared types other than JPEG, PNG and PDF', async () => {
    const { client } = await worker();
    const res = await client.post<ErrorBody>('/worker/me/documents', {
      verificationType: 'IDENTITY',
      contentType: 'image/svg+xml',
    });
    expect(res.body.error.code).toBe('FILE_TYPE_INVALID');
  });

  it('a worker cannot submit another worker’s upload, or reuse one for a different check', async () => {
    const owner = await worker();
    const other = await worker();
    const id = await upload(owner.client, TEST_JPEG);
    expect((await submit(other.client, id)).status).toBe(404);
    const wrongCheck = await submit(owner.client, id, 'ADDRESS');
    expect(wrongCheck.status).toBe(403);
    expect(wrongCheck.body.error.code).toBe('DOCUMENT_NOT_FOR_THIS_CHECK');
  });

  it('records the real type, size and hash, then waits for the malware scan', async () => {
    const { client } = await worker();
    const id = await upload(client, TEST_JPEG);
    expect((await submit(client, id)).status).toBeLessThan(300);
    expect(await documentRow(id)).toMatchObject({
      status: 'PENDING_SCAN',
      detected_content_type: 'image/jpeg',
    });
  });
});

describe('staff access', () => {
  async function submittedDocument() {
    const { session, client } = await worker();
    const id = await upload(client, TEST_JPEG);
    await submit(client, id);
    const detail = await api
      .as(staffToken)
      .get<{ verifications: Array<{ id: string }> }>(`/admin/workers/${session.user.id}`);
    const verificationId = detail.body.verifications[0]?.id ?? '';
    return { workerId: session.user.id, documentId: id, verificationId };
  }

  it('cannot open or accept a document before it has passed the malware scan', async () => {
    const { workerId, verificationId } = await submittedDocument();
    const staff = api.as(staffToken);
    const open = await staff.post<ErrorBody>(
      `/admin/workers/${workerId}/verifications/${verificationId}/document`,
      { reason: 'Checking identity document' },
    );
    expect(open.body.error.code).toBe('DOCUMENT_NOT_SCANNED');
    const accept = await staff.post<ErrorBody>(
      `/admin/workers/${workerId}/verifications/${verificationId}/decision`,
      { decision: 'VERIFIED', reason: 'Looks right' },
    );
    expect(accept.body.error.code).toBe('DOCUMENT_NOT_SCANNED');
  });

  it('after scanning: served as an inert download, with the viewer and reason audited', async () => {
    const { workerId, verificationId } = await submittedDocument();
    await runJob(app, 'scan-documents');
    const res = await app.http.inject({
      method: 'POST',
      url: `/api/v1/admin/workers/${workerId}/verifications/${verificationId}/document`,
      headers: { authorization: `Bearer ${staffToken}`, 'content-type': 'application/json' },
      payload: { reason: 'Checking identity document' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(TEST_JPEG)).toBe(true);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['content-disposition']).toMatch(/^attachment/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');

    const audit = await app.db
      .selectFrom('audit_log')
      .select(['action', 'reason', 'actor_role'])
      .where('entity_type', '=', 'worker_document')
      .where('entity_id', '=', verificationId)
      .execute();
    expect(audit).toEqual([
      { action: 'READ', reason: 'Checking identity document', actor_role: 'WORKER_OPERATIONS' },
    ]);
  });

  it('staff without the document permission cannot open documents', async () => {
    const { workerId, verificationId } = await submittedDocument();
    await runJob(app, 'scan-documents');
    const dispatcher = await signInStaff(api, await createStaff(app, ['DISPATCHER']));
    const res = await api
      .as(dispatcher)
      .post(`/admin/workers/${workerId}/verifications/${verificationId}/document`, {
        reason: 'curious',
      });
    expect(res.status).toBe(403);
  });

  it('refuses to serve a file that changed after it was scanned', async () => {
    const { workerId, documentId, verificationId } = await submittedDocument();
    await runJob(app, 'scan-documents');
    const row = await documentRow(documentId);
    const storage = app.http.get<LocalDocumentStorage>(DOCUMENT_STORAGE);
    await storage.delete(row.object_key);
    await storage.store(row.object_key, Buffer.concat([TEST_JPEG, Buffer.from('swapped')]));
    const res = await api
      .as(staffToken)
      .post<ErrorBody>(`/admin/workers/${workerId}/verifications/${verificationId}/document`, {
        reason: 'Checking identity document',
      });
    expect(res.body.error.code).toBe('DOCUMENT_TAMPERED');
  });
});

describe('retention', () => {
  it('deletes a leaver’s documents after the configured period, keeping the record', async () => {
    await inTransaction(app.db, SYSTEM, (tx) =>
      tx
        .insertInto('business_setting')
        .values({
          key: 'documents.retention',
          value: JSON.stringify({ daysAfterOffboarding: 0 }),
          description: 'test',
        })
        .onConflict((oc) =>
          oc.column('key').doUpdateSet({ value: JSON.stringify({ daysAfterOffboarding: 0 }) }),
        )
        .execute(),
    );
    const { session, client } = await worker();
    const id = await upload(client, TEST_JPEG);
    await submit(client, id);
    await runJob(app, 'scan-documents');

    const ops = await signInStaff(api, await createStaff(app, ['OPERATIONS_HEAD']));
    const res = await api.as(ops).post(`/admin/workers/${session.user.id}/status`, {
      status: 'REJECTED',
      reason: 'Did not complete training',
    });
    expect(res.status).toBeLessThan(300);
    await runJob(app, 'purge-documents');

    const row = await documentRow(id);
    expect(row).toMatchObject({ status: 'DELETED', deleted_reason: 'RETENTION_EXPIRED' });
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/); // the record (and its hash) remain
    const storage = app.http.get<LocalDocumentStorage>(DOCUMENT_STORAGE);
    expect(await storage.head(row.object_key)).toBeNull();
  });

  it('removes uploads that were never submitted after a day', async () => {
    const { client } = await worker();
    const target = await client.post<Json>('/worker/me/documents', {
      verificationType: 'IDENTITY',
      contentType: 'image/jpeg',
    });
    const id = target.body['documentId'] as string;
    await inTransaction(app.db, SYSTEM, (tx) =>
      tx
        .updateTable('stored_document')
        .set({ created_at: new Date(Date.now() - 25 * 3_600_000) })
        .where('id', '=', id)
        .execute(),
    );
    await runJob(app, 'purge-documents');
    expect(await documentRow(id)).toMatchObject({
      status: 'DELETED',
      deleted_reason: 'ABANDONED_UPLOAD',
    });
  });
});
