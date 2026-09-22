import { createHmac, randomBytes } from 'node:crypto';
import { safeEqual } from './crypto.js';

/**
 * Time-based one-time passwords (RFC 6238, HMAC-SHA1, 30-second steps, 6 digits) —
 * compatible with Google Authenticator, Microsoft Authenticator, 1Password, etc.
 */

const STEP_SECONDS = 30;
const DIGITS = 6;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32.charAt((value << (5 - bits)) & 31);
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A new 160-bit secret, base32-encoded for authenticator apps. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpStep(at: Date): number {
  return Math.floor(at.getTime() / 1000 / STEP_SECONDS);
}

export function totpAt(secretBase32: string, step: number, digits = DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

/**
 * Checks a code against the current step ±1 (clock drift). Returns the matching step so
 * the caller can refuse to accept the same step twice (replay protection).
 */
export function verifyTotp(secretBase32: string, code: string, at: Date): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = totpStep(at);
  for (const step of [current - 1, current, current + 1]) {
    if (safeEqual(totpAt(secretBase32, step), code)) return step;
  }
  return null;
}

export function otpauthUrl(secretBase32: string, account: string, issuer = 'One Tappe'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
