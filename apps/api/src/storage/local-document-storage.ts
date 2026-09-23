import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DataCipher, hmacSha256Hex, safeEqual } from '../security/crypto.js';
import {
  UPLOAD_TTL_SECONDS,
  type DocumentStorage,
  type ObjectInfo,
  type UploadTarget,
} from './document-storage.js';

interface UploadClaims {
  readonly key: string;
  readonly contentType: string;
  readonly maxBytes: number;
  readonly exp: number;
}

const SAFE_KEY = /^[a-z0-9][a-z0-9/_-]{8,200}$/;

/**
 * Encrypted files on local disk, for local development and tests only (production uses
 * S3). Upload links are HMAC-signed, expire after five minutes and are bound to one key,
 * content type and size limit; a link can write its file only once.
 */
export class LocalDocumentStorage implements DocumentStorage {
  readonly name = 'local';
  private readonly cipher: DataCipher;
  private readonly signingKey: string;

  constructor(
    private readonly directory: string,
    encryptionKey: string,
    private readonly publicApiUrl: string,
  ) {
    this.cipher = new DataCipher(encryptionKey);
    this.signingKey = hmacSha256Hex(encryptionKey, 'document-upload-links');
  }

  createUploadTarget(key: string, contentType: string, maxBytes: number): Promise<UploadTarget> {
    assertSafeKey(key);
    const exp = Math.floor(Date.now() / 1000) + UPLOAD_TTL_SECONDS;
    const payload = Buffer.from(
      JSON.stringify({ key, contentType, maxBytes, exp } satisfies UploadClaims),
    ).toString('base64url');
    const token = `${payload}.${hmacSha256Hex(this.signingKey, payload)}`;
    return Promise.resolve({
      method: 'PUT',
      url: `${this.publicApiUrl.replace(/\/$/, '')}/api/v1/uploads?token=${encodeURIComponent(token)}`,
      headers: { 'content-type': 'application/octet-stream' },
      fields: {},
      expiresAt: new Date(exp * 1000),
      maxBytes,
    });
  }

  /** Validates an upload token; returns its claims or null. */
  verifyUploadToken(token: string): UploadClaims | null {
    const [payload, signature] = token.split('.');
    if (!payload || !signature || !safeEqual(hmacSha256Hex(this.signingKey, payload), signature))
      return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as UploadClaims;
    return claims.exp * 1000 > Date.now() ? claims : null;
  }

  async store(key: string, bytes: Buffer): Promise<void> {
    assertSafeKey(key);
    const file = this.fileFor(key);
    await mkdir(path.dirname(file), { recursive: true });
    // flag 'wx': an upload link can only ever write its file once.
    await writeFile(file, this.cipher.encryptBytes(bytes), { flag: 'wx' });
  }

  async head(key: string): Promise<ObjectInfo | null> {
    assertSafeKey(key);
    const exists = await stat(this.fileFor(key)).then(
      () => true,
      () => false,
    );
    return exists ? { size: (await this.read(key)).length } : null;
  }

  async read(key: string): Promise<Buffer> {
    assertSafeKey(key);
    return this.cipher.decryptBytes(await readFile(this.fileFor(key)));
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    await rm(this.fileFor(key), { force: true });
  }

  private fileFor(key: string): string {
    return path.join(this.directory, `${key}.bin`);
  }
}

function assertSafeKey(key: string): void {
  if (!SAFE_KEY.test(key) || key.includes('..')) throw new Error(`Unsafe storage key: ${key}`);
}
