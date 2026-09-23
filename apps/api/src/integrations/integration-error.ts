/**
 * How a failed delivery should be treated:
 *   RETRYABLE      network error, timeout or 5xx: try again later with backoff
 *   RATE_LIMITED   the external system asked us to slow down: pause the whole target
 *   CREDENTIALS    the token/credentials are rejected: pause the target, alert, keep events
 *   CONFIGURATION  our settings are missing or invalid: pause the target, alert, keep events
 *   PERMANENT      the request itself is wrong (4xx): park the event as DEAD for a person
 */
export type FailureKind =
  'RETRYABLE' | 'RATE_LIMITED' | 'CREDENTIALS' | 'CONFIGURATION' | 'PERMANENT';

export class IntegrationError extends Error {
  override readonly name = 'IntegrationError';

  constructor(
    readonly kind: FailureKind,
    message: string,
    readonly httpStatus: number | null = null,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
  }
}
