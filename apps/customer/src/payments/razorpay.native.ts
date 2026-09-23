import RazorpayCheckout from 'react-native-razorpay';

export interface RazorpayCheckoutParams {
  keyId: string;
  orderId: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  contact: string;
}

/**
 * Opens Razorpay's own checkout. Card and UPI details are entered in Razorpay's screen,
 * never in ours. Whatever the result, the booking is confirmed only by the server (webhook
 * or its own check with Razorpay), never by this response.
 */
export async function openRazorpay(
  params: RazorpayCheckoutParams,
): Promise<'SUBMITTED' | 'CLOSED'> {
  try {
    await RazorpayCheckout.open({
      key: params.keyId,
      order_id: params.orderId,
      amount: params.amount,
      currency: params.currency,
      name: params.name,
      description: params.description,
      prefill: { contact: params.contact },
      theme: { color: '#0b5cad' },
    });
    return 'SUBMITTED';
  } catch {
    return 'CLOSED';
  }
}
