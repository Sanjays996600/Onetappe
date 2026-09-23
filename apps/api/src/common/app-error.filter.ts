import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { isDatabaseUnavailable } from '../database/database-errors.js';
import { AppError, ServiceUnavailableError } from './errors.js';

/**
 * One error shape for every client (Android, iOS, web):
 * `{ "error": { "code": "NO_AVAILABILITY", "message": "...", "details": {...}, "requestId": "..." } }`.
 * Unexpected errors are logged with the request id and never leak internals.
 */
@Catch()
export class AppErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const request = http.getRequest<FastifyRequest & { requestId?: string }>();
    const requestId = request.requestId ?? request.id;

    let status = 500;
    let body: { code: string; message: string; details: Record<string, unknown> } = {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong. Please try again.',
      details: {},
    };

    // Queries outside inTransaction reach here untranslated.
    if (!(error instanceof AppError) && isDatabaseUnavailable(error)) {
      this.logger.warn(`Database unavailable for request ${requestId}`);
      error = new ServiceUnavailableError(
        'TEMPORARILY_UNAVAILABLE',
        'The service is briefly unavailable. Please try again.',
      );
    }

    if (error instanceof AppError) {
      status = error.httpStatus;
      body = { code: error.code, message: error.message, details: { ...(error.details ?? {}) } };
      const retryAfter = error.details?.['retryAfterSeconds'];
      if ((status === 429 || status === 503) && typeof retryAfter === 'number')
        void reply.header('retry-after', String(retryAfter));
    } else if (error instanceof HttpException) {
      status = error.getStatus();
      body = {
        code:
          status === 400
            ? 'INVALID_REQUEST'
            : status === 404
              ? 'NOT_FOUND'
              : status === 413
                ? 'PAYLOAD_TOO_LARGE'
                : 'HTTP_ERROR',
        message: error.message,
        details: {},
      };
    } else if (isFastifyClientError(error)) {
      status = error.statusCode;
      body = { code: 'INVALID_REQUEST', message: error.message, details: {} };
    } else {
      this.logger.error(
        `Unhandled error for request ${requestId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    void reply.status(status).send({ error: { ...body, requestId } });
  }
}

function isFastifyClientError(error: unknown): error is { statusCode: number; message: string } {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return false;
  const { statusCode } = error;
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500;
}
