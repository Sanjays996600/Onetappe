/**
 * The simulated gateway of local, test and demo environments (the API refuses the sandbox
 * in production, so a production build never sees it). It stands in for the gateway's own
 * hosted page: the result arrives at the API as a signed webhook, like the real one.
 */
export async function sandboxCheckout(
  apiUrl: string,
  orderId: string,
  outcome: 'capture' | 'fail',
): Promise<void> {
  const res = await fetch(`${apiUrl}/sandbox/payments/${encodeURIComponent(orderId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ outcome }),
  });
  if (!res.ok) throw new Error(`Sandbox payment failed (${String(res.status)})`);
}
