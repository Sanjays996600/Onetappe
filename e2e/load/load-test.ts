/**
 * Load test of the real system: the production builds of the API and background worker on
 * a fresh PostgreSQL database (the browser-test stack, with 20 seeded workers), driven
 * over HTTP by simulated phones, each on its own network address.
 *
 *   pnpm build && E2E_WORKERS=20 E2E_TRUSTED_PROXY_HOPS=1 E2E_SKIP_APP_BUILD=1 \
 *     pnpm --filter @onetappe/e2e exec tsx load/load-test.ts
 *
 * Phases: sign-up of N customers; sustained reads (catalogue, profile, bookings,
 * availability); a burst of N customers booking the same slot (capacity = workers);
 * paying every winner with duplicated gateway webhooks; background processing. Prints a
 * JSON report. Never point it at a shared or production environment.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import setup from '../harness/global-setup.js';
import { otpFor } from '../harness/otp.js';
import { stack } from '../harness/state.js';

const CUSTOMERS = Number(process.env['LOAD_CUSTOMERS'] ?? 100);
const READS_PER_CUSTOMER = Number(process.env['LOAD_READS'] ?? 40);

type Json = Record<string, unknown>;
interface Sample {
  readonly phase: string;
  readonly ms: number;
  readonly status: number;
}
const samples: Sample[] = [];

async function call(
  phase: string,
  ip: string,
  method: string,
  path: string,
  options: { token?: string; body?: unknown; key?: string } = {},
): Promise<{ status: number; body: Json }> {
  const s = stack();
  const started = performance.now();
  const res = await fetch(`${s.apiUrl}${path}`, {
    method,
    headers: {
      'x-forwarded-for': ip,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.key ? { 'idempotency-key': options.key } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body = (await res.json().catch(() => ({}))) as Json;
  samples.push({ phase, ms: performance.now() - started, status: res.status });
  return { status: res.status, body };
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(
    sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0,
  );
}

function summary(phase: string, seconds: number) {
  const rows = samples.filter((x) => x.phase === phase);
  const statuses: Record<string, number> = {};
  for (const r of rows) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
  return {
    phase,
    requests: rows.length,
    perSecond: Math.round(rows.length / seconds),
    p50ms: percentile(
      rows.map((r) => r.ms),
      50,
    ),
    p95ms: percentile(
      rows.map((r) => r.ms),
      95,
    ),
    p99ms: percentile(
      rows.map((r) => r.ms),
      99,
    ),
    maxMs: percentile(
      rows.map((r) => r.ms),
      100,
    ),
    statuses,
  };
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t = performance.now();
  const value = await fn();
  return [value, (performance.now() - t) / 1000];
}

interface Customer {
  ip: string;
  token: string;
  addressId: string;
}

async function signUp(i: number): Promise<Customer> {
  const s = stack();
  const ip = `10.${String(Math.floor(i / 250))}.${String(i % 250)}.7`;
  const phone = `+9170${String(10_000_000 + i).padStart(8, '0')}`;
  const since = Date.now();
  const challenge = await call('signup', ip, 'POST', '/customer/auth/otp', { body: { phone } });
  const code = await otpFor(s.apiLog, phone, since, 30_000);
  const session = await call('signup', ip, 'POST', '/customer/auth/verify', {
    body: { challengeId: challenge.body['challengeId'], phone, code },
  });
  const token = session.body['accessToken'] as string;
  const consents = await call('signup', ip, 'GET', '/me/consents', { token });
  await call('signup', ip, 'POST', '/me/consents/accept', {
    token,
    body: { documentIds: (consents.body['required'] as Json[]).map((d) => d['id']) },
  });
  await call('signup', ip, 'PATCH', '/customer/me', {
    token,
    body: { fullName: `Load ${String(i)}` },
  });
  const address = await call('signup', ip, 'POST', '/customer/addresses', {
    token,
    key: randomUUID(),
    body: {
      contactName: `Load ${String(i)}`,
      contactPhone: phone,
      houseNumber: String(i),
      pincode: s.world.pincode,
      cityName: 'Noida',
      lat: s.world.center.lat,
      lng: s.world.center.lng,
    },
  });
  return { ip, token, addressId: address.body['id'] as string };
}

async function main() {
  const teardown = await setup();
  const s = stack();
  const db = new pg.Pool({
    connectionString:
      process.env['E2E_OWNER_URL'] ?? 'postgres://onetappe:onetappe@localhost:5432/onetappe_e2e',
  });
  const report: Json = { customers: CUSTOMERS, workers: s.world.workers.length };
  try {
    // 1. Sign-up, ten at a time (OTP codes are read from the log).
    const customers: Customer[] = [];
    const [, signupSeconds] = await timed(async () => {
      for (let i = 0; i < CUSTOMERS; i += 10) {
        customers.push(
          ...(await Promise.all(
            Array.from({ length: Math.min(10, CUSTOMERS - i) }, (_, j) => signUp(i + j)),
          )),
        );
      }
    });
    report['signup'] = summary('signup', signupSeconds);

    // 2. Sustained reads: every customer browsing at once.
    const [, readSeconds] = await timed(() =>
      Promise.all(
        customers.map(async (c) => {
          for (let r = 0; r < READS_PER_CUSTOMER; r++) {
            const q = `pincode=${s.world.pincode}&lat=${String(s.world.center.lat)}&lng=${String(s.world.center.lng)}`;
            const path = [
              `/customer/catalog?${q}`,
              '/customer/me',
              '/customer/bookings',
              `/customer/availability?serviceId=${s.world.service.id}&addressId=${c.addressId}&date=${s.world.day}`,
            ][r % 4] as string;
            await call(`read ${path.split('?')[0] ?? ''}`, c.ip, 'GET', path, { token: c.token });
          }
        }),
      ),
    );
    const readPhases = [
      ...new Set(samples.map((x) => x.phase).filter((p) => p.startsWith('read '))),
    ];
    report['reads'] = readPhases.map((p) => summary(p, readSeconds));
    const connections = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()',
    );
    report['dbConnectionsAfterReads'] = connections.rows[0]?.n;

    // 3. Contention: every customer books the same slot at the same moment.
    const startAt = new Date(`${s.world.day}T11:00:00+05:30`).toISOString();
    const [bookings, bookSeconds] = await timed(() =>
      Promise.all(
        customers.map(async (c) => {
          const quote = await call('book', c.ip, 'POST', '/customer/quotes', {
            token: c.token,
            body: {
              serviceId: s.world.service.id,
              addressId: c.addressId,
              bookingType: 'SCHEDULED',
              startAt,
            },
          });
          const res = await call('book', c.ip, 'POST', '/customer/bookings', {
            token: c.token,
            key: randomUUID(),
            body: {
              serviceId: s.world.service.id,
              addressId: c.addressId,
              bookingType: 'SCHEDULED',
              startAt,
              expectedTotalPaise: quote.body['totalPaise'],
            },
          });
          return { c, res };
        }),
      ),
    );
    const won = bookings.filter((b) => b.res.status === 201);
    const lostCodes: Record<string, number> = {};
    for (const b of bookings.filter((x) => x.res.status !== 201)) {
      const code =
        ((b.res.body['error'] as Json | undefined)?.['code'] as string | undefined) ??
        String(b.res.status);
      lostCodes[code] = (lostCodes[code] ?? 0) + 1;
    }
    report['contention'] = {
      ...summary('book', bookSeconds),
      bookingsCreated: won.length,
      refusedWith: lostCodes,
    };

    // 4. Every winner pays; each capture webhook is delivered twice.
    const [, paySeconds] = await timed(() =>
      Promise.all(
        won.map(async ({ c, res }) => {
          const id = res.body['id'] as string;
          const pay = await call('pay', c.ip, 'POST', `/customer/bookings/${id}/payments`, {
            token: c.token,
          });
          const orderId = (pay.body['checkout'] as Json)['orderId'] as string;
          await Promise.all([
            call('pay', c.ip, 'POST', `/sandbox/payments/${orderId}`, {
              body: { outcome: 'capture' },
            }),
            call('pay', c.ip, 'POST', `/sandbox/payments/${orderId}`, {
              body: { outcome: 'capture' },
            }),
          ]);
        }),
      ),
    );
    report['payments'] = summary('pay', paySeconds);

    // 5. Let the background worker dispatch offers and notifications, then check the books.
    await new Promise((r) => setTimeout(r, 20_000));
    const facts = await db.query<Json>(`
      SELECT
        (SELECT count(*)::int FROM booking WHERE status = 'CONFIRMED') AS confirmed,
        (SELECT count(*)::int FROM payment WHERE status = 'CAPTURED') AS captured_payments,
        (SELECT count(*)::int FROM (SELECT booking_id FROM payment WHERE status = 'CAPTURED'
            GROUP BY booking_id HAVING count(*) > 1) d) AS bookings_with_two_captures,
        (SELECT count(*)::int FROM payment_event) AS webhook_events_stored,
        (SELECT count(*)::int FROM booking_assignment WHERE status = 'OFFERED') AS open_offers,
        (SELECT count(*)::int FROM worker_reservation a JOIN worker_reservation b
            ON a.worker_id = b.worker_id AND a.id < b.id AND a.period && b.period
          WHERE a.status IN ('HELD','ALLOCATED','ACCEPTED') AND b.status IN ('HELD','ALLOCATED','ACCEPTED')) AS overlapping_reservations,
        (SELECT count(*)::int FROM notification WHERE status IN ('QUEUED','FAILED')) AS notifications_waiting,
        (SELECT count(*)::int FROM job_run WHERE status = 'FAILED') AS failed_job_runs
    `);
    report['afterProcessing'] = facts.rows[0];
    report['serverErrors'] = samples.filter((x) => x.status >= 500).length;
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await db.end();
    teardown();
  }
}

void main();
