import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from './migrator.js';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    const result = await migrate(pool, MIGRATIONS_DIR);
    for (const name of result.applied) console.log(`applied  ${name}`);
    console.log(
      `${result.applied.length} applied, ${result.alreadyApplied.length} already up to date`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
