import type { Payment } from './types.ts';
interface CheckoutInstance {
  open(): void;
  on(event: string, callback: () => void): void;
}
interface CheckoutOptions {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  handler: () => void;
  modal: { ondismiss: () => void };
  theme: { color: string };
}
declare global {
  interface Window {
    Razorpay?: new (options: CheckoutOptions) => CheckoutInstance;
  }
}
let loading: Promise<void> | null = null;
function loadCheckout(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    const timer = window.setTimeout(() => {
      script.remove();
      loading = null;
      reject(new Error('Payment window could not load. Please retry.'));
    }, 15_000);
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = () => {
      clearTimeout(timer);
      resolve();
    };
    script.onerror = () => {
      clearTimeout(timer);
      script.remove();
      loading = null;
      reject(new Error('Payment window could not load. Please retry.'));
    };
    document.head.append(script);
  });
  return loading;
}
export async function checkout(payment: Payment): Promise<void> {
  if (payment.provider !== 'RAZORPAY')
    throw new Error('Payments are in sandbox mode on this environment. No money has been charged.');
  await loadCheckout();
  const { keyId, orderId, amount, currency, name, description } = payment.checkout;
  const Gateway = window.Razorpay;
  if (!Gateway || !keyId || !orderId || !amount || !currency)
    throw new Error('Payment configuration is incomplete. Please contact support.');
  await new Promise<void>((resolve, reject) => {
    const instance = new Gateway({
      key: keyId,
      order_id: orderId,
      amount,
      currency,
      name: name ?? 'One Tappe',
      description: description ?? '',
      handler: resolve,
      modal: { ondismiss: resolve },
      theme: { color: '#285c45' },
    });
    instance.on('payment.failed', () => {
      reject(new Error('Payment was not completed. Refresh the booking before retrying.'));
    });
    instance.open();
  });
}
