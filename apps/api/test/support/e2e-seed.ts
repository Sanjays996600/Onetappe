/**
 * Seeds an end-to-end database with one fully configured Noida service area (HH60-style
 * service, prices, one approved worker with a shift tomorrow) and prints what the tests
 * need as JSON. Run as the schema owner:  E2E_OWNER_URL=… tsx test/support/e2e-seed.ts
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DB } from '../../src/database/db.generated.js';
import { createWorld } from './fixtures.js';

const url = process.env['E2E_OWNER_URL'];
if (!url || !/e2e/i.test(new URL(url).pathname)) {
  throw new Error('E2E_OWNER_URL must point to a database whose name contains "e2e"');
}
const db = new Kysely<DB>({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url }) }),
});
try {
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
