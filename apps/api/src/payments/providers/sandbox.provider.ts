import { randomUUID } from 'node:crypto';
import { hmacSha256Hex, randomToken, safeEqual } from '../../security/crypto.js';
import type {
  CreatedOrder,
  CreateOrderInput,
  OrderStatus,
  PaymentProvider,
  ProviderEvent,
  RefundResult,
} from './payment-provider.js';

interface SandboxOrder {
  amountPaise: number;
  currency: string;
  /** What the gateway reports as paid; differs from the order only in mismatch tests. */
  paid: { amountPaise: number; currency: string | null } | null;
  state: OrderStatus['state'];
  paymentId: string | null;
  failureReason: string | null;
}

interface SandboxRefund {
  id: string;
  paymentId: string;
  amountPaise: number;
  reference: string;
  state: RefundResult['state'];
}

/** A payment that differs from its order, as a misbehaving gateway or a test would send it. */
export interface PaidAs {
  readonly amountPaise?: number;
  /** null: the gateway sends no currency at all. */
  readonly currency?: string | null;
}

export interface SignedWebhook {
  readonly rawBody: string;
  readonly headers: Record<string, string>;
}

/**
 * A simulated gateway for local development, automated tests and demos (never allowed in
 * production). It behaves like a real gateway from the API's point of view: orders are
 * created, and outcomes arrive as HMAC-signed webhooks that go through exactly the same
 * verification and processing path as Razorpay's.
 */
export class SandboxPaymentProvider implements PaymentProvider {
  readonly name = 'SANDBOX' as const;
  private readonly orders = new Map<string, SandboxOrder>();
  private readonly refunds = new Map<string, SandboxRefund>();

  constructor(private readonly webhookSecret: string) {}

  createOrder(input: CreateOrderInput): Promise<CreatedOrder> {
    const orderId = `sbx_order_${randomToken(9)}`;
    this.orders.set(orderId, {
      amountPaise: input.amountPaise,
      currency: input.currency,
      paid: null,
      state: 'PENDING',
      paymentId: null,
      failureReason: null,
    });
    return Promise.resolve({
      providerOrderId: orderId,
      checkout: {
        provider: 'SANDBOX',
        orderId,
        amount: input.amountPaise,
        currency: input.currency,
      },
    });
  }

  verifyWebhook(rawBody: Buffer, headers: Readonly<Record<string, string | undefined>>): boolean {
    const signature = headers['x-sandbox-signature'];
    return (
      signature !== undefined && safeEqual(hmacSha256Hex(this.webhookSecret, rawBody), signature)
    );
  }

  parseWebhook(rawBody: Buffer): ProviderEvent {
    return JSON.parse(rawBody.toString('utf8')) as ProviderEvent;
  }

  storedPayload(rawBody: Buffer): unknown {
    // Sandbox events carry no personal data.
    return JSON.parse(rawBody.toString('utf8')) as unknown;
  }

  fetchOrderStatus(providerOrderId: string): Promise<OrderStatus> {
    const order = this.orders.get(providerOrderId);
    return Promise.resolve({
      state: order?.state ?? 'PENDING',
      providerPaymentId: order?.paymentId ?? null,
      amountPaise: order ? (order.paid?.amountPaise ?? order.amountPaise) : null,
      currency: order ? (order.paid ? order.paid.currency : order.currency) : null,
      method: order?.paymentId ? 'upi' : null,
      failureReason: order?.failureReason ?? null,
    });
  }

  capturePayment(providerPaymentId: string, amountPaise: number): Promise<OrderStatus> {
    const entry = [...this.orders.entries()].find(([, o]) => o.paymentId === providerPaymentId);
    if (!entry) return Promise.reject(new Error(`Unknown sandbox payment ${providerPaymentId}`));
    const [orderId, order] = entry;
    if (order.state === 'AUTHORIZED') {
      if (amountPaise !== order.amountPaise) {
        return Promise.reject(new Error('Capture amount must equal the authorized amount'));
      }
      order.state = 'CAPTURED';
      this.captures += 1;
    }
    return this.fetchOrderStatus(orderId);
  }

  /** Number of server-side captures performed (for tests). */
  captures = 0;

  createRefund(
    providerPaymentId: string,
    amountPaise: number,
    reference: string,
  ): Promise<RefundResult> {
    const existing = [...this.refunds.values()].find((r) => r.reference === reference);
    if (existing) return Promise.resolve(toResult(existing));
    const refund: SandboxRefund = {
      id: `sbx_rfnd_${randomToken(9)}`,
      paymentId: providerPaymentId,
      amountPaise,
      reference,
      state: 'PROCESSING',
    };
    this.refunds.set(refund.id, refund);
    return Promise.resolve(toResult(refund));
  }

  findRefund(_providerPaymentId: string, reference: string): Promise<RefundResult | null> {
    const refund = [...this.refunds.values()].find((r) => r.reference === reference);
    return Promise.resolve(refund ? toResult(refund) : null);
  }

  // ---- Simulation controls (what a customer paying / a bank settling would cause) ----

  /**
   * The customer completes payment; returns the webhook the gateway would send. `paidAs`
   * simulates a gateway reporting a different amount or currency than the order's.
   */
  capture(providerOrderId: string, paidAs: PaidAs = {}): SignedWebhook {
    const order = this.pay(providerOrderId, 'CAPTURED', paidAs);
    return this.sign({
      type: 'PAYMENT_CAPTURED',
      rawType: 'payment.captured',
      providerOrderId,
      providerPaymentId: order.paymentId,
      amountPaise: order.paid?.amountPaise ?? order.amountPaise,
      currency: order.paid ? order.paid.currency : order.currency,
      method: 'upi',
    });
  }

  /** The bank authorizes the payment but it is not captured (automatic capture off). */
  authorize(providerOrderId: string, paidAs: PaidAs = {}): SignedWebhook {
    const order = this.pay(providerOrderId, 'AUTHORIZED', paidAs);
    return this.sign({
      type: 'PAYMENT_AUTHORIZED',
      rawType: 'payment.authorized',
      providerOrderId,
      providerPaymentId: order.paymentId,
      amountPaise: order.paid?.amountPaise ?? order.amountPaise,
      currency: order.paid ? order.paid.currency : order.currency,
      method: 'card',
    });
  }

  private pay(
    providerOrderId: string,
    state: 'AUTHORIZED' | 'CAPTURED',
    paidAs: PaidAs,
  ): SandboxOrder {
    const order = this.requireOrder(providerOrderId);
    order.state = state;
    order.paymentId ??= `sbx_pay_${randomToken(9)}`;
    if (paidAs.amountPaise !== undefined || paidAs.currency !== undefined) {
      order.paid = {
        amountPaise: paidAs.amountPaise ?? order.amountPaise,
        currency: paidAs.currency === undefined ? order.currency : paidAs.currency,
      };
    }
    return order;
  }

  /** The payment attempt fails (declined, cancelled, timed out). */
  fail(providerOrderId: string, reason = 'Payment declined by bank'): SignedWebhook {
    const order = this.requireOrder(providerOrderId);
    order.state = 'FAILED';
    order.failureReason = reason;
    return this.sign({
      type: 'PAYMENT_FAILED',
      rawType: 'payment.failed',
      providerOrderId,
      providerPaymentId: `sbx_pay_${randomToken(9)}`,
      amountPaise: order.amountPaise,
      currency: order.currency,
      failureReason: reason,
    });
  }

  /** The bank settles a refund (`paidAs` simulates a gateway reporting different money). */
  settleRefund(providerRefundId: string, paidAs: PaidAs = {}): SignedWebhook {
    const refund = this.refunds.get(providerRefundId);
    if (!refund) throw new Error(`Unknown sandbox refund ${providerRefundId}`);
    refund.state = 'PROCESSED';
    return this.sign({
      type: 'REFUND_PROCESSED',
      rawType: 'refund.processed',
      providerPaymentId: refund.paymentId,
      providerRefundId: refund.id,
      amountPaise: paidAs.amountPaise ?? refund.amountPaise,
      currency: paidAs.currency === undefined ? 'INR' : paidAs.currency,
      refundReference: refund.reference,
    });
  }

  private sign(
    event: Partial<ProviderEvent> & Pick<ProviderEvent, 'type' | 'rawType'>,
  ): SignedWebhook {
    const full: ProviderEvent = {
      eventId: `sbx_evt_${randomUUID()}`,
      providerOrderId: null,
      providerPaymentId: null,
      providerRefundId: null,
      amountPaise: null,
      currency: null,
      method: null,
      failureReason: null,
      refundReference: null,
      ...event,
    };
    const rawBody = JSON.stringify(full);
    return {
      rawBody,
      headers: {
        'content-type': 'application/json',
        'x-sandbox-signature': hmacSha256Hex(this.webhookSecret, rawBody),
      },
    };
  }

  private requireOrder(providerOrderId: string): SandboxOrder {
    const order = this.orders.get(providerOrderId);
    if (!order) throw new Error(`Unknown sandbox order ${providerOrderId}`);
    return order;
  }
}

function toResult(refund: SandboxRefund): RefundResult {
  return { providerRefundId: refund.id, state: refund.state, failureReason: null };
}
