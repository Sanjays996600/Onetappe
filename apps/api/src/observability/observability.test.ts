import { describe, expect, it } from 'vitest';
import { JsonLogger } from './json-logger.js';
import { redactText, redactValue } from './redact.js';
import { RequestContext } from './request-context.js';

describe('redaction', () => {
  it('masks phone numbers and emails in free text', () => {
    expect(redactText('Call +91 98765 43210 or 9876543210 now')).toBe(
      'Call ******3210 or ******3210 now',
    );
    expect(redactText('mail anita.sharma@example.com')).toBe('mail a***@example.com');
  });

  it('removes tokens and secrets from text', () => {
    expect(redactText('Authorization: Bearer abc.def-123')).toBe(
      'Authorization: Bearer [REDACTED]',
    );
    expect(redactText('Zoho-oauthtoken 1000.abcdef')).toBe('Zoho-oauthtoken [REDACTED]');
    expect(redactText('/uploads?token=eyJhbGciOi.secretpart&x=1')).toBe(
      '/uploads?token=[REDACTED]&x=1',
    );
    expect(redactText('jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4')).toBe(
      'jwt [REDACTED_TOKEN]',
    );
  });

  it('leaves ids, codes, amounts and dates readable', () => {
    const text =
      'Booking OT00000042 (8f14e45f-ceea-467f-a0e6-6b4f5e2c1a3b) paid 58882 paise on 2026-09-23';
    expect(redactText(text)).toBe(text);
  });

  it('drops sensitive fields entirely from structured values', () => {
    expect(
      redactValue({ phone: '+919876543210', nested: { address: 'A-101', bookingId: 'b-1' }, n: 3 }),
    ).toEqual({ phone: '[REDACTED]', nested: { address: '[REDACTED]', bookingId: 'b-1' }, n: 3 });
  });
});

describe('JSON logger', () => {
  function capture() {
    const lines: Array<Record<string, unknown>> = [];
    const logger = new JsonLogger('test', 'info', {
      write: (line) => {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    });
    return { lines, logger };
  }

  it('writes one JSON object per line with correlation ids from the current context', () => {
    const { lines, logger } = capture();
    RequestContext.run({ requestId: 'req-123' }, () => {
      RequestContext.annotate({ bookingId: 'booking-1', actorUserId: 'user-1' });
      logger.log('Booking confirmed', 'Dispatch');
    });
    expect(lines[0]).toMatchObject({
      level: 'info',
      service: 'test',
      context: 'Dispatch',
      msg: 'Booking confirmed',
      requestId: 'req-123',
      bookingId: 'booking-1',
      actorUserId: 'user-1',
    });
  });

  it('redacts personal data in messages and stacks, and respects the level', () => {
    const { lines, logger } = capture();
    logger.error('Failed for +919876543210', 'Error: at user x@y.com', 'Payments');
    logger.debug('not written at info level');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['msg']).toBe('Failed for ******3210');
    expect(lines[0]?.['stack']).toBe('Error: at user x***@y.com');
  });
});
