/**
 * Seeds an end-to-end database with one fully configured Noida service area (HH60-style
 * service, prices, one approved worker with a shift tomorrow) and prints what the tests
 * need as JSON. Also publishes the legal documents both apps require, so sign-up goes
 * through the terms screens as in production, and the invoice issuer. Run as the schema owner:  E2E_OWNER_URL=… tsx test/support/e2e-seed.ts
 */
import { createHash } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DB } from '../../src/database/db.generated.js';
import { inTransaction } from '../../src/database/transaction.js';
import { createWorld, SYSTEM } from './fixtures.js';

const url = process.env['E2E_OWNER_URL'];
if (!url || !/e2e/i.test(new URL(url).pathname)) {
  throw new Error('E2E_OWNER_URL must point to a database whose name contains "e2e"');
}
const db = new Kysely<DB>({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url }) }),
});
try {
  const effectiveFrom = new Date(Date.now() - 86_400_000);
  await inTransaction(db, SYSTEM, (tx) =>
    tx
      .insertInto('legal_document')
      .values(
        (
          [
            ['CUSTOMER_TERMS', 'Customer terms of service'],
            ['PRIVACY_NOTICE', 'Privacy notice'],
            ['CANCELLATION_POLICY', 'Cancellation and refund policy'],
            ['WORKER_TERMS', 'Partner terms'],
          ] as const
        ).map(([code, title]) => ({
          code,
          version: '2026-09',
          locale: 'en',
          title,
          url: `https://onetappe.in/legal/${code.toLowerCase()}/2026-09`,
          content_sha256: createHash('sha256').update(`${code} 2026-09`).digest('hex'),
          effective_from: effectiveFrom,
        })),
      )
      .onConflict((oc) => oc.doNothing())
      .execute(),
  );
  // The entity invoices are issued by (configured by operations in production).
  await inTransaction(db, SYSTEM, (tx) =>
    tx
      .insertInto('business_setting')
      .values({
        key: 'invoice.issuer',
        value: JSON.stringify({
          legalName: 'One Tappe Services Private Limited',
          gstin: '09AAACO1234A1Z5',
          address: 'Sector 62, Noida, Uttar Pradesh 201309',
          series: 'E2E',
        }),
        description: 'Invoice issuer (end-to-end tests)',
      })
      .onConflict((oc) => oc.doNothing())
      .execute(),
  );
  const world = await createWorld(db, {
    workers: Number(process.env['E2E_WORKERS'] ?? 1),
    cityName: 'Noida',
    zoneName: 'Sector 62',
    center: { lat: 28.627, lng: 77.3727 },
  });
  const workers = await db
    .selectFrom('app_user')
    .select(['id', 'phone_e164'])
    .where('id', 'in', [...world.workerIds])
    .execute();
  const service = await db
    .selectFrom('service')
    .select(['id', 'code', 'name'])
    .where('id', '=', world.serviceId)
    .executeTakeFirstOrThrow();
  process.stdout.write(
    `${JSON.stringify({
      cityId: world.cityId,
      zoneId: world.zoneId,
      pincode: world.pincode,
      center: world.center,
      day: world.day,
      service,
      workers: workers.map((w) => ({ id: w.id, phone: w.phone_e164 })),
    })}\n`,
  );
} finally {
  await db.destroy();
}
