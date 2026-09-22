import { describe, expect, it } from 'vitest';
import { DataCipher, hashPassword, passwordProblems, verifyPassword } from './crypto.js';
import { base32Decode, base32Encode, totpAt, verifyTotp } from './totp.js';

describe('TOTP (RFC 6238 appendix B, SHA-1)', () => {
  // Secret "12345678901234567890"; expected 8-digit values from the RFC.
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  const vectors: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  for (const [seconds, expected] of vectors) {
    it(`T=${seconds}`, () => {
      expect(totpAt(secret, Math.floor(seconds / 30), 8)).toBe(expected);
    });
  }

  it('accepts ±1 step of drift and reports the step, rejects anything else', () => {
    const at = new Date(1_700_000_000_000);
    const step = Math.floor(at.getTime() / 30_000);
    expect(verifyTotp(secret, totpAt(secret, step), at)).toBe(step);
    expect(verifyTotp(secret, totpAt(secret, step - 1), at)).toBe(step - 1);
    expect(verifyTotp(secret, totpAt(secret, step + 2), at)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', at)).toBeNull();
  });

  it('round-trips base32', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 7]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });
});

describe('passwords', () => {
  it('hashes with a salt and verifies', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await hashPassword('correct horse battery staple')).not.toBe(hash);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong horse battery staple', hash)).toBe(false);
    expect(await verifyPassword('anything', 'garbage')).toBe(false);
  });

  it('enforces a minimum length', () => {
    expect(passwordProblems('short')).toContain('at least 12 characters');
    expect(passwordProblems('a long enough passphrase')).toEqual([]);
  });
});

describe('DataCipher', () => {
  const key = Buffer.alloc(32, 7).toString('base64');

  it('encrypts with a fresh IV and decrypts', () => {
    const cipher = new DataCipher(key);
    const a = cipher.encrypt('JBSWY3DPEHPK3PXP');
    const b = cipher.encrypt('JBSWY3DPEHPK3PXP');
    expect(a.equals(b)).toBe(false);
    expect(cipher.decrypt(a)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('detects tampering', () => {
    const cipher = new DataCipher(key);
    const payload = cipher.encrypt('secret');
    payload[payload.length - 1] = (payload[payload.length - 1] ?? 0) ^ 1;
    expect(() => cipher.decrypt(payload)).toThrow();
  });
});
