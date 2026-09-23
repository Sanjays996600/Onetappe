import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { sha256Hex } from '../../security/crypto.js';
import { ConflictError, ValidationError } from '../errors.js';

const KEY_FORMAT = /^[A-Za-z0-9_-]{8,100}$/;

/**
 * The client-chosen `Idempotency-Key` header, required on requests that create records.
 * A retry with the same key returns the first result instead of creating a duplicate.
 */
export const IdempotencyKey = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const header = ctx.switchToHttp().getRequest<FastifyRequest>().headers['idempotency-key'];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key || !KEY_FORMAT.test(key)) {
    throw new ValidationError(
      'IDEMPOTENCY_KEY_REQUIRED',
      'Send a unique Idempotency-Key header (8–100 letters, digits, - or _)',
    );
  }
  return key;
});

/** Stable fingerprint of a request body (key order does not matter). */
export function requestHash(value: unknown): string {
  return sha256Hex(stableJson(value));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  // Request bodies are parsed JSON, so only undefined needs special handling.
  return value === undefined ? 'null' : JSON.stringify(value);
}

/** The same key was already used for a different request. */
export function keyReusedError(): ConflictError {
  return new ConflictError(
    'IDEMPOTENCY_KEY_REUSED',
    'This Idempotency-Key was already used for a different request. Use a new key.',
  );
}

/** A request key plus the fingerprint of what it asked for. */
export interface IdempotentRequest {
  readonly key: string;
  readonly hash: string;
}
