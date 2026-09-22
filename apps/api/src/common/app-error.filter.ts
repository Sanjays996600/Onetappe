import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { AppError } from './errors.js';

/**
 * Renders application errors in one shape for every client:
 * `{ "error": { "code": "NO_AVAILABILITY", "message": "...", "details": {...} } }`.
 */
@Catch(AppError)
export class AppErrorFilter implements ExceptionFilter<AppError> {
  catch(error: AppError, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    void reply.status(error.httpStatus).send({
      error: { code: error.code, message: error.message, details: error.details ?? {} },
    });
  }
}
