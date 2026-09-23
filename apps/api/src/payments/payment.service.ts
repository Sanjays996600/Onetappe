import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { BookingNotifier } from '../booking/booking-notifier.service.js';
import { BookingTransitionService } from '../booking/booking-transition.service.js';
import { DispatchService } from '../booking/dispatch.service.js';
import { Clock } from '../common/clock.js';
import {
  BusinessRuleError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../common/errors.js';
import type { ActionContext } from '../database/action-context.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { inTransaction, type Tx } from '../database/transaction.js';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
  type OrderStatus,
  type ProviderEvent,
  type ProviderEventType,
} from './providers/payment-provider.js';
import { RefundService } from './refund.service.js';

export interface PaymentInitiation {
  readonly paymentId: string;
  readonly provider: string;
  readonly amountPaise: number;
  readonly payBy: Date;
  /** Data for the app to open the gateway checkout. */
  readonly checkout: Record<string, unknown>;
}

export type WebhookOutcome =
  | { readonly status: 'PROCESSED'; readonly eventId: string }
  | { readonly status: 'DUPLICATE'; readonly eventId: string };

function gatewayContext(requestId: string): ActionContext {
  return { actorUserId: null, actorRole: 'PAYMENT_GATEWAY', source: 'PAYMENT_GATEWAY', requestId };
}

/**
 * Payments are confirmed only by the gateway — through a signed webhook or a server-to-
 * server status check — never because an app says the payment succeeded. Every gateway
 * event is stored once (by its event id), so replays and retries have no effect.
 */
@Injectable()
export class PaymentService {
  private readonly logger = new Logger('Payments');

  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly transitions: BookingTransitionService,
    private readonly dispatch: DispatchService,
    private readonly refunds: RefundService,
    private readonly notifier: BookingNotifier,
    private readonly clock: Clock,
  ) {}

  get providerName(): string {
    return this.provider.name;
  }

  /** Starts (or resumes) payment for a booking that is waiting to be paid. */
  async initiate(bookingId: string, context: ActionContext): Promise<PaymentInitiation> {
    const prepared = await inTransaction(this.db, context, async (tx) => {
      const booking = await this.transitions.lock(tx, bookingId);
      if (context.source === 'CUSTOMER_APP' && booking.customerUserId !== context.actorUserId) {
        throw new ForbiddenError('NOT_YOUR_BOOKING', 'This booking belongs to another customer');
      }
      const row = await tx
        .selectFrom('booking')
        .select(['total_paise', 'payment_due_by', 'payment_mode', 'booking_code'])
        .where('id', '=', bookingId)
        .executeTakeFirstOrThrow();
      if (booking.status !== 'PENDING_PAYMENT' || !row.payment_due_by) {
        throw new BusinessRuleError(
          'NOT_AWAITING_PAYMENT',
          `Booking ${booking.bookingCode} is ${booking.status}`,
        );
      }
      if (row.payment_due_by <= this.clock.now()) {
        throw new BusinessRuleError(
          'PAYMENT_WINDOW_CLOSED',
          'The time to pay has run out; please book again',
        );
      }

      // Retrying checkout reuses the open order instead of creating a second one.
      const open = await tx
        .selectFrom('payment')
        .select(['id', 'provider', 'amount_paise', 'checkout'])
        .where('booking_id', '=', bookingId)
        .where('status', '=', 'CREATED')
        .where('provider', '=', this.provider.name)
        .where('amount_paise', '=', row.total_paise)
        .where('checkout', 'is not', null)
        .orderBy('created_at', 'desc')
        .executeTakeFirst();
      if (open) {
        return {
          reuse: true as const,
          paymentId: open.id,
          checkout: open.checkout as Record<string, unknown>,
          amount: open.amount_paise,
          payBy: row.payment_due_by,
        };
      }

      const payment = await tx
        .insertInto('payment')
        .values({
          booking_id: bookingId,
          provider: this.provider.name,
          amount_paise: row.total_paise,
          idempotency_key: `order:${bookingId}:${randomUUID()}`,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return {
        reuse: false as const,
        paymentId: payment.id,
        bookingCode: row.booking_code,
        amount: row.total_paise,
        payBy: row.payment_due_by,
      };
    });

    if (prepared.reuse) {
      return {
        paymentId: prepared.paymentId,
        provider: this.provider.name,
        amountPaise: prepared.amount,
        payBy: prepared.payBy,
        checkout: prepared.checkout,
      };
    }

    // The gateway call happens outside the database transaction.
    try {
      const order = await this.provider.createOrder({
        paymentId: prepared.paymentId,
        bookingCode: prepared.bookingCode,
        amountPaise: prepared.amount,
        currency: 'INR',
      });
      await inTransaction(this.db, context, (tx) =>
        tx
          .updateTable('payment')
          .set({
            provider_order_id: order.providerOrderId,
            checkout: JSON.stringify(order.checkout),
          })
          .where('id', '=', prepared.paymentId)
          .execute(),
      );
      return {
        paymentId: prepared.paymentId,
        provider: this.provider.name,
        amountPaise: prepared.amount,
        payBy: prepared.payBy,
        checkout: order.checkout,
      };
    } catch (error) {
      await inTransaction(this.db, context, (tx) =>
        tx
          .updateTable('payment')
          .set({ status: 'FAILED', failure_reason: 'Could not create gateway order' })
          .where('id', '=', prepared.paymentId)
          .execute(),
      );
      this.logger.error(
        `Gateway order creation failed for payment ${prepared.paymentId}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new BusinessRuleError(
        'PAYMENT_GATEWAY_UNAVAILABLE',
        'Payment could not be started. Please try again.',
      );
    }
  }

  /** Entry point for gateway webhooks (raw bytes, as received). */
  async handleWebhook(
    providerPath: string,
    rawBody: Buffer | undefined,
    headers: Readonly<Record<string, string | undefined>>,
    requestId: string,
  ): Promise<WebhookOutcome> {
    if (providerPath.toUpperCase() !== this.provider.name) {
      throw new NotFoundError('Payment provider', providerPath);
    }
    if (!rawBody || !this.provider.verifyWebhook(rawBody, headers)) {
      throw new UnauthorizedError(
        'WEBHOOK_SIGNATURE_INVALID',
        'Webhook signature verification failed',
      );
    }
    let event: ProviderEvent;
    try {
      event = this.provider.parseWebhook(rawBody, headers);
    } catch {
      throw new ValidationError('WEBHOOK_MALFORMED', 'Webhook body could not be read');
    }
    return this.processEvent(
      event,
      JSON.parse(rawBody.toString('utf8')) as unknown,
      true,
      requestId,
    );
  }

  /**
   * "I have paid" from the app: the server asks the gateway directly. The app's own
   * claim is never trusted; this only speeds up what the webhook will also deliver.
   */
  async refreshFromGateway(
    bookingId: string,
    paymentId: string,
    context: ActionContext,
  ): Promise<string> {
    const payment = await this.db
      .selectFrom('payment as p')
      .innerJoin('booking as b', 'b.id', 'p.booking_id')
      .select(['p.provider_order_id', 'p.status', 'b.customer_user_id'])
      .where('p.id', '=', paymentId)
      .where('p.booking_id', '=', bookingId)
      .executeTakeFirst();
    if (!payment) throw new NotFoundError('Payment', paymentId);
    if (context.source === 'CUSTOMER_APP' && payment.customer_user_id !== context.actorUserId) {
      throw new ForbiddenError('NOT_YOUR_BOOKING', 'This booking belongs to another customer');
    }
    if (['CREATED', 'AUTHORIZED'].includes(payment.status) && payment.provider_order_id) {
      await this.reconcileOrder(payment.provider_order_id, context.requestId);
    }
    const after = await this.db
      .selectFrom('payment')
      .select('status')
      .where('id', '=', paymentId)
      .executeTakeFirstOrThrow();
    return after.status;
  }

  /**
   * Asks the gateway about one order and applies the answer like a webhook would. An
   * authorized payment is captured here (never in the webhook request) while its booking
   * can still be paid; otherwise it is left uncaptured and the gateway releases the hold.
   */
  async reconcileOrder(providerOrderId: string, requestId: string): Promise<void> {
    let status = await this.provider.fetchOrderStatus(providerOrderId);
    if (status.state === 'PENDING') return;
    await this.applyStatus(providerOrderId, status, 'status.fetch', requestId);
    if (status.state !== 'AUTHORIZED' || !status.providerPaymentId) return;

    const payment = await this.db
      .selectFrom('payment as p')
      .innerJoin('booking as b', 'b.id', 'p.booking_id')
      .select(['p.status', 'p.amount_paise', 'b.status as booking_status'])
      .where('p.provider', '=', this.provider.name)
      .where('p.provider_order_id', '=', providerOrderId)
      .executeTakeFirst();
    if (payment?.status !== 'AUTHORIZED') return;
    if (payment.booking_status !== 'PENDING_PAYMENT') {
      this.logger.log(
        `Order ${providerOrderId} authorized after the booking became ${payment.booking_status}; not capturing`,
      );
      return;
    }
    if (status.amountPaise !== payment.amount_paise) return; // flagged when the event was applied
    status = await this.provider.capturePayment(status.providerPaymentId, payment.amount_paise);
    await this.applyStatus(providerOrderId, status, 'server.capture', requestId);
  }

  private async applyStatus(
    providerOrderId: string,
    status: OrderStatus,
    rawType: string,
    requestId: string,
  ): Promise<void> {
    if (status.state === 'PENDING') return;
    const type: ProviderEventType =
      status.state === 'CAPTURED'
        ? 'PAYMENT_CAPTURED'
        : status.state === 'AUTHORIZED'
          ? 'PAYMENT_AUTHORIZED'
          : 'PAYMENT_FAILED';
    const event: ProviderEvent = {
      // Deterministic id: repeated reconciliation of the same outcome is a duplicate.
      eventId: `status:${providerOrderId}:${status.state}:${status.providerPaymentId ?? ''}`,
      type,
      rawType,
      providerOrderId,
      providerPaymentId: status.providerPaymentId,
      providerRefundId: null,
      amountPaise: status.amountPaise,
      method: status.method,
      failureReason: status.failureReason,
      refundReference: null,
    };
    await this.processEvent(event, { source: rawType, status }, false, requestId);
  }

  /**
   * Background job: resolves open payments. Authorized payments of payable bookings are
   * captured straight away; unanswered orders are checked after two minutes (covers a lost
   * webhook); a failed order is re-checked for a while, as the customer may retry in the
   * same checkout.
   */
  async reconcileOpenPayments(requestId: string, limit = 50): Promise<number> {
    const open = await this.db
      .selectFrom('payment as p')
      .innerJoin('booking as b', 'b.id', 'p.booking_id')
      .select('p.provider_order_id')
      .where('p.provider', '=', this.provider.name)
      .where('p.provider_order_id', 'is not', null)
      .where('p.created_at', '>', sql<Date>`now() - interval '2 days'`)
      .where((eb) =>
        eb.or([
          eb.and([eb('p.status', '=', 'AUTHORIZED'), eb('b.status', '=', 'PENDING_PAYMENT')]),
          eb.and([
            eb('p.status', '=', 'CREATED'),
            eb('p.created_at', '<', sql<Date>`now() - interval '2 minutes'`),
          ]),
          eb.and([
            eb('p.status', '=', 'FAILED'),
            eb('b.status', '=', 'PENDING_PAYMENT'),
            eb('p.created_at', '>', sql<Date>`now() - interval '2 hours'`),
          ]),
        ]),
      )
      .orderBy('p.created_at')
      .limit(limit)
      .execute();
    let checked = 0;
    for (const { provider_order_id } of open) {
      if (!provider_order_id) continue;
      try {
        await this.reconcileOrder(provider_order_id, requestId);
        checked += 1;
      } catch (error) {
        this.logger.warn(`Reconciliation failed for order ${provider_order_id}: ${String(error)}`);
      }
    }
    return checked;
  }

  private async processEvent(
    event: ProviderEvent,
    payload: unknown,
    signatureVerified: boolean,
    requestId: string,
  ): Promise<WebhookOutcome> {
    const context = gatewayContext(requestId);
    return inTransaction(this.db, context, async (tx) => {
      // The unique (provider, event id) makes processing exactly-once even when the
      // gateway delivers the same event twice at the same moment.
      // Linked to our payment (when the order is known) so traces can follow it.
      const payment = event.providerOrderId
        ? await tx
            .selectFrom('payment')
            .select('id')
            .where('provider', '=', this.provider.name)
            .where('provider_order_id', '=', event.providerOrderId)
            .executeTakeFirst()
        : undefined;
      const stored = await tx
        .insertInto('payment_event')
        .values({
          provider: this.provider.name,
          payment_id: payment?.id ?? null,
          provider_event_id: event.eventId,
          event_type: event.rawType,
          signature_verified: signatureVerified,
          payload: JSON.stringify(payload),
        })
        .onConflict((oc) => oc.columns(['provider', 'provider_event_id']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!stored) return { status: 'DUPLICATE', eventId: event.eventId };

      const problem = await this.apply(tx, event, context);
      await tx
        .updateTable('payment_event')
        .set({ processed_at: sql<Date>`now()`, processing_error: problem })
        .where('id', '=', stored.id)
        .execute();
      if (problem) this.logger.warn(`Payment event ${event.eventId}: ${problem}`);
      return { status: 'PROCESSED', eventId: event.eventId };
    });
  }

  /** Applies one verified gateway event. Returns a problem description for operations, if any. */
  private async apply(
    tx: Tx,
    event: ProviderEvent,
    context: ActionContext,
  ): Promise<string | null> {
    switch (event.type) {
      case 'PAYMENT_AUTHORIZED':
        return this.applyAuthorized(tx, event);
      case 'PAYMENT_CAPTURED':
        return this.applyCaptured(tx, event, context);
      case 'PAYMENT_FAILED':
        return this.applyFailed(tx, event);
      case 'REFUND_PROCESSED':
      case 'REFUND_FAILED':
        return this.refunds.applyGatewayOutcome(tx, event, context);
      case 'IGNORED':
        return null;
    }
  }

  private async applyCaptured(
    tx: Tx,
    event: ProviderEvent,
    context: ActionContext,
  ): Promise<string | null> {
    if (!event.providerOrderId) return 'CAPTURE_WITHOUT_ORDER';
    const ref = await tx
      .selectFrom('payment')
      .select(['id', 'booking_id'])
      .where('provider', '=', this.provider.name)
      .where('provider_order_id', '=', event.providerOrderId)
      .executeTakeFirst();
    if (!ref) return 'UNKNOWN_ORDER';

    // Lock order everywhere: booking first, then its payments.
    const booking = await this.transitions.lock(tx, ref.booking_id);
    const payment = await tx
      .selectFrom('payment')
      .selectAll()
      .where('id', '=', ref.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (payment.status === 'CAPTURED') return null; // Already applied via another event.

    if (event.amountPaise !== null && event.amountPaise !== payment.amount_paise) {
      return `AMOUNT_MISMATCH expected ${payment.amount_paise} got ${event.amountPaise}`;
    }

    const alreadyPaid = await tx
      .selectFrom('payment')
      .select('id')
      .where('booking_id', '=', booking.id)
      .where('status', '=', 'CAPTURED')
      .where('is_duplicate', '=', false)
      .executeTakeFirst();

    await tx
      .updateTable('payment')
      .set({
        status: 'CAPTURED',
        is_duplicate: alreadyPaid !== undefined,
        provider_payment_id: event.providerPaymentId,
        method: event.method,
        captured_at: this.clock.now(),
        captured_amount_paise: event.amountPaise ?? payment.amount_paise,
        failure_reason: null,
      })
      .where('id', '=', payment.id)
      .execute();

    if (alreadyPaid) {
      await this.refunds.requestInTx(tx, context, {
        bookingId: booking.id,
        paymentId: payment.id,
        amountPaise: null,
        reasonCode: 'DUPLICATE_PAYMENT',
        reasonText: 'The booking was already paid; the second payment is returned.',
        autoApprovePolicy: 'DUPLICATE_PAYMENT_FULL_REFUND',
      });
      return 'DUPLICATE_CAPTURE_REFUNDED';
    }

    await this.notifier.toCustomer(tx, booking.id, 'PAYMENT_SUCCESSFUL', {
      dedupeSuffix: payment.id,
    });

    if (booking.status === 'PENDING_PAYMENT') {
      await this.dispatch.confirmPaidInTx(tx, booking.id, context);
      return null;
    }
    if (booking.status === 'EXPIRED' || booking.status === 'CANCELLED') {
      // Money arrived after the booking ended: give it back automatically.
      await this.refunds.requestInTx(tx, context, {
        bookingId: booking.id,
        paymentId: payment.id,
        amountPaise: null,
        reasonCode: 'PAYMENT_AFTER_EXPIRY',
        reasonText: `Payment received after the booking was ${booking.status.toLowerCase()}.`,
        autoApprovePolicy: 'LATE_PAYMENT_FULL_REFUND',
      });
      return 'LATE_PAYMENT_REFUNDED';
    }
    return null;
  }

  /** Money is held but not taken yet; the reconciliation job captures it. */
  private async applyAuthorized(tx: Tx, event: ProviderEvent): Promise<string | null> {
    if (!event.providerOrderId) return 'AUTHORIZATION_WITHOUT_ORDER';
    const payment = await tx
      .selectFrom('payment')
      .select(['id', 'status', 'amount_paise'])
      .where('provider', '=', this.provider.name)
      .where('provider_order_id', '=', event.providerOrderId)
      .forUpdate()
      .executeTakeFirst();
    if (!payment) return 'UNKNOWN_ORDER';
    if (!['CREATED', 'FAILED'].includes(payment.status)) return null; // already further on
    if (event.amountPaise !== null && event.amountPaise !== payment.amount_paise) {
      return `AMOUNT_MISMATCH expected ${String(payment.amount_paise)} got ${String(event.amountPaise)}`;
    }
    await tx
      .updateTable('payment')
      .set({
        status: 'AUTHORIZED',
        authorized_at: this.clock.now(),
        provider_payment_id: event.providerPaymentId,
        method: event.method,
        failure_reason: null,
      })
      .where('id', '=', payment.id)
      .execute();
    return null;
  }

  private async applyFailed(tx: Tx, event: ProviderEvent): Promise<string | null> {
    if (!event.providerOrderId) return 'FAILURE_WITHOUT_ORDER';
    const result = await tx
      .updateTable('payment')
      .set({ status: 'FAILED', failure_reason: event.failureReason ?? 'Payment failed' })
      .where('provider', '=', this.provider.name)
      .where('provider_order_id', '=', event.providerOrderId)
      .where('status', 'in', ['CREATED', 'AUTHORIZED'])
      .executeTakeFirst();
    // The booking stays PENDING_PAYMENT: the customer may try again until the deadline.
    return Number(result.numUpdatedRows) === 0 ? 'FAILURE_FOR_SETTLED_PAYMENT' : null;
  }
}
