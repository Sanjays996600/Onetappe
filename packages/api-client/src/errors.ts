/** 401 codes that mean the session is over (other 401s, e.g. a wrong MFA code, are not). */
export const SESSION_ENDED_CODES: ReadonlySet<string> = new Set([
  'NOT_AUTHENTICATED',
  'SESSION_EXPIRED',
  'SESSION_IDLE',
  'TOKEN_INVALID',
  'TOKEN_EXPIRED',
  'REFRESH_TOKEN_INVALID',
  'SESSION_REVOKED',
]);

/** Codes produced by the client itself (the API's own codes come from its error body). */
export type ClientErrorCode = 'NETWORK_ERROR' | 'TIMEOUT' | 'BAD_RESPONSE';

/**
 * Every failed call. `code` is the API's stable error code (switch on it for messages),
 * or a client code when no answer arrived. `requestId` is what support asks for.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
    readonly requestId: string | null = null,
    /** Seconds the server asked us to wait (429 / 503). */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** No answer, or the server said "try again": safe to retry an idempotent request. */
  get isTransient(): boolean {
    return this.status === 0 || this.status === 503 || this.status === 502 || this.status === 504;
  }

  /** The person must sign in again. */
  get isSignedOut(): boolean {
    return this.status === 401 && SESSION_ENDED_CODES.has(this.code);
  }
}
