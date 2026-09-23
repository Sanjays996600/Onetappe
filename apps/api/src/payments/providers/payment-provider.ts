/**
 * Everything One Tappe needs from a payment gateway. Booking and refund logic depend only
 * on this interface, so the gateway can be changed without touching them.
 * Card or UPI credentials never pass through our servers: the app talks to the gateway's
 * own checkout using the `checkout` data from createOrder.
 */
export type PaymentProviderName = 'RAZORPAY' | 'SANDBOX';

export interface CreateOrderInput {
  /** Our payment id; used as the gateway receipt so orders can be traced back. */
  readonly paymentId: string;
  readonly bookingCode: string;
  readonly amountPaise: number;
  readonly currency: 'INR';
}

export interface CreatedOrder {
  readonly providerOrderId: string;
  /** Data the mobile app needs to open the gateway's checkout (no secrets). */
  readonly checkout: Record<string, unknown>;
}

export type ProviderEventType =
  | 'PAYMENT_AUTHORIZED'
  | 'PAYMENT_CAPTURED'
  | 'PAYMENT_FAILED'
  | 'REFUND_PROCESSED'
  | 'REFUND_FAILED'
  | 'IGNORED';

/** A gateway notification translated into our terms. */
export interface ProviderEvent {
  /** Unique per event at the gateway; used to process each event exactly once. */
  readonly eventId: string;
  readonly type: ProviderEventType;
  readonly rawType: string;
  readonly providerOrderId: string | null;
  readonly providerPaymentId: string | null;
  readonly providerRefundId: string | null;
  readonly amountPaise: number | null;
  readonly method: string | null;
  readonly failureReason: string | null;
  /** Our refund id, when the gateway echoes it back (receipt/notes). */
  readonly refundReference: string | null;
}

export interface OrderStatus {
  /** AUTHORIZED: money is held but not yet taken; One Tappe must capture it. */
  readonly state: 'PENDING' | 'AUTHORIZED' | 'CAPTURED' | 'FAILED';
  readonly providerPaymentId: string | null;
  readonly amountPaise: number | null;
  readonly method: string | null;
  readonly failureReason: string | null;
}

export interface RefundResult {
  readonly providerRefundId: string;
  readonly state: 'PROCESSING' | 'PROCESSED' | 'FAILED';
  readonly failureReason: string | null;
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  createOrder(input: CreateOrderInput): Promise<CreatedOrder>;
  /** Verifies the webhook came from the gateway, using the exact raw bytes received. */
  verifyWebhook(rawBody: Buffer, headers: Readonly<Record<string, string | undefined>>): boolean;
  parseWebhook(
    rawBody: Buffer,
    headers: Readonly<Record<string, string | undefined>>,
  ): ProviderEvent;
  /** Server-to-server status check, used for reconciliation and "I have paid" refreshes. */
  fetchOrderStatus(providerOrderId: string): Promise<OrderStatus>;
  /**
   * Takes an authorized payment. Safe to repeat: if it was already captured, the current
   * (captured) state is returned instead of an error.
   */
  capturePayment(providerPaymentId: string, amountPaise: number): Promise<OrderStatus>;
  /** `reference` is our refund id; the gateway must receive it so retries can be matched. */
  createRefund(
    providerPaymentId: string,
    amountPaise: number,
    reference: string,
  ): Promise<RefundResult>;
  /** Finds a refund we asked for (by our reference) when its outcome is unknown. */
  findRefund(providerPaymentId: string, reference: string): Promise<RefundResult | null>;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
