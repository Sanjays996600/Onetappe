import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';

/**
 * Forward-only SQL migrations.
 *
 * - Files in `migrations/` named `NNNN_description.sql` run in lexical order.
 * - Each file runs in its own transaction and is recorded with a SHA-256 checksum.
 * - An already-applied file whose content changed is a hard error: history is fixed,
 *   corrections go in a new migration.
 * - A PostgreSQL advisory lock stops two deployments migrating at the same time.
 */

const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;
const ADVISORY_LOCK_KEY = 7_140_531_001;

export interface MigrationFile {
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

export class MigrationChecksumError extends Error {
  constructor(readonly migration: string) {
    super(`Migration ${migration} was modified after it was applied. Add a new migration instead.`);
    this.name = 'MigrationChecksumError';
  }
}

export async function loadMigrationFiles(directory: string): Promise<MigrationFile[]> {
  const entries = await readdir(directory);
  const unexpected = entries.filter((name) => name.endsWith('.sql') && !MIGRATION_FILE.test(name));
  if (unexpected.length > 0) {
    throw new Error(`Badly named migration files: ${unexpected.join(', ')}`);
  }
  const names = entries.filter((name) => MIGRATION_FILE.test(name)).sort();
  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(path.join(directory, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
}

export async function migrate(pool: Pool, directory: string): Promise<MigrationResult> {
  const files = await loadMigrationFiles(directory);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    try {
      await ensureMigrationTable(client);
      const applied = await appliedChecksums(client);
      const result = { applied: [] as string[], alreadyApplied: [] as string[] };

      for (const file of files) {
        const existing = applied.get(file.name);
        if (existing !== undefined) {
          if (existing !== file.checksum) throw new MigrationChecksumError(file.name);
          result.alreadyApplied.push(file.name);
          continue;
        }
        await applyFile(client, file);
        result.applied.push(file.name);
      }
      return result;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

async function ensureMigrationTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )`);
}

async function appliedChecksums(client: PoolClient): Promise<Map<string, string>> {
  const { rows } = await client.query<{ name: string; checksum: string }>(
    'SELECT name, checksum FROM schema_migration',
  );
  return new Map(rows.map((row) => [row.name, row.checksum]));
}

async function applyFile(client: PoolClient, file: MigrationFile): Promise<void> {
  await client.query('BEGIN');
  try {
    // Rows written by migrations (seed data) are attributed to the migration itself.
    await client.query(
      `SELECT set_config('app.source', 'SYSTEM', true),
              set_config('app.request_id', $1, true)`,
      [`migration:${file.name}`],
    );
    await client.query(file.sql);
    await client.query('INSERT INTO schema_migration (name, checksum) VALUES ($1, $2)', [
      file.name,
      file.checksum,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw new Error(`Migration ${file.name} failed: ${(error as Error).message}`, { cause: error });
  }
}
