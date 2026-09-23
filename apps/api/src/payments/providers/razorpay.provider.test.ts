import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RazorpayProvider } from './razorpay.provider.js';

const config = {
  keyId: 'rzp_test_key',
  keySecret: 'test-key-secret',
  webhookSecret: 'test-webhook-secret',
  displayName: 'One Tappe',
};

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch stand-in that records requests and replies with the queued responses. */
function fakeFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Recorded[] = [];
  const impl: typeof fetch = (input, init) => {
    const next = responses.shift();
    if (!next) throw new Error('Unexpected request');
    calls.push({
      // RazorpayProvider always passes the URL as a string.
      url: input as string,
      method: init?.method ?? 'GET',
      headers: init?.headers as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return Promise.resolve(new Response(JSON.stringify(next.body), { status: next.status ?? 200 }));
  };
  return { calls, impl };
}

function sign(body: string, secret = config.webhookSecret): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

describe('Razorpay webhook verification', () => {
  const provider = new RazorpayProvider(config);
  const body = JSON.stringify({ event: 'payment.captured', payload: {} });

  it('accepts a body signed with the webhook secret', () => {
    expect(provider.verifyWebhook(Buffer.from(body), { 'x-razorpay-signature': sign(body) })).toBe(
      true,
    );
  });

  it('rejects a missing signature, a wrong secret and a modified body', () => {
    const raw = Buffer.from(body);
    expect(provider.verifyWebhook(raw, {})).toBe(false);
    expect(provider.verifyWebhook(raw, { 'x-razorpay-signature': sign(body, 'other') })).toBe(
      false,
    );
    const tampered = body.replace('captured', 'failed');
    expect(
      provider.verifyWebhook(Buffer.from(tampered), { 'x-razorpay-signature': sign(body) }),
    ).toBe(false);
  });

  it('rejects a signature signed with the API key secret instead of the webhook secret', () => {
    expect(
      provider.verifyWebhook(Buffer.from(body), {
        'x-razorpay-signature': sign(body, config.keySecret),
      }),
    ).toBe(false);
  });
});

describe('Razorpay webhook parsing', () => {
  const provider = new RazorpayProvider(config);

  it('maps payment.captured with the gateway event id', () => {
    const raw = Buffer.from(
      JSON.stringify({
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: 'pay_1',
              order_id: 'order_1',
              amount: 58_882,
              status: 'captured',
              method: 'upi',
            },
          },
        },
      }),
    );
    expect(provider.parseWebhook(raw, { 'x-razorpay-event-id': 'evt_1' })).toEqual({
      eventId: 'evt_1',
      type: 'PAYMENT_CAPTURED',
      rawType: 'payment.captured',
      providerOrderId: 'order_1',
      providerPaymentId: 'pay_1',
      providerRefundId: null,
      amountPaise: 58_882,
      method: 'upi',
      failureReason: null,
      refundReference: null,
    });
  });

  it('maps payment.failed with the gateway reason', () => {
    const raw = Buffer.from(
      JSON.stringify({
        event: 'payment.failed',
        payload: {
          payment: {
            entity: {
              id: 'pay_2',
              order_id: 'order_2',
              amount: 100,
              status: 'failed',
              error_description: 'Payment was declined by the bank',
            },
          },
        },
      }),
    );
    expect(provider.parseWebhook(raw, {})).toMatchObject({
      type: 'PAYMENT_FAILED',
      providerOrderId: 'order_2',
      failureReason: 'Payment was declined by the bank',
    });
  });

  it('maps refund.processed back to our refund id', () => {
    const raw = Buffer.from(
      JSON.stringify({
        event: 'refund.processed',
        payload: {
          refund: {
            entity: {
              id: 'rfnd_1',
              payment_id: 'pay_1',
              amount: 5_000,
              status: 'processed',
              receipt: 'our-refund-id',
            },
          },
        },
      }),
    );
    expect(provider.parseWebhook(raw, {})).toMatchObject({
      type: 'REFUND_PROCESSED',
      providerPaymentId: 'pay_1',
      providerRefundId: 'rfnd_1',
      amountPaise: 5_000,
      refundReference: 'our-refund-id',
    });
  });

  it('ignores events it does not act on, with a stable id when the header is absent', () => {
    const raw = Buffer.from(JSON.stringify({ event: 'payment.authorized', payload: {} }));
    const first = provider.parseWebhook(raw, {});
    expect(first.type).toBe('IGNORED');
    expect(provider.parseWebhook(raw, {}).eventId).toBe(first.eventId);
  });
});

describe('Razorpay API calls', () => {
  it('creates an order server-side and gives the app checkout data without secrets', async () => {
    const { calls, impl } = fakeFetch([{ body: { id: 'order_9' } }]);
    const provider = new RazorpayProvider(config, impl);
    const order = await provider.createOrder({
      paymentId: 'payment-uuid',
      bookingCode: 'OT-1',
      amountPaise: 58_882,
      currency: 'INR',
    });

    expect(calls[0]).toMatchObject({
      url: 'https://api.razorpay.com/v1/orders',
      method: 'POST',
      body: { amount: 58_882, currency: 'INR', receipt: 'payment-uuid' },
    });
    expect(calls[0]!.headers['authorization']).toBe(
      `Basic ${Buffer.from('rzp_test_key:test-key-secret').toString('base64')}`,
    );
    expect(order.providerOrderId).toBe('order_9');
    expect(JSON.stringify(order.checkout)).not.toContain(config.keySecret);
    expect(JSON.stringify(order.checkout)).not.toContain(config.webhookSecret);
  });

  it('reports an order as captured, failed or pending from its payments', async () => {
    const { impl } = fakeFetch([
      {
        body: {
          items: [
            { id: 'p1', order_id: 'o', amount: 10, status: 'failed' },
            { id: 'p2', order_id: 'o', amount: 10, status: 'captured', method: 'card' },
          ],
        },
      },
      {
        body: {
          items: [
            {
              id: 'p3',
              order_id: 'o',
              amount: 10,
              status: 'failed',
              error_description: 'Declined',
            },
          ],
        },
      },
      {
        body: {
          items: [
            { id: 'p4', order_id: 'o', amount: 10, status: 'failed' },
            { id: 'p5', order_id: 'o', amount: 10, status: 'authorized' },
          ],
        },
      },
      { body: { items: [] } },
    ]);
    const provider = new RazorpayProvider(config, impl);
    expect(await provider.fetchOrderStatus('o')).toMatchObject({
      state: 'CAPTURED',
      providerPaymentId: 'p2',
      method: 'card',
    });
    expect(await provider.fetchOrderStatus('o')).toMatchObject({
      state: 'FAILED',
      failureReason: 'Declined',
    });
    // A retry in progress after a failed attempt is not a failure.
    expect((await provider.fetchOrderStatus('o')).state).toBe('PENDING');
    expect((await provider.fetchOrderStatus('o')).state).toBe('PENDING');
  });

  it('passes our refund id to the gateway and finds the refund by it on retry', async () => {
    const { calls, impl } = fakeFetch([
      {
        body: {
          id: 'rfnd_1',
          payment_id: 'pay_1',
          amount: 500,
          status: 'pending',
          receipt: 'ref-1',
        },
      },
      {
        body: {
          items: [
            {
              id: 'rfnd_0',
              payment_id: 'pay_1',
              amount: 100,
              status: 'processed',
              receipt: 'other',
            },
            {
              id: 'rfnd_1',
              payment_id: 'pay_1',
              amount: 500,
              status: 'processed',
              receipt: 'ref-1',
            },
          ],
        },
      },
      { body: { items: [] } },
    ]);
    const provider = new RazorpayProvider(config, impl);

    expect(await provider.createRefund('pay_1', 500, 'ref-1')).toEqual({
      providerRefundId: 'rfnd_1',
      state: 'PROCESSING',
      failureReason: null,
    });
    expect(calls[0]).toMatchObject({
      url: 'https://api.razorpay.com/v1/payments/pay_1/refund',
      body: { amount: 500, receipt: 'ref-1', notes: { refund_id: 'ref-1' } },
    });
    expect(await provider.findRefund('pay_1', 'ref-1')).toMatchObject({
      providerRefundId: 'rfnd_1',
      state: 'PROCESSED',
    });
    expect(await provider.findRefund('pay_1', 'ref-2')).toBeNull();
  });

  it('turns an HTTP error into an exception that does not leak credentials', async () => {
    const { impl } = fakeFetch([
      { status: 401, body: { error: { description: 'Authentication failed' } } },
    ]);
    const provider = new RazorpayProvider(config, impl);
    const failure = await provider.fetchOrderStatus('o').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('HTTP 401');
    expect((failure as Error).message).not.toContain(config.keySecret);
  });
});
