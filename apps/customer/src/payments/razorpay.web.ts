import type { RazorpayCheckoutParams } from './razorpay.native';

/** The web build exists for automated tests only; real payments happen in the phone apps. */
export function openRazorpay(_params: RazorpayCheckoutParams): Promise<'SUBMITTED' | 'CLOSED'> {
  return Promise.reject(new Error('Razorpay checkout is available in the Android and iOS apps'));
}
