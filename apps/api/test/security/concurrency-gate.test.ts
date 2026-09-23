import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../src/common/errors.js';
import { createTestApp, createWorld, customerContext, type TestApp } from '../support/world.js';

/**
 * Engineering-gate concurrency: where one unit of capacity exists, exactly one reservation
 * wins however many requests arrive at once — for new bookings and for reschedules — and
 * every loser gets the business answer, never a crash. PostgreSQL's exclusion constraint
 * is the final authority; these tests go through the application services.
 */

let app: TestApp;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

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

function outcomes(results: PromiseSettledResult<unknown>[]) {
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const codes = results.flatMap((r) =>
    r.status === 'rejected' ? [r.reason instanceof AppError ? r.reason.code : 'CRASH'] : [],
  );
  return { ok, codes: [...new Set(codes)] };
}

describe('one worker, one slot, many customers at once', () => {
  it.each([2, 10, 50, 100])('%i simultaneous bookings: exactly one wins', async (n) => {
    const world = await createWorld(app.db, { workers: 1 });
    const customers = await Promise.all(Array.from({ length: n }, () => world.customer()));
    const results = await Promise.allSettled(
      customers.map((c) =>
        app.creation.create(world.bookingInput(c, world.at(10)), customerContext(c.userId)),
      ),
    );
    const result = outcomes(results);
    expect(result.ok).toBe(1);
    if (n > 1) expect(result.codes).toEqual(['NO_AVAILABILITY']);
    expect(await overlappingReservations()).toBe(0);
  });

  it('partially overlapping start times (inside the travel and reset buffer) conflict', async () => {
    const world = await createWorld(app.db, { workers: 1 });
    const customers = await Promise.all(Array.from({ length: 6 }, () => world.customer()));
    // 10:00, 10:15, … 11:15 — each overlaps the 60-minute visit plus its buffer.
    const results = await Promise.allSettled(
      customers.map((c, i) =>
        app.creation.create(world.bookingInput(c, world.at(10, i * 15)), customerContext(c.userId)),
      ),
    );
    expect(outcomes(results).ok).toBe(1);
    expect(await overlappingReservations()).toBe(0);
  });
});

describe('reschedule races', () => {
  it('two bookings rescheduled into the same free slot at once: exactly one moves', async () => {
    const world = await createWorld(app.db, { workers: 1 });
    const [a, b] = await Promise.all([world.customer(), world.customer()]);
    const first = await app.creation.create(
      world.bookingInput(a, world.at(9)),
      customerContext(a.userId),
    );
    const second = await app.creation.create(
      world.bookingInput(b, world.at(15)),
      customerContext(b.userId),
    );
    const results = await Promise.allSettled([
      app.lifecycle.reschedule(
        first.id,
        world.at(12),
        'Earlier suits me',
        customerContext(a.userId),
      ),
      app.lifecycle.reschedule(
        second.id,
        world.at(12),
        'Earlier suits me',
        customerContext(b.userId),
      ),
    ]);
    const result = outcomes(results);
    expect(result.ok).toBe(1);
    expect(result.codes).toEqual(['NO_AVAILABILITY']);
    expect(await overlappingReservations()).toBe(0);
    // The loser keeps its original time and its reservation.
    const loser = results[0].status === 'rejected' ? first.id : second.id;
    const kept = await app.db
      .selectFrom('booking')
      .select(['scheduled_start'])
      .where('id', '=', loser)
      .executeTakeFirstOrThrow();
    expect([world.at(9).getTime(), world.at(15).getTime()]).toContain(
      kept.scheduled_start.getTime(),
    );
  });

  it('a reschedule and a new booking racing for the same slot: exactly one gets it', async () => {
    const world = await createWorld(app.db, { workers: 1 });
    const [a, b] = await Promise.all([world.customer(), world.customer()]);
    const existing = await app.creation.create(
      world.bookingInput(a, world.at(9)),
      customerContext(a.userId),
    );
    const results = await Promise.allSettled([
      app.lifecycle.reschedule(
        existing.id,
        world.at(14),
        'Afternoon is better',
        customerContext(a.userId),
      ),
      app.creation.create(world.bookingInput(b, world.at(14)), customerContext(b.userId)),
    ]);
    expect(outcomes(results).ok).toBe(1);
    expect(await overlappingReservations()).toBe(0);
  });

  it('twenty reschedules of different bookings into one slot: exactly one moves', async () => {
    const world = await createWorld(app.db, { workers: 20 });
    const customers = await Promise.all(Array.from({ length: 20 }, () => world.customer()));
    const bookings = await Promise.all(
      customers.map((c, i) =>
        app.creation.create(
          world.bookingInput(c, world.at(9 + (i % 2) * 7)),
          customerContext(c.userId),
        ),
      ),
    );
    // Now make 19 of the 20 workers unavailable at 12:00 by booking them first.
    const blockers = await Promise.all(Array.from({ length: 19 }, () => world.customer()));
    let blocked = 0;
    for (const c of blockers) {
      await app.creation
        .create(world.bookingInput(c, world.at(12)), customerContext(c.userId))
        .then(() => (blocked += 1))
        .catch(() => undefined);
    }
    expect(blocked).toBe(19);
    const results = await Promise.allSettled(
      bookings.map((b, i) =>
        app.lifecycle.reschedule(
          b.id,
          world.at(12),
          'Noon please',
          customerContext(customers[i]?.userId ?? ''),
        ),
      ),
    );
    const result = outcomes(results);
    expect(result.ok).toBe(1);
    expect(result.codes).toEqual(['NO_AVAILABILITY']);
    expect(await overlappingReservations()).toBe(0);
  });
});
