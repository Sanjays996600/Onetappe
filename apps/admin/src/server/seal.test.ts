import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { jwtExpiry, seal, unseal } from './seal';

const key = randomBytes(32);
const later = Date.now() + 60_000;

describe('sealed cookies', () => {
  it('round-trips a value', () => {
    expect(unseal(key, 'session', seal(key, 'session', { a: 1 }, later))).toEqual({ a: 1 });
  });

  it('rejects tampering, another purpose, another key and expiry', () => {
    const sealed = seal(key, 'session', { a: 1 }, later);
    const flipped = Buffer.from(sealed, 'base64url');
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
    expect(unseal(key, 'session', flipped.toString('base64url'))).toBeNull();
    expect(unseal(key, 'mfa', sealed)).toBeNull();
    expect(unseal(randomBytes(32), 'session', sealed)).toBeNull();
    expect(unseal(key, 'session', seal(key, 'session', { a: 1 }, Date.now() - 1))).toBeNull();
    expect(unseal(key, 'session', 'garbage')).toBeNull();
    expect(unseal(key, 'session', undefined)).toBeNull();
  });

  it('reads a JWT expiry without trusting it', () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1_900_000_000 })).toString('base64url');
    expect(jwtExpiry(`h.${payload}.s`)).toBe(1_900_000_000_000);
    expect(jwtExpiry('nonsense')).toBe(0);
  });
});
