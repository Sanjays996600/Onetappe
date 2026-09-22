/**
 * Storage for restricted documents (worker ID, address proof, photos). Files never pass
 * through JSON API bodies: the app receives a short-lived upload target and sends the
 * bytes there (a presigned URL for cloud storage; a signed API route for local storage).
 */
export interface UploadTarget {
  readonly method: 'PUT';
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly expiresAt: Date;
  readonly maxBytes: number;
}

export interface StoredDocument {
  readonly bytes: Buffer;
  readonly contentType: string;
}

export interface DocumentStorage {
  createUploadTarget(key: string, contentType: string, maxBytes: number): Promise<UploadTarget>;
  exists(key: string): Promise<boolean>;
  read(key: string): Promise<StoredDocument>;
}

export const DOCUMENT_STORAGE = Symbol('DOCUMENT_STORAGE');

export const ALLOWED_DOCUMENT_TYPES = ['image/jpeg', 'image/png', 'application/pdf'] as const;
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
