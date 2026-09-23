import { randomInt, randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { CreateBookingInput } from '../../src/booking/booking-creation.service.js';
import type { ActionContext } from '../../src/database/action-context.js';
import type { DB } from '../../src/database/db.generated.js';
import { inTransaction, type Tx } from '../../src/database/transaction.js';

/**
 * Data fixtures for tests and the end-to-end seed. No application (Nest) code is loaded,
 * so plain scripts can use them too.
 */

export const SYSTEM: ActionContext = {
  actorUserId: null,
  actorRole: 'SYSTEM',
  source: 'SYSTEM',
  requestId: 'test-setup',
};

export function customerContext(userId: string): ActionContext {
  return {
    actorUserId: userId,
    actorRole: 'CUSTOMER',
    source: 'CUSTOMER_APP',
    requestId: randomUUID(),
  };
}

export function workerContext(userId: string): ActionContext {
  return {
    actorUserId: userId,
    actorRole: 'WORKER',
    source: 'WORKER_APP',
    requestId: randomUUID(),
  };
}

export function adminContext(userId: string): ActionContext {
  return {
    actorUserId: userId,
    actorRole: 'OPERATIONS_AGENT',
    source: 'ADMIN',
    requestId: randomUUID(),
  };
}

export function paymentContext(): ActionContext {
  return {
    actorUserId: null,
    actorRole: 'SYSTEM',
    source: 'PAYMENT_GATEWAY',
    requestId: randomUUID(),
  };
}

export interface World {
  readonly cityId: string;
  readonly zoneId: string;
  readonly pincode: string;
  /** Zone centre; addresses near it are serviceable. */
  readonly center: { readonly lat: number; readonly lng: number };
  /** Tomorrow's date in India, YYYY-MM-DD. */
  readonly day: string;
  readonly serviceId: string;
  readonly taskIds: readonly string[];
  readonly staffId: string;
  readonly workerIds: readonly string[];
  /** Creates a customer with a serviceable address. */
  customer(): Promise<{ userId: string; addressId: string }>;
  /** Tomorrow at the given local (IST) time. */
  at(hour: number, minute?: number): Date;
  bookingInput(customer: { userId: string; addressId: string }, start: Date): CreateBookingInput;
}

const ZONE_CENTER = { lat: 28.6139, lng: 77.391 };
let sequence = 0;

function uniqueSuffix(): string {
  sequence += 1;
  return `${Date.now().toString(36).toUpperCase()}${sequence}`.slice(-10);
}

function randomPhone(): string {
  return `+9199${randomInt(10_000_000, 99_999_999)}`;
}

function uniquePincode(): string {
  return String(randomInt(200_000, 999_999));
}

/** The next calendar day in India, as YYYY-MM-DD. */
function tomorrowInIndia(): string {
  const tomorrow = new Date(Date.now() + 24 * 3_600_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(tomorrow);
}

/**
 * Moves a freshly registered worker through onboarding exactly as the lifecycle allows:
 * automatic steps as SYSTEM, approval and activation as ADMIN.
 */
export async function walkWorkerToActive(tx: Tx, workerId: string, staffId: string): Promise<void> {
  const steps: Array<[string, 'SYSTEM' | 'ADMIN']> = [
    ['PROFILE_PENDING', 'SYSTEM'],
    ['DOCUMENTS_PENDING', 'SYSTEM'],
    ['VERIFICATION_PENDING', 'SYSTEM'],
    ['TRAINING_PENDING', 'SYSTEM'],
    ['APPROVED', 'ADMIN'],
    ['ACTIVE', 'ADMIN'],
  ];
  for (const [status, source] of steps) {
    await sql`SELECT set_config('app.source', ${source}, true)`.execute(tx);
    await tx
      .updateTable('worker_profile')
      .set(
        status === 'APPROVED'
          ? { status, approved_by: staffId, approved_at: new Date() }
          : { status },
      )
      .where('user_id', '=', workerId)
      .execute();
  }
  await sql`SELECT set_config('app.source', 'SYSTEM', true)`.execute(tx);
}

export interface WorldOptions {
  /** Display names; codes stay unique per test world. */
  readonly cityName?: string;
  readonly zoneName?: string;
  readonly center?: { readonly lat: number; readonly lng: number };
  readonly workers?: number;
  readonly workersRequired?: number;
  readonly shiftStartHour?: number;
  readonly shiftEndHour?: number;
}

/**
 * Builds an isolated, fully configured service area: city, zone, locality, an active
 * HH60-style service with price, tax, tasks and requirements, and approved workers with
 * valid verifications and planned shifts for tomorrow. Unique codes and pincodes keep
 * tests independent while sharing one database.
 */
export async function createWorld(db: Kysely<DB>, options: WorldOptions = {}): Promise<World> {
  const suffix = uniqueSuffix();
  const day = tomorrowInIndia();
  const at = (hour: number, minute = 0) =>
    new Date(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+05:30`);
  const pincode = uniquePincode();
  const center = options.center ?? ZONE_CENTER;

  return inTransaction(db, SYSTEM, async (tx) => {
    const staff = await tx
      .insertInto('app_user')
      .values({ phone_e164: randomPhone(), full_name: 'Ops Agent' })
      .returning('id')
      .executeTakeFirstOrThrow();

    const city = await tx
      .insertInto('city')
      .values({
        code: `C${suffix}`,
        name: options.cityName ?? `City ${suffix}`,
        state_name: 'Uttar Pradesh',
        is_active: true,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const zone = await tx
      .insertInto('zone')
      .values({
        city_id: city.id,
        code: `Z${suffix}`,
        name: options.zoneName ?? `Zone ${suffix}`,
        center_lat: String(center.lat),
        center_lng: String(center.lng),
        service_radius_m: 5_000,
        is_active: true,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await tx
      .insertInto('pincode')
      .values({ code: pincode, city_id: city.id, is_active: true })
      .execute();
    await tx
      .insertInto('locality')
      .values({ zone_id: zone.id, pincode, name: `Sector ${suffix}`, is_active: true })
      .execute();

    const category = await tx
      .insertInto('service_category')
      .values({ code: `HOUSE_HELP_${suffix}`, name: 'House Help', is_active: true })
      .returning('id')
      .executeTakeFirstOrThrow();
    const service = await tx
      .insertInto('service')
      .values({
        category_id: category.id,
        code: `HH60_${suffix}`,
        name: 'House help — 60 minutes',
        duration_minutes: 60,
        buffer_before_minutes: 20,
        buffer_after_minutes: 10,
        workers_required: options.workersRequired ?? 1,
        supports_instant: true,
        min_lead_time_minutes: 60,
        max_advance_days: 7,
        payment_hold_minutes: 10,
        offer_timeout_seconds: 180,
        is_active: true,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const tasks = await tx
      .insertInto('service_task')
      .values([
        { service_id: service.id, code: 'DISHES', name: 'Dishes', sort_order: 1 },
        { service_id: service.id, code: 'SWEEP_MOP', name: 'Sweeping and mopping', sort_order: 2 },
        {
          service_id: service.id,
          code: 'DUSTING',
          name: 'Dusting',
          sort_order: 3,
          is_default_selected: false,
        },
      ])
      .returning('id')
      .execute();
    await tx
      .insertInto('service_zone')
      .values({ service_id: service.id, zone_id: zone.id, is_active: true })
      .execute();

    await sql`
      INSERT INTO tax_rate (code, name, rate_bp, effective_from)
      SELECT 'GST18', 'GST 18%', 1800, '2020-01-01'
      WHERE NOT EXISTS (SELECT 1 FROM tax_rate WHERE code = 'GST18')
    `.execute(tx);
    await tx
      .insertInto('price_rule')
      .values({
        service_id: service.id,
        base_amount_paise: 49_900,
        tax_rate_code: 'GST18',
        valid_from: new Date('2020-01-01T00:00:00Z'),
      })
      .execute();
    // Worker pay for the service, configured separately from the customer price.
    await tx
      .insertInto('payout_rule')
      .values({
        service_id: service.id,
        base_payout_paise: 30_000,
        travel_allowance_paise: 3_000,
        valid_from: new Date('2020-01-01T00:00:00Z'),
      })
      .execute();

    await tx
      .insertInto('service_verification_requirement')
      .values([
        { service_id: service.id, verification_type: 'IDENTITY' },
        { service_id: service.id, verification_type: 'POLICE' },
      ])
      .execute();
    await sql`
      INSERT INTO training_module (code, name) VALUES ('HOUSE_HELP_BASICS', 'House help basics')
      ON CONFLICT (code) DO NOTHING
    `.execute(tx);
    await tx
      .insertInto('service_training_requirement')
      .values({ service_id: service.id, module_code: 'HOUSE_HELP_BASICS' })
      .execute();

    const workerIds: string[] = [];
    for (let i = 0; i < (options.workers ?? 1); i += 1) {
      const user = await tx
        .insertInto('app_user')
        .values({ phone_e164: randomPhone(), full_name: `Worker ${i + 1}` })
        .returning('id')
        .executeTakeFirstOrThrow();
      await tx
        .insertInto('worker_profile')
        .values({
          user_id: user.id,
          worker_code: `W${suffix}${i}`.slice(0, 13),
          primary_zone_id: zone.id,
        })
        .execute();
      for (const type of ['IDENTITY', 'POLICE'] as const) {
        await tx
          .insertInto('worker_verification')
          .values({
            worker_id: user.id,
            verification_type: type,
            status: 'VERIFIED',
            decided_by: staff.id,
            decided_at: new Date(),
          })
          .execute();
      }
      await tx
        .insertInto('worker_training')
        .values({
          worker_id: user.id,
          module_code: 'HOUSE_HELP_BASICS',
          status: 'PASSED',
          assessed_by: staff.id,
          assessed_at: new Date(),
        })
        .execute();
      await tx
        .insertInto('worker_service_permission')
        .values({ worker_id: user.id, service_id: service.id, granted_by: staff.id })
        .execute();
      await tx
        .insertInto('worker_shift')
        .values({
          worker_id: user.id,
          zone_id: zone.id,
          period: sql`tstzrange(${at(options.shiftStartHour ?? 8)}, ${at(options.shiftEndHour ?? 20)}, '[)')`,
        })
        .execute();
      await walkWorkerToActive(tx, user.id, staff.id);
      await tx
        .insertInto('worker_presence')
        .values({ worker_id: user.id, is_online: true })
        .execute();
      workerIds.push(user.id);
    }

    const world: World = {
      cityId: city.id,
      zoneId: zone.id,
      pincode,
      center,
      day,
      serviceId: service.id,
      taskIds: tasks.map((t) => t.id),
      staffId: staff.id,
      workerIds,
      at,
      customer: () =>
        inTransaction(db, SYSTEM, async (ctx) => {
          const user = await ctx
            .insertInto('app_user')
            .values({ phone_e164: randomPhone(), full_name: 'Test Customer' })
            .returning('id')
            .executeTakeFirstOrThrow();
          await ctx.insertInto('customer_profile').values({ user_id: user.id }).execute();
          const address = await ctx
            .insertInto('address')
            .values({
              user_id: user.id,
              contact_name: 'Test Customer',
              contact_phone_e164: randomPhone(),
              house_number: 'B-12',
              street: 'Main Road',
              pincode,
              city_name: 'Test City',
              lat: String(center.lat + 0.005),
              lng: String(center.lng + 0.005),
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          return { userId: user.id, addressId: address.id };
        }),
      bookingInput: (customer, start) => ({
        customerUserId: customer.userId,
        serviceId: service.id,
        serviceOptionId: null,
        addressId: customer.addressId,
        bookingType: 'SCHEDULED',
        requestedStart: start,
        taskIds: null,
        promoCode: null,
        customerNotes: null,
        expectedTotalPaise: null,
        paymentMode: 'PREPAID',
        idempotencyKey: randomUUID(),
      }),
    };
    return world;
  });
}
