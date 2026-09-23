import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { UploadTarget } from '../src/storage/document-storage.js';
import { S3DocumentStorage } from '../src/storage/s3-document-storage.js';
import { TEST_JPEG } from './support/journey.js';

/**
 * Runs against an S3-compatible server (moto locally and in CI; MinIO via docker compose
 * also works). Endpoint and credentials come from TEST_S3_*. Enforcement of the signed
 * upload policy is S3's; these tests prove the policy we sign and the full round trip.
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

  it('signs a policy that pins the key, type, size range, encryption and a short expiry', async () => {
    // S3 enforces this policy on upload; what we must guarantee is that the signed policy
    // contains exactly these restrictions (checked against the real bucket before launch).
    const key = `workers/test/identity/${randomUUID()}`;
    const before = Date.now();
    const target = await storage.createUploadTarget(key, 'application/pdf', 5 * 1024 * 1024);
    const policy = JSON.parse(
      Buffer.from(target.fields['Policy'] ?? '', 'base64').toString('utf8'),
    ) as {
      expiration: string;
      conditions: unknown[];
    };
    const expiresIn = new Date(policy.expiration).getTime() - before;
    expect(expiresIn).toBeGreaterThan(4 * 60_000);
    expect(expiresIn).toBeLessThanOrEqual(5 * 60_000 + 2_000);
    expect(policy.conditions).toEqual(
      expect.arrayContaining([
        { bucket },
        { key },
        ['content-length-range', 1, 5 * 1024 * 1024],
        ['eq', '$Content-Type', 'application/pdf'],
        ['eq', '$x-amz-server-side-encryption', 'AES256'],
      ]),
    );
    // No wildcard key or type conditions that would widen what can be written.
    expect(JSON.stringify(policy.conditions)).not.toContain('starts-with');
  });

  it('uses the customer-managed KMS key when one is configured', async () => {
    const kms = new S3DocumentStorage({
      bucket,
      region,
      endpoint,
      kmsKeyId: 'arn:aws:kms:ap-south-1:111122223333:key/test',
    });
    const target = await kms.createUploadTarget(
      `workers/test/identity/${randomUUID()}`,
      'image/png',
      1024,
    );
    const policy = JSON.parse(
      Buffer.from(target.fields['Policy'] ?? '', 'base64').toString('utf8'),
    ) as {
      conditions: unknown[];
    };
    expect(policy.conditions).toEqual(
      expect.arrayContaining([
        ['eq', '$x-amz-server-side-encryption', 'aws:kms'],
        [
          'eq',
          '$x-amz-server-side-encryption-aws-kms-key-id',
          'arn:aws:kms:ap-south-1:111122223333:key/test',
        ],
      ]),
    );
  });

  it('objects are not publicly readable', async () => {
    const key = `workers/test/identity/${randomUUID()}`;
    const target = await storage.createUploadTarget(key, 'image/jpeg', 1024);
    await post(target, TEST_JPEG);
    const anonymous = await fetch(`${endpoint}/${bucket}/${key}`);
    expect(anonymous.status).toBe(403);
  });
});
