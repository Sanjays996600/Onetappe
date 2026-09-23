import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 1;

/**
 * Encrypts and authenticates a small JSON value for a cookie (AES-256-GCM). The browser
 * can neither read nor alter it; `purpose` binds it to one use so a sealed MFA challenge
 * cannot be replayed as a session. Output: base64url(version | iv | tag | ciphertext).
 */
export function seal(key: Buffer, purpose: string, value: unknown, expiresAt: number): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(purpose));
  const body = Buffer.concat([
    cipher.update(JSON.stringify({ v: value, exp: expiresAt }), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]).toString(
    'base64url',
  );
}

/** The sealed value, or null when missing, tampered with, for another purpose or expired. */
export function unseal(
  key: Buffer,
  purpose: string,
  sealed: string | undefined,
  now = Date.now(),
): unknown {
  if (!sealed) return null;
  try {
    const raw = Buffer.from(sealed, 'base64url');
    if (raw[0] !== VERSION || raw.length < 1 + 12 + 16 + 1) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(1, 13));
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(raw.subarray(13, 29));
    const text = Buffer.concat([decipher.update(raw.subarray(29)), decipher.final()]).toString(
      'utf8',
    );
    const parsed = JSON.parse(text) as { v: unknown; exp: number };
    return parsed.exp > now ? parsed.v : null;
  } catch {
    return null;
  }
}

/** Expiry of a JWT (ms) from its payload; used only to schedule a refresh, never to trust it. */
export function jwtExpiry(token: string): number {
  const payload = token.split('.')[1];
  if (!payload) return 0;
  try {
    const exp = (
      JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown }
    ).exp;
    return typeof exp === 'number' ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}
