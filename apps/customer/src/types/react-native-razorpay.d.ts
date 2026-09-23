// The package ships without types; this covers the one call the app makes.
declare module 'react-native-razorpay' {
  interface CheckoutOptions {
    key: string;
    order_id: string;
    amount: number;
    currency: string;
    name: string;
    description: string;
    prefill?: { contact?: string; email?: string; name?: string };
    theme?: { color?: string };
  }
  const RazorpayCheckout: {
    open(options: CheckoutOptions): Promise<{
      razorpay_payment_id: string;
      razorpay_order_id: string;
      razorpay_signature: string;
    }>;
  };
  export default RazorpayCheckout;
}
