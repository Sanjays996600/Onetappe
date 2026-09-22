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
  } finally {
    await pool.end();
  }
}
