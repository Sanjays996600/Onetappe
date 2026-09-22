/**
 * Application errors carry a stable machine-readable `code` that the mobile apps and the
 * admin panel can switch on, plus the HTTP status the API should answer with.
 */
export abstract class AppError extends Error {
  abstract readonly httpStatus: number;

  constructor(
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  readonly httpStatus = 404;
  constructor(entity: string, id: string) {
    super(`${entity.toUpperCase()}_NOT_FOUND`, `${entity} ${id} was not found`, { id });
  }
}

export class ValidationError extends AppError {
  readonly httpStatus = 400;
}

export class ForbiddenError extends AppError {
  readonly httpStatus = 403;
}

/** The request is valid but conflicts with current state (capacity, status, duplicates). */
export class ConflictError extends AppError {
  readonly httpStatus = 409;
}

/** A business rule enforced by the database or domain was violated. */
export class BusinessRuleError extends AppError {
  readonly httpStatus = 422;
}

/** Too many attempts; the client should wait `retryAfterSeconds`. */
export class RateLimitedError extends AppError {
  readonly httpStatus = 429;
  constructor(code: string, message: string, retryAfterSeconds: number) {
    super(code, message, { retryAfterSeconds });
  }
}

/** Missing, invalid or expired credentials. */
export class UnauthorizedError extends AppError {
  readonly httpStatus = 401;
}
