import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { Clock } from '../common/clock.js';
import { BusinessRuleError, NotFoundError, ValidationError } from '../common/errors.js';
import type { ActionContext } from '../database/action-context.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { inTransaction, type Tx } from '../database/transaction.js';
import { keyReusedError, type IdempotentRequest } from '../common/http/idempotency.js';
import { IntegrationOutbox } from '../integrations/integration-outbox.service.js';

export const SUPPORT_CATEGORIES = [
  'SERVICE_QUALITY',
  'LATE_ARRIVAL',
  'NO_SHOW',
  'BILLING',
  'REFUND',
  'DAMAGE',
  'BEHAVIOUR',
  'APP_ISSUE',
  'WORKER_PAYOUT',
  'OTHER',
] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

export const SUPPORT_STATUSES = [
  'OPEN',
  'IN_PROGRESS',
  'WAITING_ON_CUSTOMER',
  'RESOLVED',
  'CLOSED',
] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

export interface NewCase {
  readonly bookingId: string | null;
  readonly category: SupportCategory;
  readonly subject: string;
  readonly description: string;
  readonly desiredResolution: string | null;
}

/** Target first response by severity (hours). */
const FIRST_UPDATE_HOURS = { LOW: 24, MEDIUM: 8, HIGH: 2 } as const;

@Injectable()
export class SupportService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly clock: Clock,
    private readonly outbox: IntegrationOutbox,
  ) {}

  /**
   * Opens a case. With the same idempotency key as an earlier request from the same person,
   * returns that case (`replayed: true`) instead of opening a second one.
   */
  async open(
    context: ActionContext,
    raisedBy: 'CUSTOMER' | 'WORKER' | 'STAFF',
    input: NewCase,
    idempotency: IdempotentRequest,
  ) {
    const userId = context.actorUserId;
    if (!userId) throw new ValidationError('ACTOR_REQUIRED', 'Sign in required');
    return inTransaction(this.db, context, async (tx) => {
      const earlier = await this.findByKey(tx, userId, idempotency);
      if (earlier) return earlier;

      if (input.bookingId) {
        const booking = await tx
          .selectFrom('booking')
          .select(['customer_user_id'])
          .where('id', '=', input.bookingId)
          .executeTakeFirst();
        const ownsIt = raisedBy !== 'CUSTOMER' || booking?.customer_user_id === userId;
        if (!booking || !ownsIt) throw new NotFoundError('Booking', input.bookingId);
      }
      const severity =
        input.category === 'DAMAGE' || input.category === 'BEHAVIOUR' ? 'HIGH' : 'MEDIUM';
      const row = await tx
        .insertInto('support_case')
        .values({
          booking_id: input.bookingId,
          raised_by_user_id: userId,
          raised_by_role: raisedBy,
          source: context.source,
          category: input.category,
          severity,
          subject: input.subject,
          description: input.description,
          desired_resolution: input.desiredResolution,
          next_update_due_at: new Date(
            this.clock.now().getTime() + FIRST_UPDATE_HOURS[severity] * 3_600_000,
          ),
          idempotency_key: idempotency.key,
          request_hash: idempotency.hash,
        })
        .onConflict((oc) => oc.columns(['raised_by_user_id', 'idempotency_key']).doNothing())
        .returning(['id', 'case_code', 'status', 'next_update_due_at'])
        .executeTakeFirst();
      if (!row) {
        // A simultaneous retry with the same key committed first.
        const winner = await this.findByKey(tx, userId, idempotency);
        if (!winner) throw new Error('Idempotent support case vanished');
        return winner;
      }
      await tx
        .insertInto('support_case_event')
        .values({
          case_id: row.id,
          event_type: 'MESSAGE_FROM_CUSTOMER',
          to_status: 'OPEN',
          body: input.description,
          is_internal: false,
          actor_user_id: userId,
          source: context.source,
        })
        .execute();
      // The support desk learns about the case after commit; its availability never
      // decides whether a customer can raise one.
      await this.outbox.enqueue(tx, 'DESK_CASE_CREATE', row.id, {
        requestId: context.requestId,
        onceKey: row.id,
      });
      return {
        id: row.id,
        caseCode: row.case_code,
        status: row.status,
        nextUpdateDueAt: row.next_update_due_at?.toISOString() ?? null,
        replayed: false,
      };
    });
  }

  private async findByKey(tx: Tx, userId: string, idempotency: IdempotentRequest) {
    const row = await tx
      .selectFrom('support_case')
      .select(['id', 'case_code', 'status', 'next_update_due_at', 'request_hash'])
      .where('raised_by_user_id', '=', userId)
      .where('idempotency_key', '=', idempotency.key)
      .executeTakeFirst();
    if (!row) return null;
    if (row.request_hash !== idempotency.hash) throw keyReusedError();
    return {
      id: row.id,
      caseCode: row.case_code,
      status: row.status,
      nextUpdateDueAt: row.next_update_due_at?.toISOString() ?? null,
      replayed: true,
    };
  }

  async listForRaiser(userId: string) {
    const rows = await this.db
      .selectFrom('support_case')
      .select([
        'id',
        'case_code',
        'booking_id',
        'category',
        'subject',
        'status',
        'opened_at',
        'resolution_summary',
      ])
      .where('raised_by_user_id', '=', userId)
      .orderBy('opened_at', 'desc')
      .limit(50)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      caseCode: r.case_code,
      bookingId: r.booking_id,
      category: r.category,
      subject: r.subject,
      status: r.status,
      openedAt: r.opened_at.toISOString(),
      resolution: r.resolution_summary,
    }));
  }

  async list(filter: { status: SupportStatus | null; limit: number }) {
    return this.db
      .selectFrom('support_case')
      .select([
        'id',
        'case_code',
        'booking_id',
        'category',
        'severity',
        'subject',
        'status',
        'owner_user_id',
        'next_update_due_at',
        'opened_at',
      ])
      .$if(filter.status !== null, (qb) => qb.where('status', '=', filter.status ?? 'OPEN'))
      .orderBy('next_update_due_at')
      .limit(filter.limit)
      .execute();
  }

  async detail(caseId: string) {
    const row = await this.db
      .selectFrom('support_case')
      .selectAll()
      .where('id', '=', caseId)
      .executeTakeFirst();
    if (!row) throw new NotFoundError('Support case', caseId);
    const events = await this.db
      .selectFrom('support_case_event')
      .select([
        'event_type',
        'from_status',
        'to_status',
        'body',
        'is_internal',
        'actor_user_id',
        'source',
        'occurred_at',
      ])
      .where('case_id', '=', caseId)
      .orderBy('id')
      .execute();
    return { ...row, events };
  }

  /** A staff action on a case: note, status change or owner change — each recorded. */
  /**
   * Applies a status decided in the external support desk (Zoho Desk). Closed cases are
   * left alone; returns whether anything changed. The update is visible to the raiser.
   */
  async applyExternalStatus(
    context: ActionContext,
    caseId: string,
    update: { status: SupportStatus; resolution: string; reference: string },
  ): Promise<boolean> {
    return inTransaction(this.db, context, async (tx) => {
      const current = await tx
        .selectFrom('support_case')
        .select(['status'])
        .where('id', '=', caseId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw new NotFoundError('Support case', caseId);
      if (current.status === 'CLOSED' || current.status === update.status) return false;
      const resolving = update.status === 'RESOLVED' || update.status === 'CLOSED';
      const reopening = current.status === 'RESOLVED' && !resolving;
      await tx
        .updateTable('support_case')
        .set({
          status: update.status,
          ...(resolving
            ? { resolution_summary: update.resolution, resolved_at: this.clock.now() }
            : {}),
          ...(reopening ? { resolved_at: null } : {}),
          ...(update.status === 'CLOSED' ? { closed_at: this.clock.now() } : {}),
        })
        .where('id', '=', caseId)
        .execute();
      await tx
        .insertInto('support_case_event')
        .values({
          case_id: caseId,
          event_type: 'STATUS_CHANGE',
          from_status: current.status,
          to_status: update.status,
          body: resolving ? update.resolution : `Updated by the support team (${update.reference})`,
          is_internal: false,
          actor_user_id: null,
          source: context.source,
        })
        .execute();
      return true;
    });
  }

  async act(
    context: ActionContext,
    caseId: string,
    input: {
      note: string | null;
      status: SupportStatus | null;
      ownerUserId: string | null;
      resolution: string | null;
      internal: boolean;
    },
  ) {
    await inTransaction(this.db, context, async (tx) => {
      const current = await tx
        .selectFrom('support_case')
        .select(['status', 'owner_user_id'])
        .where('id', '=', caseId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw new NotFoundError('Support case', caseId);
      if (current.status === 'CLOSED')
        throw new BusinessRuleError('CASE_CLOSED', 'This case is closed');

      if (input.status && input.status !== current.status) {
        // One owner per case status: once a case has a Zoho Desk ticket, agents work it
        // there and its status flows back here. Notes can still be added in One Tappe.
        const managedInDesk = await tx
          .selectFrom('external_link')
          .select('external_ref')
          .where('target', '=', 'ZOHO_DESK')
          .where('entity_type', '=', 'support_case')
          .where('internal_id', '=', caseId)
          .executeTakeFirst();
        if (managedInDesk) {
          throw new BusinessRuleError(
            'CASE_MANAGED_IN_ZOHO_DESK',
            `Change the status in Zoho Desk (ticket ${managedInDesk.external_ref ?? ''}); it is reflected here automatically.`,
          );
        }
        const resolving = input.status === 'RESOLVED' || input.status === 'CLOSED';
        if (resolving && !input.resolution)
          throw new ValidationError('RESOLUTION_REQUIRED', 'Describe the resolution');
        await tx
          .updateTable('support_case')
          .set({
            status: input.status,
            ...(resolving
              ? { resolution_summary: input.resolution, resolved_at: this.clock.now() }
              : {}),
            ...(input.status === 'CLOSED' ? { closed_at: this.clock.now() } : {}),
          })
          .where('id', '=', caseId)
          .execute();
        await tx
          .insertInto('support_case_event')
          .values({
            case_id: caseId,
            event_type: 'STATUS_CHANGE',
            from_status: current.status,
            to_status: input.status,
            body: input.resolution ?? input.note,
            is_internal: input.internal,
            actor_user_id: context.actorUserId,
            source: context.source,
          })
          .execute();
      }
      if (input.ownerUserId && input.ownerUserId !== current.owner_user_id) {
        await tx
          .updateTable('support_case')
          .set({ owner_user_id: input.ownerUserId })
          .where('id', '=', caseId)
          .execute();
        await tx
          .insertInto('support_case_event')
          .values({
            case_id: caseId,
            event_type: 'OWNER_CHANGE',
            body: input.ownerUserId,
            is_internal: true,
            actor_user_id: context.actorUserId,
            source: context.source,
          })
          .execute();
      }
      if (input.note && !input.status) {
        await tx
          .insertInto('support_case_event')
          .values({
            case_id: caseId,
            event_type: input.internal ? 'NOTE' : 'MESSAGE_TO_CUSTOMER',
            body: input.note,
            is_internal: input.internal,
            actor_user_id: context.actorUserId,
            source: context.source,
          })
          .execute();
      }
    });
    return this.detail(caseId);
  }
}
