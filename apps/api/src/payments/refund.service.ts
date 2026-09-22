import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { BookingNotifier } from '../booking/booking-notifier.service.js';
import { Clock } from '../common/clock.js';
import { BusinessRuleError, NotFoundError, ValidationError } from '../common/errors.js';
import type { ActionContext } from '../database/action-context.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { inTransaction, type Tx } from '../database/transaction.js';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
  type ProviderEvent,
} from './providers/payment-provider.js';

export type RefundReason =
  | 'CUSTOMER_CANCELLED'
  | 'COMPANY_CANCELLED'
  | 'NO_WORKER_AVAILABLE'
  | 'WORKER_NO_SHOW'
  | 'SERVICE_ISSUE'
  | 'DUPLICATE_PAYMENT'
  | 'PAYMENT_AFTER_EXPIRY'
  | 'GOODWILL'
  | 'OTHER';

export interface RefundRequest {
  readonly bookingId: string;
  /** Specific payment; default: the booking's captured (non-duplicate) payment. */
  readonly paymentId?: string;
  /** Null = everything still refundable on the payment. */
  readonly amountPaise: number | null;
  readonly reasonCode: RefundReason;
  readonly reasonText: string;
  /**
   * When set, the refund is approved by this named policy (e.g. a company cancellation
   * always refunds in full). Otherwise it waits for a finance approver.
   */
  readonly autoApprovePolicy?: string;
}

/**
 * Refund lifecycle: REQUESTED → APPROVED (by a second person or a named policy) →
 * PROCESSING at the gateway → PROCESSED / FAILED (retried). The database refuses refunds
 * above the captured amount and self-approval.
 */
@Injectable()
export class RefundService {
  private readonly logger = new Logger('Refunds');

  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly notifier: BookingNotifier,
    private readonly clock: Clock,
  ) {}

  /** Creates a refund request inside the caller's transaction. Returns its id or null (nothing to refund). */
  async requestInTx(
    tx: Tx,
    context: ActionContext,
    request: RefundRequest,
  ): Promise<string | null> {
    const payment = await tx
      .selectFrom('payment')
      .select(['id', 'amount_paise', 'captured_amount_paise'])
      .where('booking_id', '=', request.bookingId)
      .where('status', '=', 'CAPTURED')
      .$if(request.paymentId !== undefined, (qb) => qb.where('id', '=', request.paymentId ?? ''))
      .$if(request.paymentId === undefined, (qb) => qb.where('is_duplicate', '=', false))
      .executeTakeFirst();
    if (!payment) return null;

    const refunded = await tx
      .selectFrom('refund')
      .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('amount_paise'), sql<number>`0`).as('total'))
      .where('payment_id', '=', payment.id)
      .where('status', '<>', 'REJECTED')
      .executeTakeFirstOrThrow();
    const captured = payment.captured_amount_paise ?? payment.amount_paise;
    const remaining = captured - refunded.total;
    const amount = request.amountPaise ?? remaining;
    if (amount <= 0) return null;
    if (amount > remaining) {
      throw new BusinessRuleError(
        'REFUND_TOO_LARGE',
        `At most ${remaining} paise can still be refunded`,
      );
    }

    const now = this.clock.now();
    const auto = request.autoApprovePolicy;
    const refund = await tx
      .insertInto('refund')
      .values({
        booking_id: request.bookingId,
        payment_id: payment.id,
        amount_paise: amount,
        reason_code: request.reasonCode,
        reason_text: request.reasonText,
        requested_by: context.actorUserId,
        requested_source: context.source,
        idempotency_key: `refund:${randomUUID()}`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (auto) {
      await tx
        .updateTable('refund')
        .set({ status: 'APPROVED', decision_policy: auto, decided_at: now })
        .where('id', '=', refund.id)
        .execute();
    }
    return refund.id;
  }

  /** Finance approves a request; it is then sent to the gateway. */
  async approve(refundId: string, context: ActionContext, note: string | null): Promise<void> {
    await inTransaction(this.db, context, (tx) =>
      this.decide(tx, refundId, context, { status: 'APPROVED', decision_note: note }),
    );
    await this.initiate(refundId, context.requestId);
  }

  async reject(refundId: string, context: ActionContext, note: string): Promise<void> {
    if (!note.trim())
      throw new ValidationError('REASON_REQUIRED', 'Explain why the refund is rejected');
    await inTransaction(this.db, context, (tx) =>
      this.decide(tx, refundId, context, { status: 'REJECTED', decision_note: note.trim() }),
    );
  }

  /**
   * Sends an approved refund to the gateway. Safe to repeat: it first asks the gateway
   * whether this refund (by our reference) already exists before creating one.
   */
  async initiate(refundId: string, requestId: string): Promise<void> {
    const context: ActionContext = {
      actorUserId: null,
      actorRole: 'SYSTEM',
      source: 'SYSTEM',
      requestId,
    };
    const claimed = await inTransaction(this.db, context, async (tx) => {
      const refund = await tx
        .selectFrom('refund as r')
        .innerJoin('payment as p', 'p.id', 'r.payment_id')
        .select([
          'r.id',
          'r.status',
          'r.amount_paise',
          'r.booking_id',
          'p.provider_payment_id',
          'p.provider',
        ])
        .where('r.id', '=', refundId)
        .forUpdate('r')
        .executeTakeFirst();
      if (!refund || !['APPROVED', 'FAILED'].includes(refund.status)) return null;
      if (refund.provider === 'CASH' || !refund.provider_payment_id) {
        throw new BusinessRuleError(
          'REFUND_NEEDS_MANUAL_PAYOUT',
          'This payment was not made through the gateway',
        );
      }
      await tx
        .updateTable('refund')
        .set({ status: 'PROCESSING', failure_reason: null })
        .where('id', '=', refundId)
        .execute();
      await this.notifier.toCustomer(tx, refund.booking_id, 'REFUND_INITIATED', {
        dedupeSuffix: refundId,
        extra: { amount: refund.amount_paise },
      });
      return refund;
    });
    if (!claimed?.provider_payment_id) return;

    try {
      const result =
        (await this.provider.findRefund(claimed.provider_payment_id, refundId)) ??
        (await this.provider.createRefund(
          claimed.provider_payment_id,
          claimed.amount_paise,
          refundId,
        ));
      await inTransaction(this.db, context, async (tx) => {
        await tx
          .updateTable('refund')
          .set({ provider_refund_id: result.providerRefundId })
          .where('id', '=', refundId)
          .execute();
        if (result.state !== 'PROCESSING') {
          await this.settle(tx, refundId, result.state, result.failureReason);
        }
      });
    } catch (error) {
      this.logger.warn(`Refund ${refundId} could not be sent to the gateway: ${String(error)}`);
      await inTransaction(this.db, context, (tx) =>
        tx
          .updateTable('refund')
          .set({
            status: 'FAILED',
            failure_reason: error instanceof Error ? error.message.slice(0, 300) : 'Gateway error',
          })
          .where('id', '=', refundId)
          .where('status', '=', 'PROCESSING')
          .execute(),
      );
    }
  }

  /** Background job: sends approved refunds and retries failed or unconfirmed ones. */
  async processPending(requestId: string, limit = 50): Promise<number> {
    const due = await this.db
      .selectFrom('refund')
      .select('id')
      .where((eb) =>
        eb.or([
          eb('status', '=', 'APPROVED'),
          eb.and([
            eb('status', '=', 'FAILED'),
            eb('updated_at', '<', sql<Date>`now() - interval '15 minutes'`),
          ]),
        ]),
      )
      .orderBy('created_at')
      .limit(limit)
      .execute();
    for (const { id } of due) await this.initiate(id, requestId);

    // Refunds sent but never confirmed (lost webhook, crash): ask the gateway.
    const stuck = await this.db
      .selectFrom('refund as r')
      .innerJoin('payment as p', 'p.id', 'r.payment_id')
      .select(['r.id', 'p.provider_payment_id'])
      .where('r.status', '=', 'PROCESSING')
      .where('r.updated_at', '<', sql<Date>`now() - interval '10 minutes'`)
      .limit(limit)
      .execute();
    for (const refund of stuck) {
      if (!refund.provider_payment_id) continue;
      const found = await this.provider.findRefund(refund.provider_payment_id, refund.id);
      const context: ActionContext = {
        actorUserId: null,
        actorRole: 'SYSTEM',
        source: 'SYSTEM',
        requestId,
      };
      await inTransaction(this.db, context, async (tx) => {
        if (!found) {
          await tx
            .updateTable('refund')
            .set({ status: 'FAILED', failure_reason: 'Not found at gateway' })
            .where('id', '=', refund.id)
            .execute();
        } else if (found.state !== 'PROCESSING') {
          await tx
            .updateTable('refund')
            .set({ provider_refund_id: found.providerRefundId })
            .where('id', '=', refund.id)
            .execute();
          await this.settle(tx, refund.id, found.state, found.failureReason);
        }
      });
    }
    return due.length + stuck.length;
  }

  /** Applies a refund.processed / refund.failed gateway event. */
  async applyGatewayOutcome(
    tx: Tx,
    event: ProviderEvent,
    _context: ActionContext,
  ): Promise<string | null> {
    const refund = await tx
      .selectFrom('refund')
      .select(['id', 'status'])
      .where((eb) =>
        eb.or([
          eb('provider_refund_id', '=', event.providerRefundId ?? ''),
          eb(
            'id',
            '=',
            isUuid(event.refundReference)
              ? event.refundReference
              : '00000000-0000-0000-0000-000000000000',
          ),
        ]),
      )
      .forUpdate()
      .executeTakeFirst();
    if (!refund) return 'UNKNOWN_REFUND';
    if (refund.status === 'PROCESSED') return null;
    if (event.providerRefundId) {
      await tx
        .updateTable('refund')
        .set({ provider_refund_id: event.providerRefundId })
        .where('id', '=', refund.id)
        .execute();
    }
    if (refund.status !== 'PROCESSING') {
      // The gateway settled a refund we had not marked as sent (e.g. crash): align first.
      await tx
        .updateTable('refund')
        .set({ status: 'PROCESSING' })
        .where('id', '=', refund.id)
        .where('status', 'in', ['FAILED'])
        .execute();
    }
    await this.settle(
      tx,
      refund.id,
      event.type === 'REFUND_PROCESSED' ? 'PROCESSED' : 'FAILED',
      event.failureReason,
    );
    await tx
      .updateTable('payment_event')
      .set({ refund_id: refund.id })
      .where('provider_event_id', '=', event.eventId)
      .execute();
    return null;
  }

  private async settle(
    tx: Tx,
    refundId: string,
    state: 'PROCESSED' | 'FAILED',
    failureReason: string | null,
  ): Promise<void> {
    const updated = await tx
      .updateTable('refund')
      .set(
        state === 'PROCESSED'
          ? { status: 'PROCESSED', processed_at: this.clock.now() }
          : { status: 'FAILED', failure_reason: failureReason ?? 'Refund failed at gateway' },
      )
      .where('id', '=', refundId)
      .where('status', '=', 'PROCESSING')
      .returning(['booking_id', 'amount_paise'])
      .executeTakeFirst();
    if (updated && state === 'PROCESSED') {
      await this.notifier.toCustomer(tx, updated.booking_id, 'REFUND_COMPLETED', {
        dedupeSuffix: refundId,
        extra: { amount: updated.amount_paise },
      });
    }
  }

  private async decide(
    tx: Tx,
    refundId: string,
    context: ActionContext,
    decision: { status: 'APPROVED' | 'REJECTED'; decision_note: string | null },
  ): Promise<void> {
    const refund = await tx
      .selectFrom('refund')
      .select(['status'])
      .where('id', '=', refundId)
      .forUpdate()
      .executeTakeFirst();
    if (!refund) throw new NotFoundError('Refund', refundId);
    if (refund.status !== 'REQUESTED') {
      throw new BusinessRuleError(
        'REFUND_ALREADY_DECIDED',
        `This refund is already ${refund.status}`,
      );
    }
    await tx
      .updateTable('refund')
      .set({ ...decision, decided_by: context.actorUserId, decided_at: this.clock.now() })
      .where('id', '=', refundId)
      .execute();
  }
}

function isUuid(value: string | null): value is string {
  return (
    value !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}
