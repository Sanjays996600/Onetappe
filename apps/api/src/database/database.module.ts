import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import type { DB } from './db.generated.js';
import { registerPgTypeParsers } from './pg-types.js';

export const DATABASE = Symbol('DATABASE');

export interface DatabaseLimits {
  readonly poolMax: number;
  /** Longest a request waits for a free connection before failing (not hanging). */
  readonly connectionTimeoutMs: number;
  /** Longest any one statement may run. */
  readonly statementTimeoutMs: number;
  /** A transaction left idle this long (e.g. a stuck request) is ended by the server. */
  readonly idleInTransactionTimeoutMs: number;
}

export const DEFAULT_DATABASE_LIMITS: DatabaseLimits = {
  poolMax: 10,
  connectionTimeoutMs: 5_000,
  statementTimeoutMs: 15_000,
  idleInTransactionTimeoutMs: 30_000,
};

const logger = new Logger('Database');

export function createDatabase(
  connectionString: string,
  limits: DatabaseLimits = DEFAULT_DATABASE_LIMITS,
): Kysely<DB> {
  registerPgTypeParsers();
  const pool = new pg.Pool({
    connectionString,
    max: limits.poolMax,
    connectionTimeoutMillis: limits.connectionTimeoutMs,
    // Every session runs in UTC; conversion to local time happens at the edges.
    options: [
      '-c TimeZone=UTC',
      `-c statement_timeout=${String(limits.statementTimeoutMs)}`,
      `-c idle_in_transaction_session_timeout=${String(limits.idleInTransactionTimeoutMs)}`,
    ].join(' '),
  });
  // An idle connection can be dropped by the server (restart, failover, network). Without a
  // listener node-postgres would raise it as an unhandled error and stop the process; the
  // pool discards the broken connection and opens a new one on the next request instead.
  pool.on('error', (error) => {
    logger.error(`Idle database connection failed: ${error.message}`);
  });
  // A connection can also break while checked out (e.g. between statements of a
  // transaction). node-postgres then emits 'error' on the client itself; the query in
  // flight (or the next one) fails and is handled normally, so here we only log.
  pool.on('connect', (client) => {
    client.on('error', (error) => {
      logger.error(`Database connection lost: ${error.message}`);
    });
  });
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      inject: [ENV],
      useFactory: (env: Env) =>
        createDatabase(env.DATABASE_URL, {
          poolMax: env.DATABASE_POOL_MAX,
          connectionTimeoutMs: env.DATABASE_CONNECTION_TIMEOUT_MS,
          statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
          idleInTransactionTimeoutMs: DEFAULT_DATABASE_LIMITS.idleInTransactionTimeoutMs,
        }),
    },
  ],
  exports: [DATABASE],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}
