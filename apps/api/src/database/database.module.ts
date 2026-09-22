import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import type { DB } from './db.generated.js';
import { registerPgTypeParsers } from './pg-types.js';

export const DATABASE = Symbol('DATABASE');

export function createDatabase(connectionString: string, poolMax = 10): Kysely<DB> {
  registerPgTypeParsers();
  const pool = new pg.Pool({
    connectionString,
    max: poolMax,
    // Every session runs in UTC; conversion to local time happens at the edges.
    options: '-c TimeZone=UTC',
  });
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      inject: [ENV],
      useFactory: (env: Env) => createDatabase(env.DATABASE_URL, env.DATABASE_POOL_MAX),
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
