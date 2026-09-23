import { Inject, Injectable, Logger } from '@nestjs/common';
import { hostname } from 'node:os';
import { sql, type Kysely } from 'kysely';
import { Clock } from '../common/clock.js';
import type { ActionContext } from '../database/action-context.js';
import { DATABASE } from '../database/database.module.js';
import { inTransaction } from '../database/transaction.js';
import type { DB } from '../database/db.generated.js';
import { IntegrationError, type FailureKind } from './integration-error.js';
import {
  INTEGRATION_EVENT_TYPES,
  IntegrationOutbox,
  type IntegrationEventType,
  type IntegrationTarget,
} from './integration-outbox.service.js';
import { ZohoSyncService } from './zoho/zoho-sync.service.js';

/** Delivery rules; kept together so operations can review them. */
export const INTEGRATION_POLICY = {
  batchSize: 20,
  /** A claimed event is released for another worker if this one dies mid-delivery. */
  leaseSeconds: 120,
  /** Attempts before a retryable failure is parked as DEAD for a person to decide. */
  maxAttempts: 8,
  /** Wait after attempt n (1-based), in minutes. */
  backoffMinutes: [1, 5, 15, 60, 180, 360, 720],
  /** Consecutive failures that pause a target (circuit breaker), and for how long. */
  breakerThreshold: 5,
  breakerPauseSeconds: 300,
  /** Pause after a credential or configuration problem (needs a person anyway). */
  setupPauseSeconds: 600,
} as const;

const INTEGRATION_CONTEXT = (requestId: string): ActionContext => ({
  actorUserId: null,
  actorRole: 'SYSTEM',
  source: 'INTEGRATION',
  requestId,
});

interface ClaimedEvent {
  id: number;
  event_type: string;
  aggregate_id: string;
  attempts: number;
}

/**
 * Delivers outbox events to external systems. Runs in the background worker only; a slow,
 * rate-limited or failing external system delays these events and nothing else.
 */
@Injectable()
export class IntegrationDispatcher {
  private readonly logger = new Logger('Integrations');
  private readonly owner = `${hostname()}:${String(process.pid)}`;

  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly outbox: IntegrationOutbox,
    private readonly zoho: ZohoSyncService,
    private readonly clock: Clock,
  ) {}

  /** One delivery round for every enabled target; returns the number of events delivered. */
  async deliverDue(requestId: string): Promise<number> {
    let delivered = 0;
    for (const target of ['ZOHO_DESK', 'ZOHO_CRM'] as const) {
      if (!this.outbox.isEnabled(target)) continue;
      delivered += await this.deliverTarget(target, requestId);
    }
    return delivered;
  }

  /**
   * Queues a status pull for cases whose Desk ticket may have changed without a webhook
   * reaching us (open cases, and resolved ones for a week in case they are reopened).
   */
  async schedulePulls(requestId: string, limit = 200): Promise<number> {
    if (!this.outbox.isEnabled('ZOHO_DESK')) return 0;
    const cases = await this.db
      .selectFrom('external_link as l')
      .innerJoin('support_case as c', 'c.id', 'l.internal_id')
      .select('c.id')
      .where('l.target', '=', 'ZOHO_DESK')
      .where('l.entity_type', '=', 'support_case')
      .where((eb) =>
        eb.or([
          eb('c.status', 'not in', ['RESOLVED', 'CLOSED']),
          eb.and([
            eb('c.status', '=', 'RESOLVED'),
            eb('c.resolved_at', '>', sql<Date>`now() - interval '7 days'`),
          ]),
        ]),
      )
      .orderBy('l.synced_at')
      .limit(limit)
      .execute();
    await inTransaction(this.db, INTEGRATION_CONTEXT(requestId), async (tx) => {
      for (const { id } of cases) {
        await this.outbox.enqueue(tx, 'DESK_CASE_PULL', id, { requestId });
      }
    });
    return cases.length;
  }

  private async deliverTarget(target: IntegrationTarget, requestId: string): Promise<number> {
    const state = await this.db
      .selectFrom('integration_target_state')
      .select(['paused_until'])
      .where('target', '=', target)
      .executeTakeFirstOrThrow();
    if (state.paused_until && state.paused_until > this.clock.now()) return 0;

    const claimed = await this.claim(target);
    let delivered = 0;
    for (const event of claimed) {
      const outcome = await this.deliverOne(target, event, requestId);
      if (outcome === 'DELIVERED') delivered += 1;
      if (outcome === 'TARGET_PAUSED') {
        // Give the rest of the batch back untouched; they are retried after the pause.
        await this.release(claimed.filter((e) => e.id > event.id));
        break;
      }
    }
    return delivered;
  }

  /**
   * Claims due events. Events for one record are delivered in order: an event waits while
   * an earlier one for the same record is pending, in flight or parked as DEAD (e.g. no
   * status pull before the ticket exists).
   */
  private async claim(target: IntegrationTarget): Promise<ClaimedEvent[]> {
    return this.db.transaction().execute(async (tx) => {
      const due = await tx
        .selectFrom('integration_event as e')
        .select('e.id')
        .where('e.target', '=', target)
        .where((eb) =>
          eb.or([
            eb.and([
              eb('e.status', '=', 'PENDING'),
              eb('e.next_attempt_at', '<=', sql<Date>`now()`),
            ]),
            eb.and([
              eb('e.status', '=', 'PROCESSING'),
              eb('e.locked_until', '<', sql<Date>`now()`),
            ]),
          ]),
        )
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('integration_event as p')
                .select('p.id')
                .whereRef('p.target', '=', 'e.target')
                .whereRef('p.aggregate_type', '=', 'e.aggregate_type')
                .whereRef('p.aggregate_id', '=', 'e.aggregate_id')
                .whereRef('p.id', '<', 'e.id')
                .where('p.status', 'in', ['PENDING', 'PROCESSING', 'DEAD']),
            ),
          ),
        )
        .orderBy('e.id')
        .limit(INTEGRATION_POLICY.batchSize)
        .forUpdate()
        .skipLocked()
        .execute();
      if (due.length === 0) return [];
      return tx
        .updateTable('integration_event')
        .set({
          status: 'PROCESSING',
          attempts: sql<number>`attempts + 1`,
          locked_until: sql<Date>`now() + make_interval(secs => ${INTEGRATION_POLICY.leaseSeconds})`,
          locked_by: this.owner,
        })
        .where(
          'id',
          'in',
          due.map((d) => d.id),
        )
        .returning(['id', 'event_type', 'aggregate_id', 'attempts'])
        .execute()
        .then((rows) => rows.sort((a, b) => a.id - b.id));
    });
  }

  private async deliverOne(
    target: IntegrationTarget,
    event: ClaimedEvent,
    requestId: string,
  ): Promise<'DELIVERED' | 'FAILED' | 'TARGET_PAUSED'> {
    const type = event.event_type as IntegrationEventType;
    if (!(type in INTEGRATION_EVENT_TYPES)) {
      await this.finish(event, 'DEAD', `Unknown event type ${event.event_type}`, null);
      return 'FAILED';
    }
    try {
      const outcome = await this.zoho.deliver(
        type,
        event.aggregate_id,
        INTEGRATION_CONTEXT(`${requestId}:${String(event.id)}`),
      );
      await this.finish(event, 'SUCCEEDED', outcome.note, null);
      await this.recordSuccess(target);
      return 'DELIVERED';
    } catch (error) {
      const failure =
        error instanceof IntegrationError
          ? error
          : new IntegrationError('RETRYABLE', `Unexpected error: ${String(error)}`);
      if (!(error instanceof IntegrationError)) {
        this.logger.error(
          `Integration event ${String(event.id)} failed unexpectedly`,
          error instanceof Error ? error.stack : String(error),
        );
      }
      return this.handleFailure(target, event, failure);
    }
  }

  private async handleFailure(
    target: IntegrationTarget,
    event: ClaimedEvent,
    failure: IntegrationError,
  ): Promise<'FAILED' | 'TARGET_PAUSED'> {
    const pauseFor = (kind: FailureKind): number | null => {
      if (kind === 'RATE_LIMITED') return failure.retryAfterSeconds ?? 60;
      if (kind === 'CREDENTIALS' || kind === 'CONFIGURATION') {
        return INTEGRATION_POLICY.setupPauseSeconds;
      }
      return null;
    };
    const pause = pauseFor(failure.kind);
    if (pause !== null) {
      // Not the event's fault: it goes back unchanged (the attempt is not counted).
      await this.db
        .updateTable('integration_event')
        .set({
          status: 'PENDING',
          attempts: sql<number>`greatest(attempts - 1, 0)`,
          next_attempt_at: sql<Date>`now() + make_interval(secs => ${pause})`,
          locked_until: null,
          locked_by: null,
          last_error: failure.message.slice(0, 1000),
          last_http_status: failure.httpStatus,
        })
        .where('id', '=', event.id)
        .execute();
      await this.pauseTarget(target, pause, `${failure.kind}: ${failure.message}`);
      this.logger.warn(`${target} paused for ${String(pause)}s: ${failure.message}`);
      return 'TARGET_PAUSED';
    }

    if (failure.kind === 'PERMANENT' || event.attempts >= INTEGRATION_POLICY.maxAttempts) {
      await this.finish(event, 'DEAD', failure.message, failure.httpStatus);
      this.logger.error(`Integration event ${String(event.id)} is DEAD: ${failure.message}`);
    } else {
      const minutes =
        INTEGRATION_POLICY.backoffMinutes[event.attempts - 1] ??
        INTEGRATION_POLICY.backoffMinutes.at(-1) ??
        60;
      await this.db
        .updateTable('integration_event')
        .set({
          status: 'PENDING',
          next_attempt_at: sql<Date>`now() + make_interval(mins => ${minutes})`,
          locked_until: null,
          locked_by: null,
          last_error: failure.message.slice(0, 1000),
          last_http_status: failure.httpStatus,
        })
        .where('id', '=', event.id)
        .execute();
    }
    const failures = await this.recordFailure(target);
    if (failures >= INTEGRATION_POLICY.breakerThreshold) {
      await this.pauseTarget(
        target,
        INTEGRATION_POLICY.breakerPauseSeconds,
        `${String(failures)} consecutive failures: ${failure.message}`,
      );
      return 'TARGET_PAUSED';
    }
    return 'FAILED';
  }

  private async finish(
    event: ClaimedEvent,
    status: 'SUCCEEDED' | 'DEAD',
    note: string,
    httpStatus: number | null,
  ): Promise<void> {
    await this.db
      .updateTable('integration_event')
      .set({
        status,
        processed_at: sql<Date>`now()`,
        locked_until: null,
        locked_by: null,
        last_error: status === 'DEAD' ? note.slice(0, 1000) : null,
        last_http_status: httpStatus,
        resolution_note: status === 'SUCCEEDED' ? note.slice(0, 500) : null,
      })
      .where('id', '=', event.id)
      .execute();
  }

  private async release(events: ClaimedEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.db
      .updateTable('integration_event')
      .set({
        status: 'PENDING',
        attempts: sql<number>`greatest(attempts - 1, 0)`,
        locked_until: null,
        locked_by: null,
      })
      .where(
        'id',
        'in',
        events.map((e) => e.id),
      )
      .where('status', '=', 'PROCESSING')
      .execute();
  }

  private async pauseTarget(target: IntegrationTarget, seconds: number, reason: string) {
    await this.db
      .updateTable('integration_target_state')
      .set({
        paused_until: sql<Date>`now() + make_interval(secs => ${seconds})`,
        pause_reason: reason.slice(0, 300),
      })
      .where('target', '=', target)
      .execute();
  }

  private async recordSuccess(target: IntegrationTarget): Promise<void> {
    await this.db
      .updateTable('integration_target_state')
      .set({ consecutive_failures: 0, last_success_at: sql<Date>`now()`, pause_reason: null })
      .where('target', '=', target)
      .execute();
  }

  private async recordFailure(target: IntegrationTarget): Promise<number> {
    const row = await this.db
      .updateTable('integration_target_state')
      .set({
        consecutive_failures: sql<number>`consecutive_failures + 1`,
        last_failure_at: sql<Date>`now()`,
      })
      .where('target', '=', target)
      .returning('consecutive_failures')
      .executeTakeFirstOrThrow();
    return row.consecutive_failures;
  }
}
