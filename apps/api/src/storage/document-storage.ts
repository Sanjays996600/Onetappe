/**
 * Private storage for restricted documents (worker ID, address proof, photos). Files
 * never pass through JSON API bodies and are never publicly addressable: the app receives
 * a short-lived, single-use upload target bound to one object, type and size limit, and
 * only the API reads files back (for scanning and for audited staff viewing).
 */
export interface UploadTarget {
  /** PUT: send the bytes as the body. POST: multipart form with `fields`, file last. */
  readonly method: 'PUT' | 'POST';
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly fields: Record<string, string>;
  readonly expiresAt: Date;
  readonly maxBytes: number;
}

export interface ObjectInfo {
  readonly size: number;
}

export interface DocumentStorage {
  readonly name: string;
  createUploadTarget(key: string, contentType: string, maxBytes: number): Promise<UploadTarget>;
  /** Size of a stored object, or null when nothing was uploaded. */
  head(key: string): Promise<ObjectInfo | null>;
  /** The object's bytes (objects are bounded by MAX_DOCUMENT_BYTES). */
  read(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export const DOCUMENT_STORAGE = Symbol('DOCUMENT_STORAGE');

export const ALLOWED_DOCUMENT_TYPES = ['image/jpeg', 'image/png', 'application/pdf'] as const;
export type DocumentContentType = (typeof ALLOWED_DOCUMENT_TYPES)[number];
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const UPLOAD_TTL_SECONDS = 5 * 60;

/**
 * What a file really is, from its first bytes (never from its name or declared type).
 * Anything else — HTML, SVG, executables, archives — is refused.
 */
export function detectContentType(bytes: Buffer): DocumentContentType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) return 'image/png';
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}
