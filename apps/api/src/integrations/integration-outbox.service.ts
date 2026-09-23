import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import type { Tx } from '../database/transaction.js';

export const INTEGRATION_TARGETS = ['ZOHO_CRM', 'ZOHO_DESK'] as const;
export type IntegrationTarget = (typeof INTEGRATION_TARGETS)[number];

export type AggregateType = 'customer' | 'worker' | 'booking' | 'support_case' | 'safety_incident';

/** Everything the integration worker knows how to deliver. */
export const INTEGRATION_EVENT_TYPES = {
  /** Upsert the customer as a Zoho CRM contact. */
  CRM_CUSTOMER_SYNC: { target: 'ZOHO_CRM', aggregate: 'customer', coalescible: true },
  /** Upsert the booking into the configured CRM module (if one is configured). */
  CRM_BOOKING_SYNC: { target: 'ZOHO_CRM', aggregate: 'booking', coalescible: true },
  /** Create the Zoho Desk ticket for a new support case (exactly once). */
  DESK_CASE_CREATE: { target: 'ZOHO_DESK', aggregate: 'support_case', coalescible: false },
  /** Read the case's ticket from Zoho Desk and apply its status here. */
  DESK_CASE_PULL: { target: 'ZOHO_DESK', aggregate: 'support_case', coalescible: true },
  /** Create a reference ticket for a safety escalation (if enabled in settings). */
  DESK_SAFETY_CREATE: { target: 'ZOHO_DESK', aggregate: 'safety_incident', coalescible: false },
} as const satisfies Record<
  string,
  { target: IntegrationTarget; aggregate: AggregateType; coalescible: boolean }
>;

export type IntegrationEventType = keyof typeof INTEGRATION_EVENT_TYPES;

/**
 * Records "an external system must learn about this change" inside the caller's
 * transaction (transactional outbox). If the business change rolls back, so does the
 * event; if it commits, the integration worker will deliver the event eventually, however
 * long the external system is unavailable. Nothing here calls an external system.
 */
@Injectable()
export class IntegrationOutbox {
  constructor(@Inject(ENV) private readonly env: Env) {}

  isEnabled(target: IntegrationTarget): boolean {
    return target === 'ZOHO_CRM' ? this.env.ZOHO_CRM_ENABLED : this.env.ZOHO_DESK_ENABLED;
  }

  /**
   * Queues an event. `onceKey` makes a one-off event idempotent (e.g. the ticket for a
   * case is requested once, however often the caller runs). Sync events coalesce: while
   * one is pending for the same record, another adds nothing.
   */
  async enqueue(
    tx: Tx,
    type: IntegrationEventType,
    aggregateId: string,
    options: { requestId: string; onceKey?: string; payload?: Record<string, string> },
  ): Promise<void> {
    const spec = INTEGRATION_EVENT_TYPES[type];
    if (!this.isEnabled(spec.target)) return;
    const dedupeKey = options.onceKey
      ? `${type}:${options.onceKey}`
      : `${type}:${aggregateId}:${randomUUID()}`;
    let insert = tx.insertInto('integration_event').values({
      target: spec.target,
      event_type: type,
      aggregate_type: spec.aggregate,
      aggregate_id: aggregateId,
      payload: JSON.stringify(options.payload ?? {}),
      dedupe_key: dedupeKey,
      coalescible: spec.coalescible,
      request_id: options.requestId,
    });
    insert = spec.coalescible
      ? insert.onConflict((oc) =>
          oc
            .columns(['target', 'event_type', 'aggregate_id'])
            .where('status', '=', 'PENDING')
            .where('coalescible', '=', true)
            .doNothing(),
        )
      : insert.onConflict((oc) => oc.column('dedupe_key').doNothing());
    await insert.execute();
  }
}
