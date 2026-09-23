import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { LOG_DIR, ROOT, STATE_FILE } from './paths.js';
import type { StackState } from './state.js';
import { serveStatic } from './static-server.js';

/**
 * Starts the real system for the browser tests: a fresh PostgreSQL database (migrated, with
 * the least-privilege runtime login), the API and background worker as built for
 * production (local providers: console OTP, sandbox gateway), the admin panel, and the
 * web builds of the customer and worker apps (built against this API; set
 * E2E_SKIP_APP_BUILD=1 to reuse existing builds while iterating on tests).
 */

const API_PORT = Number(process.env['E2E_API_PORT'] ?? 3100);
const ADMIN_PORT = Number(process.env['E2E_ADMIN_PORT'] ?? 3101);
const CUSTOMER_PORT = ADMIN_PORT + 1;
const WORKER_PORT = ADMIN_PORT + 2;
const OWNER_URL =
  process.env['E2E_OWNER_URL'] ?? 'postgres://onetappe:onetappe@localhost:5432/onetappe_e2e';
const RUNTIME_USER = 'onetappe_api_e2e';
const RUNTIME_PASSWORD = randomBytes(18).toString('base64url');

const secret = () => randomBytes(32).toString('base64url');

async function resetDatabase(): Promise<string> {
  const owner = new URL(OWNER_URL);
  const name = owner.pathname.slice(1);
  if (!/e2e/i.test(name)) throw new Error(`Refusing to reset ${name}: name must contain "e2e"`);
  const admin = new pg.Client({
    connectionString: Object.assign(new URL(OWNER_URL), { pathname: '/postgres' }).toString(),
  });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  execFileSync('node', [path.join(ROOT, 'apps/api/dist/database/migrate.cli.js')], {
    env: { ...process.env, DATABASE_URL: OWNER_URL },
    stdio: 'inherit',
  });
  const db = new pg.Client({ connectionString: OWNER_URL });
  await db.connect();
  try {
    await db.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RUNTIME_USER}') THEN
        ALTER ROLE ${RUNTIME_USER} LOGIN PASSWORD '${RUNTIME_PASSWORD}';
      ELSE
        CREATE ROLE ${RUNTIME_USER} LOGIN PASSWORD '${RUNTIME_PASSWORD}' IN ROLE onetappe_app;
      END IF;
    END $$`);
  } finally {
    await db.end();
  }
  const runtime = new URL(OWNER_URL);
  runtime.username = RUNTIME_USER;
  runtime.password = RUNTIME_PASSWORD;
  return runtime.toString();
}

function seed(): StackState['world'] {
  const out = execFileSync(
    process.execPath,
    ['--import', 'tsx', path.join(ROOT, 'apps/api/test/support/e2e-seed.ts')],
    { cwd: path.join(ROOT, 'apps/api'), env: { ...process.env, E2E_OWNER_URL: OWNER_URL } },
  );
  return JSON.parse(out.toString().trim().split('\n').pop() ?? '{}') as StackState['world'];
}

function bootstrapSuperAdmin(runtimeUrl: string) {
  const email = `director.${Date.now()}@onetappe.test`;
  const out = execFileSync(
    'node',
    [
      path.join(ROOT, 'apps/api/dist/staff-bootstrap.cli.js'),
      '--email',
      email,
      '--name',
      'E2E Director',
    ],
    { env: { ...process.env, DATABASE_URL: runtimeUrl } },
  ).toString();
  const token = out.split('\n')[2]?.trim() ?? '';
  if (!/^[A-Za-z0-9_-]{40,}$/.test(token)) throw new Error(`No invitation token in: ${out}`);
  return { email, invitationToken: token };
}

function buildApp(app: 'customer' | 'worker', apiUrl: string) {
  if (process.env['E2E_SKIP_APP_BUILD'] === '1') return;
  execFileSync('pnpm', ['--filter', `@onetappe/${app}`, 'run', 'build:web'], {
    cwd: ROOT,
    env: { ...process.env, ONETAPPE_API_URL: apiUrl },
    stdio: 'inherit',
  });
}

function start(name: string, command: string, args: string[], env: NodeJS.ProcessEnv, cwd = ROOT) {
  mkdirSync(LOG_DIR, { recursive: true });
  const logFile = path.join(LOG_DIR, `${name}.log`);
  const log = createWriteStream(logFile);
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  return { child, logFile };
}

async function waitFor(url: string, name: string, child: ChildProcess, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`${name} exited with ${String(child.exitCode)}; see e2e/.state/logs`);
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${name} did not become healthy at ${url}`);
}

export default async function globalSetup() {
  const runtimeUrl = await resetDatabase();
  const world = seed();
  const superAdmin = bootstrapSuperAdmin(runtimeUrl);
  const bffSecret = secret();
  const apiUrl = `http://127.0.0.1:${API_PORT}/api/v1`;
  const customerUrl = `http://127.0.0.1:${String(CUSTOMER_PORT)}`;
  const workerUrl = `http://127.0.0.1:${String(WORKER_PORT)}`;
  buildApp('customer', apiUrl);
  buildApp('worker', apiUrl);
  const apiEnv = {
    APP_ENV: 'local',
    NODE_ENV: 'production',
    PORT: String(API_PORT),
    DATABASE_URL: runtimeUrl,
    AUTH_TOKEN_SECRET: secret(),
    OTP_HASH_SECRET: secret(),
    VERIFICATION_CODE_SECRET: secret(),
    DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    OTP_PROVIDER: 'console',
    PAYMENT_PROVIDER: 'sandbox',
    SANDBOX_WEBHOOK_SECRET: secret(),
    BFF_SHARED_SECRET: bffSecret,
    STORAGE_PROVIDER: 'local',
    STORAGE_DIR: path.join(LOG_DIR, '..', 'storage'),
    MALWARE_SCANNER: 'none',
    PUSH_PROVIDER: 'log',
    SMS_PROVIDER: 'log',
    WHATSAPP_PROVIDER: 'log',
    EMAIL_PROVIDER: 'log',
    CORS_ORIGINS: `${customerUrl},${workerUrl}`,
    // The load test simulates many phones on different networks through one proxy hop.
    TRUSTED_PROXY_HOPS: process.env['E2E_TRUSTED_PROXY_HOPS'] ?? '0',
    LOG_LEVEL: 'info',
    WORKER_METRICS_PORT: String(API_PORT + 50),
  };
  const api = start('api', 'node', [path.join(ROOT, 'apps/api/dist/main.js')], apiEnv);
  const worker = start('worker', 'node', [path.join(ROOT, 'apps/api/dist/worker.js')], apiEnv);
  const admin = start(
    'admin',
    'node',
    [
      path.join(ROOT, 'apps/admin/node_modules/next/dist/bin/next'),
      'start',
      '--port',
      String(ADMIN_PORT),
    ],
    {
      NODE_ENV: 'production',
      ADMIN_API_URL: apiUrl,
      ADMIN_SESSION_SECRET: randomBytes(32).toString('base64'),
      BFF_SHARED_SECRET: bffSecret,
      ADMIN_TRUSTED_PROXY_HOPS: '0',
    },
    path.join(ROOT, 'apps/admin'),
  );
  await waitFor(`${apiUrl}/health/ready`, 'API', api.child);
  await waitFor(`http://127.0.0.1:${API_PORT + 50}/health/live`, 'worker', worker.child);
  await waitFor(`http://127.0.0.1:${ADMIN_PORT}/health`, 'admin', admin.child);
  const apps = await Promise.all([
    serveStatic(path.join(ROOT, 'apps/customer/dist-web'), CUSTOMER_PORT),
    serveStatic(path.join(ROOT, 'apps/worker/dist-web'), WORKER_PORT),
  ]);

  const state: StackState = {
    apiUrl,
    adminUrl: `http://127.0.0.1:${ADMIN_PORT}`,
    customerUrl,
    workerUrl,
    apiLog: api.logFile,
    superAdmin,
    world,
  };
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  return () => {
    for (const server of apps) server.close();
    for (const p of [admin.child, worker.child, api.child]) p.kill('SIGTERM');
  };
}
