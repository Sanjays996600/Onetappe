import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { BusinessRuleError, NotFoundError } from '../common/errors.js';
import type { ActionContext } from '../database/action-context.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { inTransaction } from '../database/transaction.js';
import { IntegrationOutbox, INTEGRATION_TARGETS } from './integration-outbox.service.js';

/**
 * What operations needs to see: is each integration healthy, how far behind is it, and
 * which events need a person. Also the only way to retry or discard a DEAD event.
 */
@Injectable()
export class IntegrationMonitor {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly outbox: IntegrationOutbox,
  ) {}

  async status() {
    const counts = await this.db
      .selectFrom('integration_event')
      .select((eb) => [
        'target',
        eb.fn.countAll<number>().filterWhere('status', '=', 'PENDING').as('pending'),
        eb.fn.countAll<number>().filterWhere('status', '=', 'PROCESSING').as('processing'),
        eb.fn.countAll<number>().filterWhere('status', '=', 'DEAD').as('dead'),
        eb.fn
          .min<Date | null>('created_at')
          .filterWhere('status', 'in', ['PENDING', 'PROCESSING'])
          .as('oldestWaitingSince'),
      ])
      .where('status', 'in', ['PENDING', 'PROCESSING', 'DEAD'])
      .groupBy('target')
      .execute();
    const states = await this.db.selectFrom('integration_target_state').selectAll().execute();
    const credential = await this.db
      .selectFrom('integration_credential')
      .select(['expires_at', 'refreshed_at', 'last_error', 'last_error_at'])
      .where('provider', '=', 'ZOHO')
      .executeTakeFirst();

    return {
      targets: INTEGRATION_TARGETS.map((target) => {
        const c = counts.find((row) => row.target === target);
        const s = states.find((row) => row.target === target);
        const paused = s?.paused_until && s.paused_until > new Date() ? s.paused_until : null;
        return {
          target,
          enabled: this.outbox.isEnabled(target),
          healthy: this.outbox.isEnabled(target) && !paused && (c?.dead ?? 0) === 0,
          pending: c?.pending ?? 0,
          processing: c?.processing ?? 0,
          dead: c?.dead ?? 0,
          oldestWaitingSince: c?.oldestWaitingSince?.toISOString() ?? null,
          pausedUntil: paused?.toISOString() ?? null,
          pauseReason: paused ? (s?.pause_reason ?? null) : null,
          consecutiveFailures: s?.consecutive_failures ?? 0,
          lastSuccessAt: s?.last_success_at?.toISOString() ?? null,
          lastFailureAt: s?.last_failure_at?.toISOString() ?? null,
        };
      }),
      zohoToken: {
        expiresAt: credential?.expires_at?.toISOString() ?? null,
        refreshedAt: credential?.refreshed_at?.toISOString() ?? null,
        lastError: credential?.last_error ?? null,
        lastErrorAt: credential?.last_error_at?.toISOString() ?? null,
      },
    };
  }

  async events(filter: {
    status?: string | undefined;
    target?: string | undefined;
    limit: number;
  }) {
    return this.db
      .selectFrom('integration_event')
      .select([
        'id',
        'target',
        'event_type',
        'aggregate_type',
        'aggregate_id',
        'status',
        'attempts',
        'next_attempt_at',
        'last_error',
        'last_http_status',
        'created_at',
        'processed_at',
        'resolution_note',
      ])
      .$if(filter.status !== undefined, (qb) => qb.where('status', '=', filter.status ?? ''))
      .$if(filter.target !== undefined, (qb) => qb.where('target', '=', filter.target ?? ''))
      .orderBy('id', 'desc')
      .limit(filter.limit)
      .execute();
  }

  /** Sends a DEAD event again (e.g. after fixing the Zoho configuration). Audited. */
  async retry(eventId: number, note: string, context: ActionContext): Promise<void> {
    await this.resolve(eventId, note, context, 'PENDING');
  }

  /** Gives up on a DEAD event deliberately (e.g. the record was handled by hand). Audited. */
  async discard(eventId: number, note: string, context: ActionContext): Promise<void> {
    await this.resolve(eventId, note, context, 'DISCARDED');
  }

  /** Lifts a pause early (after credentials or settings were fixed). Audited. */
  async resume(target: string, note: string, context: ActionContext): Promise<void> {
    await inTransaction(this.db, context, async (tx) => {
      const updated = await tx
        .updateTable('integration_target_state')
        .set({ paused_until: null, pause_reason: null, consecutive_failures: 0 })
        .where('target', '=', target)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) === 0) throw new NotFoundError('Integration', target);
      await tx
        .insertInto('audit_log')
        .values({
          actor_user_id: context.actorUserId,
          actor_role: context.actorRole,
          source: context.source,
          request_id: context.requestId,
          action: 'UPDATE',
          entity_type: 'integration_target_state',
          entity_id: target,
          changed_fields: ['paused_until'],
          reason: note,
        })
        .execute();
    });
  }

  private async resolve(
    eventId: number,
    note: string,
    context: ActionContext,
    to: 'PENDING' | 'DISCARDED',
  ): Promise<void> {
    await inTransaction(this.db, context, async (tx) => {
      const event = await tx
        .selectFrom('integration_event')
        .select(['status'])
        .where('id', '=', eventId)
        .forUpdate()
        .executeTakeFirst();
      if (!event) throw new NotFoundError('Integration event', String(eventId));
      if (event.status !== 'DEAD') {
        throw new BusinessRuleError(
          'EVENT_NOT_DEAD',
          `Only failed (DEAD) events can be retried or discarded; this one is ${event.status}`,
        );
      }
      await tx
        .updateTable('integration_event')
        .set({
          status: to,
          ...(to === 'PENDING' ? { attempts: 0, next_attempt_at: sql<Date>`now()` } : {}),
          resolved_by: context.actorUserId,
          resolution_note: note,
          processed_at: to === 'DISCARDED' ? sql<Date>`now()` : null,
        })
        .where('id', '=', eventId)
        .execute();
      await tx
        .insertInto('audit_log')
        .values({
          actor_user_id: context.actorUserId,
          actor_role: context.actorRole,
          source: context.source,
          request_id: context.requestId,
          action: 'UPDATE',
          entity_type: 'integration_event',
          entity_id: String(eventId),
          changed_fields: ['status'],
          before: JSON.stringify({ status: 'DEAD' }),
          after: JSON.stringify({ status: to }),
          reason: note,
        })
        .execute();
    });
  }
}
