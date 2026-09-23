import { describe, expect, it } from 'vitest';
import { clientIpFrom } from './client-ip';

describe('clientIpFrom', () => {
  it('takes the entry added by the trusted proxy, ignoring what the client claimed', () => {
    expect(clientIpFrom('198.51.100.66, 203.0.113.9', 1)).toBe('203.0.113.9');
    expect(clientIpFrom('198.51.100.66, 203.0.113.9, 10.0.0.2', 2)).toBe('203.0.113.9');
  });

  it('claims nothing without trusted proxies or a usable entry', () => {
    expect(clientIpFrom('203.0.113.9', 0)).toBeNull();
    expect(clientIpFrom(null, 1)).toBeNull();
    expect(clientIpFrom('203.0.113.9', 3)).toBeNull();
    expect(clientIpFrom('<script>', 1)).toBeNull();
  });
});
