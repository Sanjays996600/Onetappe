import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DataCipher, hmacSha256Hex, safeEqual } from '../security/crypto.js';
import type { DocumentStorage, StoredDocument, UploadTarget } from './document-storage.js';

interface UploadClaims {
  readonly key: string;
  readonly contentType: string;
  readonly maxBytes: number;
  readonly exp: number;
}

const UPLOAD_TTL_SECONDS = 10 * 60;
const SAFE_KEY = /^[a-z0-9][a-z0-9/_-]{8,200}$/;

/**
 * Encrypted files on local disk, for local/test/staging. Upload links are HMAC-signed,
 * expire after ten minutes and are bound to one key, content type and size limit.
 */
export class LocalDocumentStorage implements DocumentStorage {
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

  async store(key: string, contentType: string, bytes: Buffer): Promise<void> {
    assertSafeKey(key);
    const file = this.fileFor(key);
    await mkdir(path.dirname(file), { recursive: true });
    const meta = Buffer.from(JSON.stringify({ contentType }));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(meta.length);
    // flag 'wx': an upload link can only ever write its file once.
    await writeFile(file, this.cipher.encryptBytes(Buffer.concat([header, meta, bytes])), {
      flag: 'wx',
    });
  }

  async exists(key: string): Promise<boolean> {
    assertSafeKey(key);
    return stat(this.fileFor(key)).then(
      () => true,
      () => false,
    );
  }

  async read(key: string): Promise<StoredDocument> {
    assertSafeKey(key);
    const plain = this.cipher.decryptBytes(await readFile(this.fileFor(key)));
    const metaLength = plain.readUInt32BE(0);
    const meta = JSON.parse(plain.subarray(4, 4 + metaLength).toString('utf8')) as {
      contentType: string;
    };
    return { bytes: plain.subarray(4 + metaLength), contentType: meta.contentType };
  }

  private fileFor(key: string): string {
    return path.join(this.directory, `${key}.bin`);
  }
}

function assertSafeKey(key: string): void {
  if (!SAFE_KEY.test(key) || key.includes('..')) throw new Error(`Unsafe storage key: ${key}`);
}
