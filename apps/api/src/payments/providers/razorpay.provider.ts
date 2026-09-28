import { hmacSha256Hex, safeEqual } from '../../security/crypto.js';
import type {
  CreatedOrder,
  CreateOrderInput,
  OrderStatus,
  PaymentProvider,
  ProviderEvent,
  ProviderEventType,
  RefundResult,
} from './payment-provider.js';

const API = 'https://api.razorpay.com/v1';

interface RazorpayConfig {
  readonly keyId: string;
  readonly keySecret: string;
  readonly webhookSecret: string;
  /** Business name shown in Razorpay checkout. */
  readonly displayName: string;
}

interface RzpPayment {
  id: string;
  order_id: string | null;
  amount: number;
  currency?: string;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
  method?: string;
  error_description?: string | null;
}

interface RzpRefund {
  id: string;
  payment_id: string;
  amount: number;
  currency?: string;
  status: 'pending' | 'processed' | 'failed';
  receipt?: string | null;
  notes?: Record<string, string> | null;
}

/**
 * Razorpay (https://razorpay.com/docs/api/). Orders are created server-side; the app
 * opens Razorpay Checkout with the order id; confirmation comes only from the signed
 * webhook or a server-side status fetch, never from the app.
 */
export class RazorpayProvider implements PaymentProvider {
  readonly name = 'RAZORPAY' as const;

  constructor(
    private readonly config: RazorpayConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async createOrder(input: CreateOrderInput): Promise<CreatedOrder> {
    const order = await this.call<{ id: string }>('POST', '/orders', {
      amount: input.amountPaise,
      currency: input.currency,
      receipt: input.paymentId,
      notes: { booking_code: input.bookingCode, payment_id: input.paymentId },
    });
    return {
      providerOrderId: order.id,
      checkout: {
        provider: 'RAZORPAY',
        keyId: this.config.keyId,
        orderId: order.id,
        amount: input.amountPaise,
        currency: input.currency,
        name: this.config.displayName,
        description: `Booking ${input.bookingCode}`,
      },
    };
  }

  verifyWebhook(rawBody: Buffer, headers: Readonly<Record<string, string | undefined>>): boolean {
    const signature = headers['x-razorpay-signature'];
    if (!signature) return false;
    return safeEqual(hmacSha256Hex(this.config.webhookSecret, rawBody), signature);
  }

  parseWebhook(
    rawBody: Buffer,
    headers: Readonly<Record<string, string | undefined>>,
  ): ProviderEvent {
    const body = JSON.parse(rawBody.toString('utf8')) as {
      event: string;
      payload: { payment?: { entity: RzpPayment }; refund?: { entity: RzpRefund } };
    };
    const payment = body.payload.payment?.entity;
    const refund = body.payload.refund?.entity;
    const types: Record<string, ProviderEventType> = {
      'payment.authorized': 'PAYMENT_AUTHORIZED',
      'payment.captured': 'PAYMENT_CAPTURED',
      'order.paid': 'PAYMENT_CAPTURED',
      'payment.failed': 'PAYMENT_FAILED',
      'refund.processed': 'REFUND_PROCESSED',
      'refund.failed': 'REFUND_FAILED',
    };
    return {
      // Razorpay sends a unique id per event in this header; fall back to a content hash.
      eventId: headers['x-razorpay-event-id'] ?? hmacSha256Hex('event', rawBody),
      type: types[body.event] ?? 'IGNORED',
      rawType: body.event,
      providerOrderId: payment?.order_id ?? null,
      providerPaymentId: payment?.id ?? refund?.payment_id ?? null,
      providerRefundId: refund?.id ?? null,
      amountPaise: refund?.amount ?? payment?.amount ?? null,
      currency: refund?.currency ?? payment?.currency ?? null,
      method: payment?.method ?? null,
      failureReason: payment?.error_description ?? null,
      refundReference: refund?.receipt ?? refund?.notes?.['refund_id'] ?? null,
    };
  }

  storedPayload(rawBody: Buffer): unknown {
    const body = JSON.parse(rawBody.toString('utf8')) as {
      event?: unknown;
      entity?: unknown;
      account_id?: unknown;
      created_at?: unknown;
      contains?: unknown;
      payload?: Record<string, { entity?: Record<string, unknown> } | undefined>;
    };
    const entities: Record<string, unknown> = {};
    for (const [name, fields] of Object.entries(STORED_ENTITY_FIELDS)) {
      const entity = body.payload?.[name]?.entity;
      if (entity) entities[name] = { entity: pick(entity, fields) };
    }
    return {
      event: body.event,
      entity: body.entity,
      account_id: body.account_id,
      created_at: body.created_at,
      contains: body.contains,
      payload: entities,
    };
  }

  async fetchOrderStatus(providerOrderId: string): Promise<OrderStatus> {
    const { items } = await this.call<{ items: RzpPayment[] }>(
      'GET',
      `/orders/${encodeURIComponent(providerOrderId)}/payments`,
    );
    const captured = items.find((p) => p.status === 'captured');
    if (captured) return toOrderStatus(captured);
    const authorized = items.find((p) => p.status === 'authorized');
    if (authorized) return toOrderStatus(authorized);
    const failed = items.find((p) => p.status === 'failed');
    if (failed && items.every((p) => p.status === 'failed')) {
      return {
        state: 'FAILED',
        providerPaymentId: failed.id,
        amountPaise: failed.amount,
        currency: failed.currency ?? null,
        method: failed.method ?? null,
        failureReason: failed.error_description ?? null,
      };
    }
    return {
      state: 'PENDING',
      providerPaymentId: null,
      amountPaise: null,
      currency: null,
      method: null,
      failureReason: null,
    };
  }

  async capturePayment(providerPaymentId: string, amountPaise: number): Promise<OrderStatus> {
    const path = `/payments/${encodeURIComponent(providerPaymentId)}`;
    try {
      return toOrderStatus(
        await this.call<RzpPayment>('POST', `${path}/capture`, {
          amount: amountPaise,
          currency: 'INR',
        }),
      );
    } catch (error) {
      // Already captured (or the answer was lost): the payment's own state is the truth.
      const current = await this.call<RzpPayment>('GET', path);
      if (current.status === 'captured') return toOrderStatus(current);
      throw error;
    }
  }

  async createRefund(
    providerPaymentId: string,
    amountPaise: number,
    reference: string,
  ): Promise<RefundResult> {
    const refund = await this.call<RzpRefund>(
      'POST',
      `/payments/${encodeURIComponent(providerPaymentId)}/refund`,
      {
        amount: amountPaise,
        speed: 'normal',
        receipt: reference,
        notes: { refund_id: reference },
      },
    );
    return toRefundResult(refund);
  }

  async findRefund(providerPaymentId: string, reference: string): Promise<RefundResult | null> {
    const { items } = await this.call<{ items: RzpRefund[] }>(
      'GET',
      `/payments/${encodeURIComponent(providerPaymentId)}/refunds`,
    );
    const match = items.find(
      (r) => r.receipt === reference || r.notes?.['refund_id'] === reference,
    );
    return match ? toRefundResult(match) : null;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const auth = Buffer.from(`${this.config.keyId}:${this.config.keySecret}`).toString('base64');
    const response = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Razorpay ${method} ${path} failed with HTTP ${response.status}: ${detail.slice(0, 300)}`,
      );
    }
    return (await response.json()) as T;
  }
}

/**
 * Webhook fields kept for investigation and reconciliation. Anything not listed (the
 * payer's email, phone, UPI id, card and bank-account details, free-form notes) is dropped
 * before storage: it is not needed to prove what happened to the money.
 */
const STORED_ENTITY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  payment: [
    'id',
    'entity',
    'amount',
    'currency',
    'status',
    'order_id',
    'invoice_id',
    'international',
    'method',
    'amount_refunded',
    'refund_status',
    'captured',
    'fee',
    'tax',
    'error_code',
    'error_description',
    'error_source',
    'error_step',
    'error_reason',
    'created_at',
  ],
  order: [
    'id',
    'entity',
    'amount',
    'amount_paid',
    'amount_due',
    'currency',
    'receipt',
    'status',
    'attempts',
    'created_at',
  ],
  refund: [
    'id',
    'entity',
    'amount',
    'currency',
    'payment_id',
    'receipt',
    'status',
    'speed_requested',
    'speed_processed',
    'created_at',
  ],
};

function pick(entity: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const field of fields) if (field in entity) kept[field] = entity[field];
  return kept;
}

function toOrderStatus(payment: RzpPayment): OrderStatus {
  const state =
    payment.status === 'captured'
      ? 'CAPTURED'
      : payment.status === 'authorized'
        ? 'AUTHORIZED'
        : payment.status === 'failed'
          ? 'FAILED'
          : 'PENDING';
  return {
    state,
    providerPaymentId: payment.id,
    amountPaise: payment.amount,
    currency: payment.currency ?? null,
    method: payment.method ?? null,
    failureReason: state === 'FAILED' ? (payment.error_description ?? null) : null,
  };
}

function toRefundResult(refund: RzpRefund): RefundResult {
  return {
    providerRefundId: refund.id,
    state:
      refund.status === 'processed'
        ? 'PROCESSED'
        : refund.status === 'failed'
          ? 'FAILED'
          : 'PROCESSING',
    failureReason: refund.status === 'failed' ? 'Refund failed at gateway' : null,
  };
}
