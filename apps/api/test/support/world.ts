import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { AppModule } from '../../src/app.module.js';
import { configureApp, createAdapter } from '../../src/bootstrap.js';
import { loadEnv } from '../../src/config/env.js';
import { BookingCreationService } from '../../src/booking/booking-creation.service.js';
import { BookingLifecycleService } from '../../src/booking/booking-lifecycle.service.js';
import { DispatchService } from '../../src/booking/dispatch.service.js';
import { VerificationCodeService } from '../../src/booking/verification-code.service.js';
import { DATABASE } from '../../src/database/database.module.js';
import type { DB } from '../../src/database/db.generated.js';

export interface TestApp {
  readonly http: NestFastifyApplication;
  /** The application's own connection: the least-privilege runtime role (onetappe_app). */
  readonly db: Kysely<DB>;
  /**
   * The schema owner, for fixtures the application itself can never do (e.g. switching a
   * guard trigger off to move a timestamp into the past).
   */
  readonly owner: Kysely<DB>;
  readonly creation: BookingCreationService;
  readonly lifecycle: BookingLifecycleService;
  readonly dispatch: DispatchService;
  readonly codes: VerificationCodeService;
  close(): Promise<void>;
}

/**
 * Boots the whole application for HTTP tests. `envOverrides` replace environment values
 * for this instance only (e.g. a database URL routed through a fault-injecting proxy).
 */
export async function createTestApp(
  envOverrides: Readonly<Record<string, string>> = {},
): Promise<TestApp> {
  const saved = Object.fromEntries(Object.keys(envOverrides).map((k) => [k, process.env[k]]));
  Object.assign(process.env, envOverrides);
  let app: NestFastifyApplication;
  try {
    const env = loadEnv();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter(env), {
      rawBody: true,
    });
    configureApp(app, env);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
  return {
    http: app,
    db: app.get<Kysely<DB>>(DATABASE),
    creation: app.get(BookingCreationService),
    lifecycle: app.get(BookingLifecycleService),
    dispatch: app.get(DispatchService),
    codes: app.get(VerificationCodeService),
    owner: ownerDb(),
    close: () => app.close(),
  };
}

export * from './fixtures.js';

let sharedOwner: Kysely<DB> | undefined;

/** One small owner pool per test file; idle connections close so the file can exit. */
function ownerDb(): Kysely<DB> {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) throw new Error('TEST_DATABASE_URL must be set');
  sharedOwner ??= new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: url, max: 2, allowExitOnIdle: true }),
    }),
  });
  return sharedOwner;
}
