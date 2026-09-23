import { Logger } from '@nestjs/common';
import type { NotificationChannel } from './events.js';

export interface OutboundMessage {
  readonly notificationId: string;
  readonly channel: NotificationChannel;
  /** Phone number, email address or push token, resolved at send time. */
  readonly recipient: string;
  readonly title: string | null;
  readonly body: string;
  /** Template registered with the provider (DLT template for SMS, etc.). */
  readonly providerTemplateId: string | null;
  /** Formatted template variables, for providers that fill registered templates. */
  readonly variables: Readonly<Record<string, string>>;
  /** Small non-personal data for the app (e.g. which booking to open). */
  readonly data: Readonly<Record<string, string>>;
}

/**
 * How a failed send should be treated:
 *   RETRYABLE          provider unavailable, rate limited, timeout: retry with backoff
 *   PERMANENT          the request itself is refused (bad template, bad config): do not retry
 *   INVALID_RECIPIENT  this address/token is no longer valid (e.g. app uninstalled)
 */
export type ChannelFailureKind = 'RETRYABLE' | 'PERMANENT' | 'INVALID_RECIPIENT';

export class ChannelError extends Error {
  override readonly name = 'ChannelError';
  constructor(
    readonly kind: ChannelFailureKind,
    message: string,
  ) {
    super(message);
  }
}

/** One implementation per channel provider (FCM, MSG91, ZeptoMail…). */
export interface ChannelSender {
  readonly channel: NotificationChannel;
  readonly provider: string;
  /** Returns the provider's message id. Throws ChannelError on failure. */
  send(message: OutboundMessage): Promise<string>;
}

export const CHANNEL_SENDERS = Symbol('CHANNEL_SENDERS');

/**
 * Local development and tests only (refused in staging/production): records messages
 * without delivering them. Logs only the event size and recipient's last digits.
 */
export class LogChannelSender implements ChannelSender {
  readonly provider = 'log';
  private readonly logger = new Logger('Notifications');
  readonly sent: OutboundMessage[] = [];

  constructor(readonly channel: NotificationChannel) {}

  send(message: OutboundMessage): Promise<string> {
    this.sent.push(message);
    this.logger.log(
      `[${message.channel}] to …${message.recipient.slice(-4)} (${String(message.body.length)} chars, not delivered: log provider)`,
    );
    return Promise.resolve(`log-${message.notificationId}`);
  }
}

/** Shared HTTP helper: timeout, and failures classified as ChannelError. */
export async function postJson(
  url: string,
  init: { headers: Record<string, string>; body: string; timeoutMs: number },
): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: init.headers,
      body: init.body,
      signal: AbortSignal.timeout(init.timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    throw new ChannelError('RETRYABLE', timedOut ? 'Provider timed out' : 'Provider unreachable');
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: response.status, body };
}
