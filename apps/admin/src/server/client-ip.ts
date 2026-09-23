/**
 * The staff member's IP as seen by our own proxies: the X-Forwarded-For entry added by the
 * outermost trusted proxy. With no trusted proxy we cannot know it, so we do not claim one.
 */
export function clientIpFrom(forwardedFor: string | null, trustedHops: number): string | null {
  if (trustedHops <= 0 || !forwardedFor) return null;
  const chain = forwardedFor
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const ip = chain[chain.length - trustedHops];
  return ip && /^[0-9a-fA-F:.]+$/.test(ip) ? ip : null;
}
