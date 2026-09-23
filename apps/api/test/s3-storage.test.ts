import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { UploadTarget } from '../src/storage/document-storage.js';
import { S3DocumentStorage } from '../src/storage/s3-document-storage.js';
import { TEST_JPEG } from './support/journey.js';

/**
 * Runs against a real S3-compatible server that enforces presigned-POST policies (MinIO:
 * docker compose locally, a service in CI). Endpoint and credentials come from TEST_S3_*.
 */
const endpoint = process.env['TEST_S3_ENDPOINT'] ?? 'http://127.0.0.1:9000';
process.env['AWS_ACCESS_KEY_ID'] = process.env['TEST_S3_ACCESS_KEY'] ?? 'onetappe';
process.env['AWS_SECRET_ACCESS_KEY'] = process.env['TEST_S3_SECRET_KEY'] ?? 'onetappe-secret';
const bucket = `onetappe-test-${randomUUID().slice(0, 8)}`;
const region = 'ap-south-1';

let storage: S3DocumentStorage;

beforeAll(async () => {
  const admin = new S3Client({ region, endpoint, forcePathStyle: true });
  await admin.send(new CreateBucketCommand({ Bucket: bucket }));
  storage = new S3DocumentStorage({ bucket, region, endpoint });
});

async function post(target: UploadTarget, bytes: Buffer, overrides: Record<string, string> = {}) {
  const form = new FormData();
  for (const [field, value] of Object.entries({ ...target.fields, ...overrides })) {
    form.append(field, value);
  }
  form.append('file', new Blob([bytes]));
  const response = await fetch(target.url, { method: 'POST', body: form });
  return response.status;
}

describe('S3 document storage (presigned POST)', () => {
  it('accepts an upload within the policy and reads it back; delete removes it', async () => {
    const key = `workers/test/identity/${randomUUID()}`;
    const target = await storage.createUploadTarget(key, 'image/jpeg', 1024);
    expect(target.method).toBe('POST');
    expect(target.fields['key']).toBe(key);
    expect(target.fields['x-amz-server-side-encryption']).toBe('AES256');

    expect(await post(target, TEST_JPEG)).toBe(204);
    expect(await storage.head(key)).toEqual({ size: TEST_JPEG.length });
    expect((await storage.read(key)).equals(TEST_JPEG)).toBe(true);
    await storage.delete(key);
    expect(await storage.head(key)).toBeNull();
  });

  it('rejects a file larger than the limit', async () => {
    const key = `workers/test/identity/${randomUUID()}`;
    const target = await storage.createUploadTarget(key, 'image/jpeg', 64);
    expect(await post(target, Buffer.alloc(1000, 1))).toBeGreaterThanOrEqual(400);
    expect(await storage.head(key)).toBeNull();
  });

  it('rejects a different content type than the one signed', async () => {
    const key = `workers/test/identity/${randomUUID()}`;
    const target = await storage.createUploadTarget(key, 'image/jpeg', 1024);
    expect(await post(target, TEST_JPEG, { 'Content-Type': 'text/html' })).toBeGreaterThanOrEqual(
      400,
    );
    expect(await storage.head(key)).toBeNull();
  });

  it('rejects writing to any other object key with the same signature', async () => {
    const key = `workers/test/identity/${randomUUID()}`;
    const target = await storage.createUploadTarget(key, 'image/jpeg', 1024);
    const otherKey = `workers/someone-else/identity/${randomUUID()}`;
    expect(await post(target, TEST_JPEG, { key: otherKey })).toBeGreaterThanOrEqual(400);
    expect(await storage.head(otherKey)).toBeNull();
  });

  it('objects are not publicly readable', async () => {
    const key = `workers/test/identity/${randomUUID()}`;
    const target = await storage.createUploadTarget(key, 'image/jpeg', 1024);
    await post(target, TEST_JPEG);
    const anonymous = await fetch(`${endpoint}/${bucket}/${key}`);
    expect(anonymous.status).toBe(403);
  });
});
