import {
  AppError,
  BusinessRuleError,
  ConflictError,
  ServiceUnavailableError,
} from '../common/errors.js';

/** Subset of the fields node-postgres puts on a server error. */
export interface PgError {
  readonly code: string;
  readonly message: string;
  readonly constraint?: string;
  readonly detail?: string;
}

export function isPgError(error: unknown): error is PgError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    'severity' in error
  );
}

export const PG = {
  UNIQUE_VIOLATION: '23505',
  EXCLUSION_VIOLATION: '23P01',
  CHECK_VIOLATION: '23514',
  FOREIGN_KEY_VIOLATION: '23503',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
  APPEND_ONLY: 'OT001',
  INVALID_TRANSITION: 'OT002',
  IMMUTABLE_FIELD: 'OT003',
  MISSING_CONTEXT: 'OT004',
  RESERVATION_NOT_ALLOWED: 'OT005',
  DELETE_FORBIDDEN: 'OT006',
  REFUND_EXCEEDS_PAYMENT: 'OT007',
  BUSINESS_RULE: 'OT008',
} as const;

/** SQLSTATEs meaning the database could not serve the request right now. */
const UNAVAILABLE_SQLSTATES = new Set([
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '57014', // query_canceled (statement timeout)
  '25P03', // idle_in_transaction_session_timeout
]);

const UNAVAILABLE_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']);

/**
 * True when the error means "the database is unreachable or overloaded", as opposed to a
 * problem with the request. Covers server-side SQLSTATEs (class 08 and the list above),
 * socket errors and node-postgres pool/connection failures.
 */
export function isDatabaseUnavailable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  if (code && (code.startsWith('08') || UNAVAILABLE_SQLSTATES.has(code))) return true;
  if (code && UNAVAILABLE_NODE_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : '';
  return (
    message.includes('timeout exceeded when trying to connect') ||
    message.includes('Connection terminated') ||
    message.includes('Client has encountered a connection error')
  );
}

/** The worker already has an overlapping active reservation. */
export function isReservationOverlap(error: unknown): boolean {
  return (
    isPgError(error) &&
    error.code === PG.EXCLUSION_VIOLATION &&
    error.constraint === 'worker_reservation_no_overlap'
  );
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  return (
    isPgError(error) &&
    error.code === PG.UNIQUE_VIOLATION &&
    (constraint === undefined || error.constraint === constraint)
  );
}

/**
 * Maps trigger and constraint failures to application errors. Anything unrecognised is
 * returned unchanged (and becomes a 500 at the HTTP layer).
 */
export function translateDatabaseError(error: unknown): unknown {
  if (error instanceof AppError) return error;
  if (isDatabaseUnavailable(error)) {
    return new ServiceUnavailableError(
      'TEMPORARILY_UNAVAILABLE',
      'The service is briefly unavailable. Please try again.',
    );
  }
  if (!isPgError(error)) return error;

  switch (error.code) {
    case PG.EXCLUSION_VIOLATION:
      return new ConflictError('TIME_CONFLICT', 'The requested time overlaps an existing booking', {
        constraint: error.constraint,
      });
    case PG.UNIQUE_VIOLATION:
      return new ConflictError('DUPLICATE', 'A record with the same unique value already exists', {
        constraint: error.constraint,
      });
    case PG.INVALID_TRANSITION:
      return new BusinessRuleError('INVALID_STATUS_TRANSITION', error.message);
    case PG.IMMUTABLE_FIELD:
      return new BusinessRuleError('IMMUTABLE_FIELD', error.message);
    case PG.APPEND_ONLY:
    case PG.DELETE_FORBIDDEN:
      return new BusinessRuleError('HISTORY_IS_PERMANENT', error.message);
    case PG.RESERVATION_NOT_ALLOWED:
      return new BusinessRuleError('RESERVATION_NOT_ALLOWED', error.message, {
        reason: error.detail,
      });
    case PG.REFUND_EXCEEDS_PAYMENT:
      return new BusinessRuleError('REFUND_NOT_ALLOWED', error.message);
    case PG.BUSINESS_RULE:
    case PG.CHECK_VIOLATION:
      return new BusinessRuleError('BUSINESS_RULE_VIOLATED', error.message, {
        constraint: error.constraint,
      });
    default:
      return error;
  }
}
