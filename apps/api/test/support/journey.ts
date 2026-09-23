import { sql } from 'kysely';
import { JobRunner, type JobName } from '../../src/jobs/job-runner.service.js';
import { PAYMENT_PROVIDER } from '../../src/payments/providers/payment-provider.js';
import type {
  SandboxPaymentProvider,
  SignedWebhook,
} from '../../src/payments/providers/sandbox.provider.js';
import { inTransaction } from '../../src/database/transaction.js';
import type { ApiClient } from './http.js';
import { signInWithOtp, type PhoneSession } from './phone-auth.js';
import { signInStaff, type StaffMember } from './staff.js';
import { SYSTEM, type TestApp, type World } from './world.js';

/** Noida, Sector 62 (zone centre) — configuration data only; nothing in the code knows Noida. */
export const NOIDA_SECTOR_62 = { lat: 28.627, lng: 77.3727 };

export function sandbox(app: TestApp): SandboxPaymentProvider {
  return app.http.get<SandboxPaymentProvider>(PAYMENT_PROVIDER);
}

export function runJob(app: TestApp, name: JobName) {
  return app.http.get(JobRunner).runOnce(name);
}

/** Delivers a gateway webhook exactly as received (raw bytes + headers). */
export function deliverWebhook(api: ApiClient, webhook: SignedWebhook) {
  return api.post<{ status: string; eventId: string }>(
    '/payments/webhooks/sandbox',
    webhook.rawBody,
    webhook.headers,
  );
}

/** Invoice issuer is business configuration, set here as operations would in the admin panel. */
export async function configureInvoiceIssuer(
  api: ApiClient,
  superAdminToken: string,
): Promise<void> {
  const res = await api.as(superAdminToken).send('PUT', '/admin/settings/invoice.issuer', {
    value: {
      legalName: 'One Tappe (test entity)',
      gstin: null,
      address: 'Sector 62, Noida, Uttar Pradesh',
      series: 'OT-TEST',
    },
    description: 'Invoice issuer used on customer invoices',
    reason: 'Configure invoicing for the acceptance test',
  });
  if (res.status !== 204)
    throw new Error(`Setting invoice issuer failed: ${JSON.stringify(res.body)}`);
}

/**
 * One sign-in per operations member for the whole test file: every sign-in consumes a
 * TOTP step (replays are rejected), so signing in per worker would run ahead of the clock.
 */
const opsTokens = new WeakMap<StaffMember, string>();
async function operationsToken(api: ApiClient, ops: StaffMember): Promise<string> {
  const cached = opsTokens.get(ops);
  if (cached) return cached;
  const token = await signInStaff(api, ops);
  opsTokens.set(ops, token);
  return token;
}

/** The smallest valid JPEG header followed by filler: passes the byte-level type check. */
export const TEST_JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]),
  Buffer.from('test image content'),
]);

export interface OnboardedWorker {
  readonly session: PhoneSession;
  readonly workerId: string;
}

/**
 * Onboards a worker through the real APIs: OTP sign-in → profile → document upload →
 * staff verification, police check and training → approval → activation → permission,
 * shift → online. Returns the worker's session.
 */
export async function onboardWorkerViaApi(
  app: TestApp,
  api: ApiClient,
  ops: StaffMember,
  world: World,
  options: { shiftStartHour?: number; shiftEndHour?: number; goOnline?: boolean } = {},
): Promise<OnboardedWorker> {
  const session = await signInWithOtp(app, api, 'worker');
  const worker = api.as(session.accessToken);
  const expect200 = (label: string, res: { status: number; body: unknown }) => {
    if (res.status < 200 || res.status >= 300)
      throw new Error(`${label} failed (${res.status}): ${JSON.stringify(res.body)}`);
  };

  expect200(
    'profile',
    await worker.patch('/worker/me', {
      fullName: 'Sunita Devi',
      dateOfBirth: '1990-04-12',
      languages: ['hi'],
      emergencyContactName: 'Ramesh',
      emergencyContactPhone: '+919811111111',
      homeAddress: {
        houseNumber: 'C-44',
        street: 'Sector 63',
        landmark: null,
        pincode: world.pincode,
        cityName: 'Noida',
        lat: world.center.lat,
        lng: world.center.lng,
      },
    }),
  );

  const upload = await worker.post<{ documentId: string; upload: { url: string } }>(
    '/worker/me/documents',
    { verificationType: 'IDENTITY', contentType: 'image/jpeg' },
  );
  expect200('upload link', upload);
  const put = await app.http.inject({
    method: 'PUT',
    url: `${new URL(upload.body.upload.url).pathname}${new URL(upload.body.upload.url).search}`,
    headers: { 'content-type': 'application/octet-stream' },
    payload: TEST_JPEG,
  });
  if (put.statusCode !== 204) throw new Error(`Document upload failed: ${put.body}`);
  expect200(
    'submit',
    await worker.post('/worker/me/verifications', {
      verificationType: 'IDENTITY',
      documentId: upload.body.documentId,
      referenceLast4: '1234',
    }),
  );
  // Staff can only accept a document once it has passed the malware scan.
  await runJob(app, 'scan-documents');

  const opsToken = await operationsToken(api, ops);
  const staff = api.as(opsToken);
  const detail = await staff.get<{
    verifications: Array<{ id: string; verification_type: string }>;
  }>(`/admin/workers/${session.user.id}`);
  const identity = detail.body.verifications.find((v) => v.verification_type === 'IDENTITY');
  if (!identity) throw new Error('Identity submission not visible to operations');
  expect200(
    'verify identity',
    await staff.post(`/admin/workers/${session.user.id}/verifications/${identity.id}/decision`, {
      decision: 'VERIFIED',
      reason: 'Original ID seen in person',
    }),
  );
  expect200(
    'police check',
    await staff.post(`/admin/workers/${session.user.id}/verifications`, {
      type: 'POLICE',
      decision: 'VERIFIED',
      method: 'Noida police verification certificate',
      reason: 'Certificate checked',
    }),
  );
  expect200(
    'training',
    await staff.post(`/admin/workers/${session.user.id}/training`, {
      moduleCode: 'HOUSE_HELP_BASICS',
      status: 'PASSED',
      score: 90,
      reason: 'Practical assessment passed',
    }),
  );
  expect200(
    'approve',
    await staff.post(`/admin/workers/${session.user.id}/status`, {
      status: 'APPROVED',
      reason: 'All checks and training complete',
    }),
  );
  expect200(
    'activate',
    await staff.post(`/admin/workers/${session.user.id}/status`, {
      status: 'ACTIVE',
      reason: 'Ready for first jobs',
    }),
  );
  expect200(
    'permission',
    await staff.post(`/admin/workers/${session.user.id}/service-permissions`, {
      serviceId: world.serviceId,
      reason: 'Trained for house help',
    }),
  );
  expect200(
    'shift',
    await staff.post(`/admin/workers/${session.user.id}/shifts`, {
      zoneId: world.zoneId,
      start: world.at(options.shiftStartHour ?? 8).toISOString(),
      end: world.at(options.shiftEndHour ?? 20).toISOString(),
    }),
  );
  if (options.goOnline ?? true)
    expect200('online', await worker.post('/worker/me/presence', { online: true }));
  return { session, workerId: session.user.id };
}

/** Moves an offer's expiry into the past (offer times are otherwise immutable by design). */
export async function expireOffer(app: TestApp, assignmentId: string): Promise<void> {
  await sql`ALTER TABLE booking_assignment DISABLE TRIGGER booking_assignment_before_update`.execute(
    app.owner,
  );
  try {
    await inTransaction(app.db, SYSTEM, (tx) =>
      tx
        .updateTable('booking_assignment')
        .set({
          offered_at: new Date(Date.now() - 400_000),
          offer_expires_at: new Date(Date.now() - 1_000),
        })
        .where('id', '=', assignmentId)
        .execute(),
    );
  } finally {
    await sql`ALTER TABLE booking_assignment ENABLE TRIGGER booking_assignment_before_update`.execute(
      app.owner,
    );
  }
}
