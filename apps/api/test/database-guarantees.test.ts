import { randomUUID } from 'node:crypto';
import { BOOKING_TRANSITIONS } from '@onetappe/domain';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction, setEvent } from '../src/database/transaction.js';
import {
  adminContext,
  createTestApp,
  createWorld,
  customerContext,
  paymentContext,
  SYSTEM,
  type TestApp,
  type World,
} from './support/world.js';

let app: TestApp;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

async function newBooking(world: World, hour = 10) {
  const customer = await world.customer();
  const booking = await app.creation.create(
    world.bookingInput(customer, world.at(hour)),
    customerContext(customer.userId),
  );
  return { customer, booking };
}

describe('state machine parity', () => {
  it('the database transition table matches the domain state machine exactly', async () => {
    const rows = await app.db.selectFrom('booking_status_transition').selectAll().execute();
    const fromDb = rows
      .map(
        (r) =>
          `${r.from_status}|${r.event}|${r.to_status}|${[...r.sources].sort().join(',')}|${r.requires_reason}`,
      )
      .sort();
    const fromDomain = BOOKING_TRANSITIONS.map(
      (t) => `${t.from}|${t.event}|${t.to}|${[...t.sources].sort().join(',')}|${t.requiresReason}`,
    ).sort();
    expect(fromDb).toEqual(fromDomain);
  });
});

describe('booking protections (enforced even for raw SQL)', () => {
  it('rejects a status jump that is not an allowed transition', async () => {
    const world = await createWorld(app.db);
    const { booking } = await newBooking(world);
    await expect(
      inTransaction(app.db, adminContext(world.staffId), async (tx) => {
        await setEvent(tx, 'COMPLETE_SERVICE', null);
        await tx
          .updateTable('booking')
          .set({ status: 'COMPLETED' })
          .where('id', '=', booking.id)
          .execute();
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS_TRANSITION' });
  });

  it('rejects an allowed transition from a channel that may not trigger it', async () => {
    const world = await createWorld(app.db);
    const { customer, booking } = await newBooking(world);
    await expect(
      inTransaction(app.db, customerContext(customer.userId), async (tx) => {
        await setEvent(tx, 'PAYMENT_CAPTURED', null);
        await tx
          .updateTable('booking')
          .set({ status: 'CONFIRMED' })
          .where('id', '=', booking.id)
          .execute();
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS_TRANSITION' });
  });

  it('rejects writes to bookings without an action source', async () => {
    const world = await createWorld(app.db);
    const { booking } = await newBooking(world);
    await expect(
      sql`UPDATE booking SET customer_notes = 'x' WHERE id = ${booking.id}::uuid`.execute(app.db),
    ).rejects.toMatchObject({ code: 'OT004' });
  });

  it('never allows the original promised time to change', async () => {
    const world = await createWorld(app.db);
    const { booking } = await newBooking(world);
    await expect(
      inTransaction(app.db, adminContext(world.staffId), (tx) =>
        tx
          .updateTable('booking')
          .set({ original_start: world.at(12) })
          .where('id', '=', booking.id)
          .execute(),
      ),
    ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
  });

  it('never allows the agreed price to be edited', async () => {
    const world = await createWorld(app.db);
    const { booking } = await newBooking(world);
    await expect(
      inTransaction(app.db, adminContext(world.staffId), (tx) =>
        tx
          .updateTable('booking')
          .set({ subtotal_paise: 100, total_paise: 118, tax_paise: 18 })
          .where('id', '=', booking.id)
          .execute(),
      ),
    ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
  });

  it('refuses a reschedule without a reason', async () => {
    const world = await createWorld(app.db);
    const { booking } = await newBooking(world);
    await expect(
      inTransaction(app.db, adminContext(world.staffId), async (tx) => {
        await sql`UPDATE worker_reservation SET status = 'RELEASED', released_at = now() WHERE booking_id = ${booking.id}::uuid`.execute(
          tx,
        );
        await tx
          .updateTable('booking')
          .set({ scheduled_start: world.at(12), scheduled_end: world.at(13) })
          .where('id', '=', booking.id)
          .execute();
      }),
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATED' });
  });

  it('keeps status history, schedule history, price lines and the audit log append-only', async () => {
    const world = await createWorld(app.db);
    const { customer, booking } = await newBooking(world);
    // Produce a schedule change so every history table has rows for this booking.
    await app.lifecycle.reschedule(
      booking.id,
      world.at(12),
      'Later suits me',
      customerContext(customer.userId),
    );

    const tables = [
      { table: 'booking_status_history', column: 'reason', key: 'booking_id' },
      { table: 'booking_schedule_change', column: 'reason', key: 'booking_id' },
      { table: 'booking_price_line', column: 'label', key: 'booking_id' },
      { table: 'audit_log', column: 'reason', key: 'entity_id' },
    ] as const;
    for (const { table, column, key } of tables) {
      const match =
        key === 'entity_id'
          ? sql`${sql.ref(key)} = ${booking.id}`
          : sql`${sql.ref(key)} = ${booking.id}::uuid`;
      const { rows } = await sql<{
        n: number;
      }>`SELECT count(*)::int AS n FROM ${sql.table(table)} WHERE ${match}`.execute(app.db);
      expect(rows[0]!.n, `${table} has rows`).toBeGreaterThan(0);

      await expect(
        sql`UPDATE ${sql.table(table)} SET ${sql.ref(column)} = 'tampered' WHERE ${match}`.execute(
          app.db,
        ),
        `${table} update`,
      ).rejects.toMatchObject({ code: 'OT001' });
      await expect(
        sql`DELETE FROM ${sql.table(table)} WHERE ${match}`.execute(app.db),
        `${table} delete`,
      ).rejects.toMatchObject({
        code: 'OT001',
      });
      await expect(
        sql`TRUNCATE ${sql.table(table)} CASCADE`.execute(app.db),
        `${table} truncate`,
      ).rejects.toMatchObject({
        code: 'OT001',
      });
    }
    await expect(
      sql`DELETE FROM booking WHERE id = ${booking.id}::uuid`.execute(app.db),
    ).rejects.toMatchObject({ code: 'OT006' });
  });

  it('writes an audit record with who, when, source, what changed, before and after', async () => {
    const world = await createWorld(app.db);
    const { customer, booking } = await newBooking(world);
    const context = customerContext(customer.userId);
    await app.lifecycle.cancel(booking.id, 'Not needed any more', context);

    const entry = await app.db
      .selectFrom('audit_log')
      .selectAll()
      .where('entity_type', '=', 'booking')
      .where('entity_id', '=', booking.id)
      .where('action', '=', 'UPDATE')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(entry).toMatchObject({
      actor_user_id: customer.userId,
      actor_role: 'CUSTOMER',
      source: 'CUSTOMER_APP',
      request_id: context.requestId,
      reason: 'Not needed any more',
    });
    expect(entry.changed_fields).toEqual(
      expect.arrayContaining(['status', 'cancelled_at', 'cancellation_reason', 'payment_due_by']),
    );
    expect(entry.before).toMatchObject({ status: 'PENDING_PAYMENT' });
    expect(entry.after).toMatchObject({ status: 'CANCELLED' });
    expect(entry.occurred_at).toBeInstanceOf(Date);
  });
});

describe('worker eligibility is checked by the database', () => {
  async function tryReserve(
    world: World,
    bookingId: string,
    workerId: string,
    from = world.at(9, 40),
    to = world.at(11, 10),
  ) {
    return inTransaction(app.db, SYSTEM, async (tx) => {
      await sql`UPDATE worker_reservation SET status = 'RELEASED', released_at = now() WHERE booking_id = ${bookingId}::uuid`.execute(
        tx,
      );
      await sql`
        INSERT INTO worker_reservation (booking_id, worker_id, period, status, hold_expires_at)
        VALUES (${bookingId}::uuid, ${workerId}::uuid, tstzrange(${from}, ${to}, '[)'), 'HELD', now() + interval '5 minutes')
      `.execute(tx);
    });
  }

  it('blocks a restricted worker', async () => {
    const world = await createWorld(app.db);
    const [workerId] = world.workerIds as [string];
    const { booking } = await newBooking(world);
    await inTransaction(app.db, SYSTEM, (tx) =>
      tx
        .insertInto('worker_restriction')
        .values({
          worker_id: workerId,
          reason: 'Safety review',
          imposed_by: world.staffId,
          review_at: world.at(20),
        })
        .execute(),
    );
    await expect(tryReserve(world, booking.id, workerId)).rejects.toMatchObject({
      code: 'RESERVATION_NOT_ALLOWED',
      details: { reason: 'WORKER_RESTRICTED' },
    });
  });

  it('blocks a worker whose police verification expires before the job ends', async () => {
    const world = await createWorld(app.db);
    const [workerId] = world.workerIds as [string];
    const { booking } = await newBooking(world);
    await inTransaction(app.db, SYSTEM, (tx) =>
      tx
        .insertInto('worker_verification')
        .values({
          worker_id: workerId,
          verification_type: 'POLICE',
          status: 'VERIFIED',
          decided_by: world.staffId,
          decided_at: new Date(),
          expires_at: world.at(10, 30),
        })
        .execute(),
    );
    await expect(tryReserve(world, booking.id, workerId)).rejects.toMatchObject({
      details: { reason: 'VERIFICATION_MISSING:POLICE' },
    });
  });

  it('blocks a worker outside their planned shift', async () => {
    const world = await createWorld(app.db, { shiftStartHour: 12, shiftEndHour: 18 });
    const [workerId] = world.workerIds as [string];
    const customer = await world.customer();
    await expect(
      app.creation.create(
        world.bookingInput(customer, world.at(10)),
        customerContext(customer.userId),
      ),
    ).rejects.toMatchObject({ code: 'NO_AVAILABILITY' });

    const { booking } = await newBooking(world, 13);
    await expect(
      tryReserve(world, booking.id, workerId, world.at(9, 40), world.at(13, 10)),
    ).rejects.toMatchObject({
      code: 'RESERVATION_NOT_ALLOWED',
    });
  });

  it('a lifted restriction must be lifted by someone other than who imposed it', async () => {
    const world = await createWorld(app.db);
    const [workerId] = world.workerIds as [string];
    const restriction = await inTransaction(app.db, SYSTEM, (tx) =>
      tx
        .insertInto('worker_restriction')
        .values({
          worker_id: workerId,
          reason: 'Complaint',
          imposed_by: world.staffId,
          review_at: world.at(20),
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    await expect(
      inTransaction(app.db, SYSTEM, (tx) =>
        tx
          .updateTable('worker_restriction')
          .set({ lifted_by: world.staffId, lifted_at: new Date(), lift_reason: 'Reviewed' })
          .where('id', '=', restriction.id)
          .execute(),
      ),
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATED' });
  });
});

describe('money protections', () => {
  async function paidBooking(world: World) {
    const { customer, booking } = await newBooking(world);
    const payment = await inTransaction(app.db, paymentContext(), (tx) =>
      tx
        .insertInto('payment')
        .values({
          booking_id: booking.id,
          provider: 'SANDBOX',
          provider_order_id: randomUUID(),
          provider_payment_id: randomUUID(),
          amount_paise: booking.totalPaise,
          status: 'CAPTURED',
          captured_at: new Date(),
          idempotency_key: randomUUID(),
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    return { customer, booking, paymentId: payment.id };
  }

  function refund(bookingId: string, paymentId: string, amount: number, requestedBy: string) {
    return inTransaction(app.db, adminContext(requestedBy), (tx) =>
      tx
        .insertInto('refund')
        .values({
          booking_id: bookingId,
          payment_id: paymentId,
          amount_paise: amount,
          reason_code: 'CUSTOMER_CANCELLED',
          reason_text: 'Test',
          requested_by: requestedBy,
          requested_source: 'ADMIN',
          idempotency_key: randomUUID(),
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
  }

  it('a booking can never have two captured payments', async () => {
    const world = await createWorld(app.db);
    const { booking } = await paidBooking(world);
    await expect(
      inTransaction(app.db, paymentContext(), (tx) =>
        tx
          .insertInto('payment')
          .values({
            booking_id: booking.id,
            provider: 'SANDBOX',
            amount_paise: booking.totalPaise,
            status: 'CAPTURED',
            captured_at: new Date(),
            idempotency_key: randomUUID(),
          })
          .execute(),
      ),
    ).rejects.toMatchObject({
      code: 'DUPLICATE',
      details: { constraint: 'payment_one_captured_per_booking_uq' },
    });
  });

  it('a repeated gateway webhook is stored only once', async () => {
    const eventId = `evt_${randomUUID()}`;
    const insert = () =>
      app.db
        .insertInto('payment_event')
        .values({
          provider: 'SANDBOX',
          provider_event_id: eventId,
          event_type: 'payment.captured',
          signature_verified: true,
          payload: '{}',
        })
        .onConflict((oc) => oc.columns(['provider', 'provider_event_id']).doNothing())
        .returning('id')
        .executeTakeFirst();
    expect(await insert()).toBeDefined();
    expect(await insert()).toBeUndefined();
  });

  it('refunds can never exceed the captured amount, even across several requests', async () => {
    const world = await createWorld(app.db);
    const { booking, paymentId } = await paidBooking(world);
    await refund(booking.id, paymentId, booking.totalPaise - 100, world.staffId);
    await expect(refund(booking.id, paymentId, 101, world.staffId)).rejects.toMatchObject({
      code: 'REFUND_NOT_ALLOWED',
    });
    await refund(booking.id, paymentId, 100, world.staffId);
  });

  it('nobody can approve their own refund request', async () => {
    const world = await createWorld(app.db);
    const { booking, paymentId } = await paidBooking(world);
    const { id } = await refund(booking.id, paymentId, 1_000, world.staffId);
    await expect(
      inTransaction(app.db, adminContext(world.staffId), (tx) =>
        tx
          .updateTable('refund')
          .set({ status: 'APPROVED', decided_by: world.staffId, decided_at: new Date() })
          .where('id', '=', id)
          .execute(),
      ),
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATED' });
  });
});
