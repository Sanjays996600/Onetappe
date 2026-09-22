import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { BookingLifecycleService } from '../booking/booking-lifecycle.service.js';
import { BookingTransitionService } from '../booking/booking-transition.service.js';
import { DispatchService } from '../booking/dispatch.service.js';
import { systemContext } from '../database/action-context.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { inTransaction } from '../database/transaction.js';
import { NotificationDispatcher } from '../notifications/notification-dispatcher.service.js';
import { PaymentService } from '../payments/payment.service.js';
import { RefundService } from '../payments/refund.service.js';
import { SettlementService } from '../payments/settlement.service.js';

export const JOB_NAMES = [
  'expire-unpaid-bookings',
  'release-expired-holds',
  'expire-worker-offers',
  'redispatch-unassigned',
  'dispatch-notifications',
  'reconcile-payments',
  'process-refunds',
  'settle-bookings',
] as const;

export type JobName = (typeof JOB_NAMES)[number];

interface JobDefinition {
  readonly intervalMs: number;
  /** Returns how many items were handled. Must be safe to run repeatedly. */
  run(requestId: string): Promise<number>;
}

export interface JobRunResult {
  readonly job: JobName;
  readonly ran: boolean;
  readonly processed: number;
}

/**
 * Runs the periodic jobs. Every job is idempotent (it only acts on rows still in the
 * state it expects, under row locks), and a lease stops two worker processes running the
 * same job at once. Each run is recorded in job_run.
 */
@Injectable()
export class JobRunner implements OnApplicationShutdown {
  private readonly logger = new Logger('Jobs');
  private readonly owner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private readonly timers = new Map<JobName, NodeJS.Timeout>();
  private stopping = false;
  private readonly jobs: Record<JobName, JobDefinition>;

  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    lifecycle: BookingLifecycleService,
    dispatch: DispatchService,
    transitions: BookingTransitionService,
    notifications: NotificationDispatcher,
    payments: PaymentService,
    refunds: RefundService,
    settlement: SettlementService,
  ) {
    this.jobs = {
      'expire-unpaid-bookings': {
        intervalMs: 30_000,
        run: (id) => lifecycle.expireUnpaid(systemContext(id)),
      },
      'release-expired-holds': {
        intervalMs: 60_000,
        run: async (id) => {
          const released = await inTransaction(this.db, systemContext(id), (tx) =>
            tx
              .updateTable('worker_reservation')
              .set({
                status: 'RELEASED',
                released_at: sql<Date>`now()`,
                release_reason: 'HOLD_EXPIRED',
              })
              .where('status', '=', 'HELD')
              .where('hold_expires_at', '<', sql<Date>`now()`)
              .executeTakeFirst(),
          );
          return Number(released.numUpdatedRows);
        },
      },
      'expire-worker-offers': {
        intervalMs: 15_000,
        run: (id) => dispatch.expireOverdueOffers(systemContext(id)),
      },
      'redispatch-unassigned': {
        intervalMs: 60_000,
        run: async (id) => {
          // Confirmed bookings with nobody offered (all declined, no one was free earlier).
          const waiting = await this.db
            .selectFrom('booking as b')
            .select('b.id')
            .where('b.status', '=', 'CONFIRMED')
            .where('b.scheduled_start', '>', sql<Date>`now()`)
            .where((eb) =>
              eb.not(
                eb.exists(
                  eb
                    .selectFrom('booking_assignment as a')
                    .select(sql`1`.as('one'))
                    .whereRef('a.booking_id', '=', 'b.id')
                    .where('a.status', 'in', ['OFFERED', 'ACCEPTED']),
                ),
              ),
            )
            .limit(50)
            .execute();
          let offered = 0;
          for (const { id: bookingId } of waiting) {
            const result = await inTransaction(this.db, systemContext(id), async (tx) => {
              const booking = await transitions.lock(tx, bookingId);
              return dispatch.allocateAndOffer(tx, booking, systemContext(id));
            });
            offered += result.offers.length;
          }
          return offered;
        },
      },
      'dispatch-notifications': {
        intervalMs: 5_000,
        run: () => notifications.dispatchDue(),
      },
      'reconcile-payments': {
        intervalMs: 60_000,
        run: (id) => payments.reconcileOpenPayments(id),
      },
      'process-refunds': {
        intervalMs: 60_000,
        run: (id) => refunds.processPending(id),
      },
      'settle-bookings': {
        intervalMs: 60_000,
        run: async (id) => (await settlement.settleDue(id)).filter((o) => o.settled).length,
      },
    };
  }

  /** Starts every job on its interval (worker process only). */
  start(): void {
    for (const name of JOB_NAMES) this.schedule(name, 1_000);
    this.logger.log(`Background jobs started as ${this.owner}`);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    await this.db.deleteFrom('job_lease').where('owner', '=', this.owner).execute();
  }

  /** Runs one job now if no other process holds its lease. */
  async runOnce(name: JobName): Promise<JobRunResult> {
    const job = this.jobs[name];
    const leaseMs = Math.max(job.intervalMs * 4, 60_000);
    const acquired = await this.db
      .insertInto('job_lease')
      .values({
        job_name: name,
        owner: this.owner,
        locked_until: sql<Date>`now() + make_interval(secs => ${leaseMs / 1000})`,
      })
      .onConflict((oc) =>
        oc
          .column('job_name')
          .doUpdateSet({
            owner: this.owner,
            locked_until: sql<Date>`now() + make_interval(secs => ${leaseMs / 1000})`,
          })
          .where((eb) =>
            eb.or([
              eb('job_lease.locked_until', '<', sql<Date>`now()`),
              eb('job_lease.owner', '=', this.owner),
            ]),
          ),
      )
      .returning('job_name')
      .executeTakeFirst();
    if (!acquired) return { job: name, ran: false, processed: 0 };

    const run = await this.db
      .insertInto('job_run')
      .values({ job_name: name })
      .returning('id')
      .executeTakeFirstOrThrow();
    const requestId = `job:${name}:${run.id}`;
    try {
      const processed = await job.run(requestId);
      await this.db
        .updateTable('job_run')
        .set({ status: 'SUCCEEDED', processed, finished_at: sql<Date>`clock_timestamp()` })
        .where('id', '=', run.id)
        .execute();
      return { job: name, ran: true, processed };
    } catch (error) {
      this.logger.error(`Job ${name} failed`, error instanceof Error ? error.stack : String(error));
      await this.db
        .updateTable('job_run')
        .set({
          status: 'FAILED',
          error: String(error).slice(0, 1000),
          finished_at: sql<Date>`clock_timestamp()`,
        })
        .where('id', '=', run.id)
        .execute();
      return { job: name, ran: true, processed: 0 };
    } finally {
      await this.db
        .updateTable('job_lease')
        .set({ locked_until: sql<Date>`now()` })
        .where('job_name', '=', name)
        .where('owner', '=', this.owner)
        .execute();
    }
  }

  private schedule(name: JobName, delayMs: number): void {
    if (this.stopping) return;
    this.timers.set(
      name,
      setTimeout(() => {
        void this.runOnce(name).finally(() => {
          this.schedule(name, this.jobs[name].intervalMs);
        });
      }, delayMs),
    );
  }
}
