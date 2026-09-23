import type { LoggerService, LogLevel } from '@nestjs/common';
import { redactText, redactValue } from './redact.js';
import { RequestContext } from './request-context.js';

const LEVELS: Record<string, number> = {
  fatal: 60,
  error: 50,
  warn: 40,
  log: 30,
  debug: 20,
  verbose: 10,
};

export interface LogSink {
  write(line: string): void;
}

/**
 * Structured logging: one JSON object per line on stdout, ready for any log pipeline
 * (CloudWatch, Loki, Datadog...). Each line carries the current request/job correlation
 * ids, and all text passes through PII/secret redaction.
 */
export class JsonLogger implements LoggerService {
  private readonly threshold: number;

  constructor(
    private readonly service: string,
    level: 'error' | 'warn' | 'info' | 'debug' = 'info',
    /** Where lines go (stdout; tests capture them). */
    public sink: LogSink = process.stdout,
  ) {
    this.threshold = { error: 50, warn: 40, info: 30, debug: 20 }[level];
  }

  log(message: unknown, ...params: unknown[]): void {
    this.write('log', message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.write('error', message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.write('warn', message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.write('verbose', message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.write('fatal', message, params);
  }

  setLogLevels(_levels: LogLevel[]): void {
    // Level is fixed by LOG_LEVEL at start-up.
  }

  /** A structured event (e.g. the access log) rather than a text message. */
  event(level: 'log' | 'warn' | 'error', msg: string, fields: Record<string, unknown>): void {
    if ((LEVELS[level] ?? 30) < this.threshold) return;
    this.emit(level, { msg, ...(redactValue(fields) as Record<string, unknown>) });
  }

  private write(level: string, message: unknown, params: unknown[]): void {
    if ((LEVELS[level] ?? 30) < this.threshold) return;
    // Nest passes (message, context) or (message, stack, context) for errors.
    const context = typeof params.at(-1) === 'string' ? (params.at(-1) as string) : undefined;
    const stack =
      level === 'error' && typeof params[0] === 'string' && params.length > 1
        ? params[0]
        : undefined;
    const text = typeof message === 'string' ? message : JSON.stringify(redactValue(message));
    this.emit(level, {
      context,
      msg: redactText(text),
      ...(stack ? { stack: redactText(stack) } : {}),
    });
  }

  private emit(level: string, fields: Record<string, unknown>): void {
    const ctx = RequestContext.current();
    const line = {
      time: new Date().toISOString(),
      level: level === 'log' ? 'info' : level,
      service: this.service,
      ...(ctx
        ? {
            requestId: ctx.requestId,
            ...(ctx.actorUserId ? { actorUserId: ctx.actorUserId } : {}),
            ...(ctx.bookingId ? { bookingId: ctx.bookingId } : {}),
            ...(ctx.job ? { job: ctx.job } : {}),
          }
        : {}),
      ...fields,
    };
    this.sink.write(`${JSON.stringify(line)}\n`);
  }
}
