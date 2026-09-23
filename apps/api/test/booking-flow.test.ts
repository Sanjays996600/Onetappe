import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictError, ForbiddenError, ValidationError } from '../src/common/errors.js';
import { inTransaction } from '../src/database/transaction.js';
import {
  adminContext,
  createTestApp,
  createWorld,
  customerContext,
  paymentContext,
  SYSTEM,
  workerContext,
  type TestApp,
} from './support/world.js';

let app: TestApp;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

async function history(bookingId: string) {
  return app.db
    .selectFrom('booking_status_history')
    .select(['from_status', 'to_status', 'event', 'source', 'actor_user_id', 'reason'])
    .where('booking_id', '=', bookingId)
    .orderBy('id')
    .execute();
}

describe('HH60 end-to-end booking', () => {
  it('runs one complete transaction from booking to closure with a full audit trail', async () => {
    const world = await createWorld(app.db, { workers: 1 });
    const customer = await world.customer();
    const [workerId] = world.workerIds;
    if (!workerId) throw new Error('world has no worker');

    // 1. Customer books HH60 for tomorrow 10:00 IST and sees the total.
    const booking = await app.creation.create(
      { ...world.bookingInput(customer, world.at(10)), expectedTotalPaise: 58_882 },
      customerContext(customer.userId),
    );
    expect(booking).toMatchObject({
      status: 'PENDING_PAYMENT',
      totalPaise: 58_882,
      replayed: false,
    });
    expect(booking.scheduledStart).toEqual(world.at(10));
    expect(booking.scheduledEnd).toEqual(world.at(11));

    const held = await app.db
      .selectFrom('worker_reservation')
      .select([
        'worker_id',
        'status',
        sql<string>`lower(period)`.as('from'),
        sql<string>`upper(period)`.as('to'),
      ])
      .where('booking_id', '=', booking.id)
      .execute();
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ worker_id: workerId, status: 'HELD' });
    // 20 minutes travel before, 10 minutes reset after.
    expect(new Date(held[0]!.from)).toEqual(world.at(9, 40));
    expect(new Date(held[0]!.to)).toEqual(world.at(11, 10));

    // 2. Payment captured → confirmed → the held worker receives an offer.
    const dispatch = await inTransaction(app.db, paymentContext(), (tx) =>
      app.dispatch.confirmPaidInTx(tx, booking.id, paymentContext()),
    );
    expect(dispatch.unfilledCrewSlots).toEqual([]);
    expect(dispatch.offers).toHaveLength(1);
    const offer = dispatch.offers[0]!;
    expect(offer.workerId).toBe(workerId);

    // 3. Worker accepts.
    await app.dispatch.accept(offer.assignmentId, workerContext(workerId));

    // 4. Travel, arrival, start with the customer's code, completion.
    await app.lifecycle.recordFieldEvent(booking.id, 'START_TRAVEL', workerContext(workerId));
    await app.lifecycle.recordFieldEvent(booking.id, 'MARK_ARRIVED', workerContext(workerId));
    const code = app.codes.codeFor(booking.id, 'START');
    await app.lifecycle.startService(booking.id, workerContext(workerId), { code });
    await app.lifecycle.recordFieldEvent(booking.id, 'COMPLETE_SERVICE', workerContext(workerId));

    // 5. Customer rates; the system closes once settled.
    await app.db
      .insertInto('booking_rating')
      .values({
        booking_id: booking.id,
        rated_by_user_id: customer.userId,
        rater_role: 'CUSTOMER',
        score: 5,
      })
      .execute();
    await app.lifecycle.close(booking.id, SYSTEM);

    const final = await app.db
      .selectFrom('booking')
      .select(['status', 'completed_at', 'closed_at', 'original_start', 'version'])
      .where('id', '=', booking.id)
      .executeTakeFirstOrThrow();
    expect(final.status).toBe('CLOSED');
    expect(final.completed_at).not.toBeNull();
    expect(final.closed_at).not.toBeNull();
    expect(final.original_start).toEqual(world.at(10));

    expect(await history(booking.id)).toEqual([
      {
        from_status: null,
        to_status: 'PENDING_PAYMENT',
        event: 'CREATED',
        source: 'CUSTOMER_APP',
        actor_user_id: customer.userId,
        reason: null,
      },
      {
        from_status: 'PENDING_PAYMENT',
        to_status: 'CONFIRMED',
        event: 'PAYMENT_CAPTURED',
        source: 'PAYMENT_GATEWAY',
        actor_user_id: null,
        reason: null,
      },
      {
        from_status: 'CONFIRMED',
        to_status: 'ASSIGNED',
        event: 'WORKER_ACCEPTED',
        source: 'WORKER_APP',
        actor_user_id: workerId,
        reason: null,
      },
      {
        from_status: 'ASSIGNED',
        to_status: 'EN_ROUTE',
        event: 'START_TRAVEL',
        source: 'WORKER_APP',
        actor_user_id: workerId,
        reason: null,
      },
      {
        from_status: 'EN_ROUTE',
        to_status: 'ARRIVED',
        event: 'MARK_ARRIVED',
        source: 'WORKER_APP',
        actor_user_id: workerId,
        reason: null,
      },
      {
        from_status: 'ARRIVED',
        to_status: 'IN_PROGRESS',
        event: 'START_SERVICE',
        source: 'WORKER_APP',
        actor_user_id: workerId,
        reason: null,
      },
      {
        from_status: 'IN_PROGRESS',
        to_status: 'COMPLETED',
        event: 'COMPLETE_SERVICE',
        source: 'WORKER_APP',
        actor_user_id: workerId,
        reason: null,
      },
      {
        from_status: 'COMPLETED',
        to_status: 'CLOSED',
        event: 'CLOSE',
        source: 'SYSTEM',
        actor_user_id: null,
        reason: null,
      },
    ]);

    const lines = await app.db
      .selectFrom('booking_price_line')
      .select(['line_type', 'amount_paise'])
      .where('booking_id', '=', booking.id)
      .orderBy('line_no')
      .execute();
    expect(lines).toEqual([
      { line_type: 'BASE', amount_paise: 49_900 },
      { line_type: 'TAX', amount_paise: 8_982 },
    ]);

    const assignment = await app.db
      .selectFrom('booking_assignment')
      .select('status')
      .where('booking_id', '=', booking.id)
      .executeTakeFirstOrThrow();
    expect(assignment.status).toBe('COMPLETED');
  });

  it('returns the same booking when the app retries with the same idempotency key', async () => {
    const world = await createWorld(app.db);
    const customer = await world.customer();
    const input = world.bookingInput(customer, world.at(12));

    const first = await app.creation.create(input, customerContext(customer.userId));
    const retry = await app.creation.create(input, customerContext(customer.userId));
    expect(retry).toMatchObject({ id: first.id, replayed: true });
  });

  it('refuses to book when the price shown to the customer is out of date', async () => {
    const world = await createWorld(app.db);
    const customer = await world.customer();
    await expect(
      app.creation.create(
        { ...world.bookingInput(customer, world.at(10)), expectedTotalPaise: 40_000 },
        customerContext(customer.userId),
      ),
    ).rejects.toMatchObject({ code: 'PRICE_CHANGED' });
  });

  it('lets operations book on behalf of a customer and records the ADMIN source', async () => {
    const world = await createWorld(app.db);
    const customer = await world.customer();
    const booking = await app.creation.create(
      { ...world.bookingInput(customer, world.at(15)), paymentMode: 'PAY_AFTER_SERVICE' },
      adminContext(world.staffId),
    );
    const row = await app.db
      .selectFrom('booking')
      .select(['source', 'created_by_user_id', 'customer_user_id', 'payment_mode'])
      .where('id', '=', booking.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      source: 'ADMIN',
      created_by_user_id: world.staffId,
      customer_user_id: customer.userId,
      payment_mode: 'PAY_AFTER_SERVICE',
    });

    const result = await app.dispatch.confirmWithoutPrepayment(
      booking.id,
      'Customer pays cash after service',
      adminContext(world.staffId),
    );
    expect(result.offers).toHaveLength(1);
  });

  it('stops a customer from booking for someone else or choosing pay-later', async () => {
    const world = await createWorld(app.db);
    const customer = await world.customer();
    const other = await world.customer();
    await expect(
      app.creation.create(
        world.bookingInput(customer, world.at(10)),
        customerContext(other.userId),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      app.creation.create(
        { ...world.bookingInput(customer, world.at(10)), paymentMode: 'PAY_AFTER_SERVICE' },
        customerContext(customer.userId),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects times off the 15-minute grid and addresses outside the service area', async () => {
    const world = await createWorld(app.db);
    const customer = await world.customer();
    await expect(
      app.creation.create(
        world.bookingInput(customer, world.at(10, 5)),
        customerContext(customer.userId),
      ),
    ).rejects.toMatchObject({ code: 'START_TIME_NOT_ON_SLOT' });

    const far = await inTransaction(app.db, SYSTEM, (tx) =>
      tx
        .insertInto('address')
        .values({
          user_id: customer.userId,
          contact_name: 'Far away',
          contact_phone_e164: '+919900000001',
          house_number: '1',
          pincode: world.pincode,
          city_name: 'Elsewhere',
          lat: '28.9000',
          lng: '77.9000',
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    await expect(
      app.creation.create(
        { ...world.bookingInput(customer, world.at(10)), addressId: far.id },
        customerContext(customer.userId),
      ),
    ).rejects.toMatchObject({ code: 'AREA_NOT_SERVICEABLE' });
  });

  it('counts wrong start codes, keeps the job waiting, and locks after five attempts', async () => {
    const world = await createWorld(app.db);
    const customer = await world.customer();
    const [workerId] = world.workerIds as [string];
    const booking = await app.creation.create(
      world.bookingInput(customer, world.at(10)),
      customerContext(customer.userId),
    );
    const { offers } = await inTransaction(app.db, paymentContext(), (tx) =>
      app.dispatch.confirmPaidInTx(tx, booking.id, paymentContext()),
    );
    await app.dispatch.accept(offers[0]!.assignmentId, workerContext(workerId));
    await app.lifecycle.recordFieldEvent(booking.id, 'START_TRAVEL', workerContext(workerId));
    await app.lifecycle.recordFieldEvent(booking.id, 'MARK_ARRIVED', workerContext(workerId));

    const correct = app.codes.codeFor(booking.id, 'START');
    const wrong = correct === '0000' ? '1111' : '0000';
    for (let i = 0; i < 5; i += 1) {
      await expect(
        app.lifecycle.startService(booking.id, workerContext(workerId), { code: wrong }),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(
      app.lifecycle.startService(booking.id, workerContext(workerId), { code: correct }),
    ).rejects.toMatchObject({ code: 'CODE_LOCKED' });

    const status = await app.db
      .selectFrom('booking')
      .select('status')
      .where('id', '=', booking.id)
      .executeTakeFirstOrThrow();
    expect(status.status).toBe('ARRIVED');

    // Operations can still start the job, but only with a written reason.
    await app.lifecycle.startService(booking.id, adminContext(world.staffId), {
      overrideReason: 'Customer confirmed by phone call',
    });
    const last = (await history(booking.id)).at(-1);
    expect(last).toMatchObject({
      to_status: 'IN_PROGRESS',
      source: 'ADMIN',
      reason: 'Start code overridden: Customer confirmed by phone call',
    });
  });

  it('only the assigned worker can move the job forward', async () => {
    const world = await createWorld(app.db, { workers: 2 });
    const customer = await world.customer();
    const booking = await app.creation.create(
      world.bookingInput(customer, world.at(10)),
      customerContext(customer.userId),
    );
    const { offers } = await inTransaction(app.db, paymentContext(), (tx) =>
      app.dispatch.confirmPaidInTx(tx, booking.id, paymentContext()),
    );
    const assigned = offers[0]!.workerId;
    const other = world.workerIds.find((id) => id !== assigned)!;

    await expect(
      app.dispatch.accept(offers[0]!.assignmentId, workerContext(other)),
    ).rejects.toMatchObject({
      code: 'ASSIGNMENT_NOT_FOUND',
    });
    await app.dispatch.accept(offers[0]!.assignmentId, workerContext(assigned));
    await expect(
      app.lifecycle.recordFieldEvent(booking.id, 'START_TRAVEL', workerContext(other)),
    ).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
  });
});

describe('reassignment', () => {
  it('offers the job to the next worker when the first declines, and never back to them', async () => {
    const world = await createWorld(app.db, { workers: 2 });
    const customer = await world.customer();
    const booking = await app.creation.create(
      world.bookingInput(customer, world.at(10)),
      customerContext(customer.userId),
    );
    const first = await inTransaction(app.db, paymentContext(), (tx) =>
      app.dispatch.confirmPaidInTx(tx, booking.id, paymentContext()),
    );
    const firstWorker = first.offers[0]!.workerId;

    const second = await app.dispatch.reject(
      first.offers[0]!.assignmentId,
      'Too far today',
      workerContext(firstWorker),
    );
    expect(second.offers).toHaveLength(1);
    expect(second.offers[0]!.workerId).not.toBe(firstWorker);

    // The second worker declines too: nobody is left, and operations is told.
    const third = await app.dispatch.reject(
      second.offers[0]!.assignmentId,
      'Unwell',
      workerContext(second.offers[0]!.workerId),
    );
    expect(third).toEqual({ offers: [], unfilledCrewSlots: [1] });

    const active = await app.db
      .selectFrom('worker_reservation')
      .select('id')
      .where('booking_id', '=', booking.id)
      .where('status', '<>', 'RELEASED')
      .execute();
    expect(active).toHaveLength(0);
  });

  it('expires unanswered offers and moves on', async () => {
    const world = await createWorld(app.db, { workers: 2 });
    const customer = await world.customer();
    const booking = await app.creation.create(
      world.bookingInput(customer, world.at(10)),
      customerContext(customer.userId),
    );
    const { offers } = await inTransaction(app.db, paymentContext(), (tx) =>
      app.dispatch.confirmPaidInTx(tx, booking.id, paymentContext()),
    );

    // Simulate the clock running out on the offer. Offer times are immutable by design,
    // so the guard trigger is switched off for this one test update only.
    await sql`ALTER TABLE booking_assignment DISABLE TRIGGER booking_assignment_before_update`.execute(
      app.owner,
    );
    try {
      await inTransaction(app.db, SYSTEM, (tx) =>
        tx
          .updateTable('booking_assignment')
          .set({
            offered_at: new Date(Date.now() - 400_000),
            offer_expires_at: new Date(Date.now() - 1_000),
          })
          .where('id', '=', offers[0]!.assignmentId)
          .execute(),
      );
    } finally {
      await sql`ALTER TABLE booking_assignment ENABLE TRIGGER booking_assignment_before_update`.execute(
        app.owner,
      );
    }

    await expect(
      app.dispatch.accept(offers[0]!.assignmentId, workerContext(offers[0]!.workerId)),
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATED' });

    const expired = await app.dispatch.expireOverdueOffers(SYSTEM);
    expect(expired).toBeGreaterThanOrEqual(1);

    const live = await app.db
      .selectFrom('booking_assignment')
      .select(['worker_id', 'status'])
      .where('booking_id', '=', booking.id)
      .orderBy('offered_at')
      .execute();
    expect(live.map((a) => a.status)).toEqual(['EXPIRED', 'OFFERED']);
    expect(live[1]!.worker_id).not.toBe(offers[0]!.workerId);
  });
});

describe('cancellation and expiry', () => {
  it('cancelling releases the worker so another customer can book the same time', async () => {
    const world = await createWorld(app.db, { workers: 1 });
    const a = await world.customer();
    const b = await world.customer();
    const first = await app.creation.create(
      world.bookingInput(a, world.at(10)),
      customerContext(a.userId),
    );

    await expect(
      app.creation.create(world.bookingInput(b, world.at(10)), customerContext(b.userId)),
    ).rejects.toMatchObject({ code: 'NO_AVAILABILITY' });

    await app.lifecycle.cancel(first.id, 'Plans changed', customerContext(a.userId));
    const second = await app.creation.create(
      world.bookingInput(b, world.at(10)),
      customerContext(b.userId),
    );
    expect(second.status).toBe('PENDING_PAYMENT');

    const cancelled = await history(first.id);
    expect(cancelled.at(-1)).toMatchObject({
      to_status: 'CANCELLED',
      reason: 'Plans changed',
      source: 'CUSTOMER_APP',
    });
  });

  it("a customer cannot cancel someone else's booking", async () => {
    const world = await createWorld(app.db);
    const a = await world.customer();
    const b = await world.customer();
    const booking = await app.creation.create(
      world.bookingInput(a, world.at(10)),
      customerContext(a.userId),
    );
    await expect(
      app.lifecycle.cancel(booking.id, 'x', customerContext(b.userId)),
    ).rejects.toMatchObject({
      code: 'BOOKING_NOT_FOUND',
    });
  });

  it('expires unpaid bookings and frees their capacity', async () => {
    const world = await createWorld(app.db, { workers: 1 });
    const a = await world.customer();
    const b = await world.customer();
    const unpaid = await app.creation.create(
      world.bookingInput(a, world.at(10)),
      customerContext(a.userId),
    );

    await inTransaction(app.db, SYSTEM, (tx) =>
      tx
        .updateTable('booking')
        .set({ payment_due_by: new Date(Date.now() - 1_000) })
        .where('id', '=', unpaid.id)
        .execute(),
    );
    expect(await app.lifecycle.expireUnpaid(SYSTEM)).toBeGreaterThanOrEqual(1);

    const row = await app.db
      .selectFrom('booking')
      .select('status')
      .where('id', '=', unpaid.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('EXPIRED');
    const next = await app.creation.create(
      world.bookingInput(b, world.at(10)),
      customerContext(b.userId),
    );
    expect(next.status).toBe('PENDING_PAYMENT');
  });
});

describe('rescheduling', () => {
  it('keeps the original promise permanently and records every change', async () => {
    const world = await createWorld(app.db, { workers: 1 });
    const customer = await world.customer();
    const booking = await app.creation.create(
      world.bookingInput(customer, world.at(10)),
      customerContext(customer.userId),
    );
    const { offers } = await inTransaction(app.db, paymentContext(), (tx) =>
      app.dispatch.confirmPaidInTx(tx, booking.id, paymentContext()),
    );
    await app.dispatch.accept(offers[0]!.assignmentId, workerContext(offers[0]!.workerId));

    // Original promise 10:00–11:00, changed to 11:00–12:00.
    const moved = await app.lifecycle.reschedule(
      booking.id,
      world.at(11),
      'Guests arriving late',
      customerContext(customer.userId),
    );
    expect(moved).toEqual({ scheduledStart: world.at(11), scheduledEnd: world.at(12) });

    const row = await app.db
      .selectFrom('booking')
      .select([
        'status',
        'original_start',
        'original_end',
        'scheduled_start',
        'scheduled_end',
        'reschedule_count',
      ])
      .where('id', '=', booking.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      // The worker must accept the new time again.
      status: 'CONFIRMED',
      original_start: world.at(10),
      original_end: world.at(11),
      scheduled_start: world.at(11),
      scheduled_end: world.at(12),
      reschedule_count: 1,
    });

    const changes = await app.db
      .selectFrom('booking_schedule_change')
      .select([
        'previous_start',
        'previous_end',
        'new_start',
        'new_end',
        'source',
        'actor_user_id',
        'reason',
      ])
      .where('booking_id', '=', booking.id)
      .execute();
    expect(changes).toEqual([
      {
        previous_start: world.at(10),
        previous_end: world.at(11),
        new_start: world.at(11),
        new_end: world.at(12),
        source: 'CUSTOMER_APP',
        actor_user_id: customer.userId,
        reason: 'Guests arriving late',
      },
    ]);

    // The unassignment is recorded as a system consequence of the customer's action.
    const unassigned = (await history(booking.id)).find((h) => h.event === 'WORKER_UNASSIGNED');
    expect(unassigned).toMatchObject({ source: 'SYSTEM', actor_user_id: customer.userId });

    // A new offer exists for the new time.
    const live = await app.db
      .selectFrom('booking_assignment')
      .select('status')
      .where('booking_id', '=', booking.id)
      .where('status', '=', 'OFFERED')
      .execute();
    expect(live).toHaveLength(1);
  });

  it('leaves the booking untouched when nobody is free at the new time', async () => {
    const world = await createWorld(app.db, { workers: 1 });
    const a = await world.customer();
    const b = await world.customer();
    const mine = await app.creation.create(
      world.bookingInput(a, world.at(10)),
      customerContext(a.userId),
    );
    await app.creation.create(world.bookingInput(b, world.at(14)), customerContext(b.userId));

    await expect(
      app.lifecycle.reschedule(
        mine.id,
        world.at(14),
        'Prefer afternoon',
        customerContext(a.userId),
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    const row = await app.db
      .selectFrom('booking')
      .select(['scheduled_start', 'reschedule_count'])
      .where('id', '=', mine.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ scheduled_start: world.at(10), reschedule_count: 0 });
    const held = await app.db
      .selectFrom('worker_reservation')
      .select('status')
      .where('booking_id', '=', mine.id)
      .executeTakeFirstOrThrow();
    expect(held.status).toBe('HELD');
  });
});
