import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from '../../src/database/migrator.js';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

/** Rebuilds the test database from the migrations once per test run. */
export default async function setup(): Promise<void> {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) throw new Error('TEST_DATABASE_URL must be set to run the API tests');
  if (!/test/i.test(new URL(url).pathname)) {
    throw new Error(`Refusing to reset ${url}: the database name must contain "test"`);
  }

  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(pool, MIGRATIONS);
    // Unique numbers for test fixtures across the parallel test processes (fixtures.ts).
    await pool.query('CREATE SEQUENCE test_world_seq START 1');
    // The login the application under test uses: a member of the runtime role only.
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'onetappe_app_test') THEN
          CREATE ROLE onetappe_app_test LOGIN PASSWORD 'onetappe_app_test' IN ROLE onetappe_app;
        END IF;
      END $$`);
  } finally {
    await pool.end();
  }
}
