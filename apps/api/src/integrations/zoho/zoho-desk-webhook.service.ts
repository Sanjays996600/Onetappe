import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { NotFoundError, UnauthorizedError } from '../../common/errors.js';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import type { ActionContext } from '../../database/action-context.js';
import { DATABASE } from '../../database/database.module.js';
import type { DB } from '../../database/db.generated.js';
import { inTransaction } from '../../database/transaction.js';
import { safeEqual } from '../../security/crypto.js';
import { IntegrationOutbox } from '../integration-outbox.service.js';

/**
 * Zoho Desk webhooks tell us "a ticket changed". The call must carry our shared secret,
 * and even then its content is not trusted: we only take ticket ids from it and read the
 * tickets from Zoho over our own authenticated API connection (DESK_CASE_PULL). A forged
 * call can at most trigger a harmless re-read.
 */
@Injectable()
export class ZohoDeskWebhookService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    @Inject(ENV) private readonly env: Env,
    private readonly outbox: IntegrationOutbox,
  ) {}

  async receive(
    presentedKey: string | undefined,
    payload: unknown,
    requestId: string,
  ): Promise<{ received: number }> {
    if (!this.env.ZOHO_DESK_ENABLED) throw new NotFoundError('Route', 'zoho-desk webhook');
    const expected = this.env.ZOHO_DESK_WEBHOOK_SECRET ?? '';
    if (!presentedKey || !expected || !safeEqual(presentedKey, expected)) {
      throw new UnauthorizedError('WEBHOOK_KEY_INVALID', 'Webhook key missing or invalid');
    }
    const ticketIds = [...new Set(extractTicketIds(payload))].slice(0, 100);
    const context: ActionContext = {
      actorUserId: null,
      actorRole: 'SYSTEM',
      source: 'INTEGRATION',
      requestId,
    };
    return inTransaction(this.db, context, async (tx) => {
      const inbound = await tx
        .insertInto('integration_inbound_event')
        .values({
          source: 'ZOHO_DESK',
          payload: JSON.stringify(payload ?? null),
          external_ids: ticketIds,
          request_id: requestId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      if (ticketIds.length === 0) return { received: 0 };
      const cases = await tx
        .selectFrom('external_link')
        .select('internal_id')
        .where('target', '=', 'ZOHO_DESK')
        .where('entity_type', '=', 'support_case')
        .where('external_id', 'in', ticketIds)
        .execute();
      for (const { internal_id } of cases) {
        await this.outbox.enqueue(tx, 'DESK_CASE_PULL', internal_id, {
          requestId,
          payload: { inboundEventId: String(inbound.id) },
        });
      }
      return { received: cases.length };
    });
  }
}

/** Ticket ids from a Desk webhook body (an array of events, or a single event). */
export function extractTicketIds(payload: unknown): string[] {
  const events = Array.isArray(payload) ? payload : [payload];
  const ids: string[] = [];
  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue;
    const record = event as Record<string, unknown>;
    const inner = record['payload'];
    const candidates = [
      typeof inner === 'object' && inner !== null ? (inner as Record<string, unknown>)['id'] : null,
      record['ticketId'],
      record['id'],
    ];
    const id = candidates.find((c) => typeof c === 'string' || typeof c === 'number');
    if (typeof id === 'string' || typeof id === 'number') {
      if (/^\d{1,30}$/.test(String(id))) ids.push(String(id));
    }
  }
  return ids;
}
