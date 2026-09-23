import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../src/common/errors.js';
import { inTransaction } from '../src/database/transaction.js';
import {
  createTestApp,
  createWorld,
  customerContext,
  SYSTEM,
  type TestApp,
} from './support/world.js';

let app: TestApp;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

type Outcome = { ok: true; id: string } | { ok: false; code: string };

async function settle(promises: Array<Promise<{ id: string }>>): Promise<Outcome[]> {
  const results = await Promise.allSettled(promises);
  return results.map((r) => {
    if (r.status === 'fulfilled') return { ok: true, id: r.value.id };
    if (r.reason instanceof AppError) return { ok: false, code: r.reason.code };
    throw r.reason;
  });
}

/** No worker may ever hold two overlapping active reservations. */
async function overlappingReservations(): Promise<number> {
  const { rows } = await sql<{ n: number }>`
    SELECT count(*)::int AS n
    FROM worker_reservation a
    JOIN worker_reservation b
      ON a.worker_id = b.worker_id AND a.id < b.id AND a.period && b.period
    WHERE a.status IN ('HELD', 'ALLOCATED', 'ACCEPTED')
      AND b.status IN ('HELD', 'ALLOCATED', 'ACCEPTED')
  `.execute(app.db);
  return rows[0]?.n ?? -1;
}

describe('double-booking protection', () => {
  it('ten customers racing for one worker at the same time: exactly one succeeds', async () => {
    const world = await createWorld(app.db, { workers: 1 });
    const customers = await Promise.all(Array.from({ length: 10 }, () => world.customer()));

    const outcomes = await settle(
      customers.map((c) =>
        app.creation.create(world.bookingInput(c, world.at(10)), customerContext(c.userId)),
      ),
    );

    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok).map((o) => (o as { code: string }).code)).toEqual(
      Array(9).fill('NO_AVAILABILITY'),
    );
    // Failed attempts leave nothing behind: no orphan bookings.
    const bookings = await app.db
      .selectFrom('booking')
      .select('id')
      .where('service_id', '=', world.serviceId)
      .execute();
    expect(bookings).toHaveLength(1);
    expect(await overlappingReservations()).toBe(0);
  });

  it('overlapping but different start times also conflict (travel and reset included)', async () => {
    const world = await createWorld(app.db, { workers: 1 });
    const [a, b, c] = await Promise.all([world.customer(), world.customer(), world.customer()]);

    // 10:00 blocks 09:40–11:10. 10:30 overlaps; 11:15 (blocks 10:55–12:25) overlaps the reset
    // buffer; 11:30 (blocks 11:10–12:40) touches but does not overlap.
    const outcomes = await settle([
      app.creation.create(world.bookingInput(a, world.at(10)), customerContext(a.userId)),
      app.creation.create(world.bookingInput(b, world.at(10, 30)), customerContext(b.userId)),
      app.creation.create(world.bookingInput(c, world.at(11, 15)), customerContext(c.userId)),
    ]);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);

    const d = await world.customer();
    const [winner] = outcomes.filter((o) => o.ok);
    const winnerStart = await app.db
      .selectFrom('booking')
      .select('scheduled_start')
      .where('id', '=', (winner as { id: string }).id)
      .executeTakeFirstOrThrow();
    // Whichever request won, the next non-overlapping block is still bookable.
    const next = new Date(winnerStart.scheduled_start.getTime() + 90 * 60_000);
    const later = await app.creation.create(world.bookingInput(d, next), customerContext(d.userId));
    expect(later.status).toBe('PENDING_PAYMENT');
    expect(await overlappingReservations()).toBe(0);
  });

  it('with three workers, ten simultaneous customers get exactly three bookings', async () => {
    const world = await createWorld(app.db, { workers: 3 });
    const customers = await Promise.all(Array.from({ length: 10 }, () => world.customer()));

    const outcomes = await settle(
      customers.map((c) =>
        app.creation.create(world.bookingInput(c, world.at(16)), customerContext(c.userId)),
      ),
    );
    expect(outcomes.filter((o) => o.ok)).toHaveLength(3);

    const workers = await app.db
      .selectFrom('worker_reservation as r')
      .innerJoin('booking as b', 'b.id', 'r.booking_id')
      .select('r.worker_id')
      .where('b.service_id', '=', world.serviceId)
      .where('r.status', '=', 'HELD')
      .execute();
    expect(new Set(workers.map((w) => w.worker_id)).size).toBe(3);
    expect(await overlappingReservations()).toBe(0);
  });

  it('the database itself rejects a conflicting reservation, even bypassing the application', async () => {
    const world = await createWorld(app.db, { workers: 1 });
    const [a, b] = await Promise.all([world.customer(), world.customer()]);
    const first = await app.creation.create(
      world.bookingInput(a, world.at(10)),
      customerContext(a.userId),
    );
    const second = await app.creation.create(
      world.bookingInput(b, world.at(13)),
      customerContext(b.userId),
    );
    const [workerId] = world.workerIds as [string];

    // Try to put the 13:00 booking on the same worker at 10:00 with raw SQL.
    await expect(
      inTransaction(app.db, SYSTEM, (tx) =>
        sql`
          INSERT INTO worker_reservation (booking_id, worker_id, period, status, hold_expires_at)
          SELECT ${second.id}::uuid, ${workerId}::uuid, period, 'HELD', now() + interval '5 minutes'
          FROM worker_reservation WHERE booking_id = ${first.id}::uuid
        `.execute(tx),
      ),
    ).rejects.toMatchObject({ code: 'RESERVATION_NOT_ALLOWED' });
  });

  it('two raw connections inserting overlapping reservations at once: exactly one wins', async () => {
    const world = await createWorld(app.db, { workers: 1 });
    const [a, b] = await Promise.all([world.customer(), world.customer()]);
    const first = await app.creation.create(
      world.bookingInput(a, world.at(18)),
      customerContext(a.userId),
    );
    const second = await app.creation.create(
      world.bookingInput(b, world.at(15)),
      customerContext(b.userId),
    );
    const [workerId] = world.workerIds as [string];

    // Release both holds so the two raw inserts race for the same free period.
    await inTransaction(app.db, SYSTEM, (tx) =>
      tx
        .updateTable('worker_reservation')
        .set({ status: 'RELEASED', released_at: new Date(), release_reason: 'TEST' })
        .where('booking_id', 'in', [first.id, second.id])
        .execute(),
    );
    // Both bookings need a promise inside the racing period for the trigger to accept them.
    await inTransaction(app.db, customerContext(b.userId), async (tx) => {
      await sql`SELECT set_config('app.reason', 'test move', true)`.execute(tx);
      await tx
        .updateTable('booking')
        .set({ scheduled_start: world.at(18), scheduled_end: world.at(19) })
        .where('id', '=', second.id)
        .execute();
    });

    const url = process.env['DATABASE_URL']!;
    const clients = [new pg.Client(url), new pg.Client(url)];
    await Promise.all(clients.map((c) => c.connect()));
    try {
      const race = await Promise.allSettled(
        clients.map(async (client, i) => {
          await client.query('BEGIN');
          await client.query(`SELECT set_config('app.source', 'SYSTEM', true)`);
          await client.query(
            `INSERT INTO worker_reservation (booking_id, worker_id, period, status, hold_expires_at)
             VALUES ($1, $2, tstzrange($3, $4, '[)'), 'HELD', now() + interval '5 minutes')`,
            [i === 0 ? first.id : second.id, workerId, world.at(17, 40), world.at(19, 10)],
          );
          await client.query('COMMIT');
        }),
      );
      const failures = race.filter((r) => r.status === 'rejected');
      expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(failures).toHaveLength(1);
      // PostgreSQL reports the loser as an exclusion violation, or (when both inserts are
      // checking each other's uncommitted row) aborts it as a deadlock. Either way nothing
      // overlapping is committed; the application retries deadlocks (see inTransaction).
      const reason = (failures[0] as PromiseRejectedResult).reason as {
        code: string;
        constraint?: string;
      };
      expect(['23P01', '40P01']).toContain(reason.code);
      if (reason.code === '23P01') expect(reason.constraint).toBe('worker_reservation_no_overlap');
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
    expect(await overlappingReservations()).toBe(0);
  });

  it('an expired payment hold never blocks the next customer', async () => {
    const world = await createWorld(app.db, { workers: 1 });
    const [a, b] = await Promise.all([world.customer(), world.customer()]);
    const abandoned = await app.creation.create(
      world.bookingInput(a, world.at(10)),
      customerContext(a.userId),
    );

    await inTransaction(app.db, SYSTEM, (tx) =>
      sql`UPDATE worker_reservation SET hold_expires_at = now() - interval '1 second'
          WHERE booking_id = ${abandoned.id}::uuid`.execute(tx),
    );

    // The sweeper has not run yet; the new booking still succeeds.
    const next = await app.creation.create(
      { ...world.bookingInput(b, world.at(10)), idempotencyKey: randomUUID() },
      customerContext(b.userId),
    );
    expect(next.status).toBe('PENDING_PAYMENT');
    const old = await app.db
      .selectFrom('worker_reservation')
      .select(['status', 'release_reason'])
      .where('booking_id', '=', abandoned.id)
      .executeTakeFirstOrThrow();
    expect(old).toEqual({ status: 'RELEASED', release_reason: 'HOLD_EXPIRED' });
  });
});

describe('transaction retry', () => {
  it('a transaction aborted by a deadlock is retried and both sides complete', async () => {
    const [lockA, lockB] = [Math.floor(Math.random() * 1e9), Math.floor(Math.random() * 1e9) + 1];
    const runs = { first: 0, second: 0 };
    let arrived = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => (releaseBarrier = resolve));

    // Each transaction takes one lock, waits until the other holds its lock, then asks for
    // the other's: a guaranteed deadlock on the first attempt, none on the retry.
    const contender = (name: keyof typeof runs, mine: number, theirs: number) =>
      inTransaction(app.db, SYSTEM, async (tx) => {
        runs[name] += 1;
        await sql`SELECT pg_advisory_xact_lock(${mine})`.execute(tx);
        if (runs[name] === 1) {
          arrived += 1;
          if (arrived === 2) releaseBarrier();
          await barrier;
        }
        await sql`SELECT pg_advisory_xact_lock(${theirs})`.execute(tx);
        return name;
      });

    const results = await Promise.all([
      contender('first', lockA, lockB),
      contender('second', lockB, lockA),
    ]);
    expect(results).toEqual(['first', 'second']);
    // Exactly one side was chosen as the deadlock victim and ran again.
    expect(runs.first + runs.second).toBe(3);
  });
});
