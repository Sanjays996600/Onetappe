import { Logger } from '@nestjs/common';
import type { NotificationChannel } from './events.js';

export interface OutboundMessage {
  readonly notificationId: string;
  readonly channel: NotificationChannel;
  /** Phone number, email address or push token, resolved at send time. */
  readonly recipient: string;
  readonly title: string | null;
  readonly body: string;
  readonly providerTemplateId: string | null;
}

/** One implementation per channel provider (FCM, an SMS gateway, WhatsApp, email…). */
export interface ChannelSender {
  readonly channel: NotificationChannel;
  /** Returns the provider's message id. Throws on failure (the dispatcher retries). */
  send(message: OutboundMessage): Promise<string>;
}

export const CHANNEL_SENDERS = Symbol('CHANNEL_SENDERS');

/**
 * Records messages without delivering them. Used until real providers are configured;
 * nothing personal is logged beyond the last digits of the recipient.
 */
export class LogChannelSender implements ChannelSender {
  private readonly logger = new Logger('Notifications');
  readonly sent: OutboundMessage[] = [];

  constructor(readonly channel: NotificationChannel) {}

  send(message: OutboundMessage): Promise<string> {
    this.sent.push(message);
    this.logger.log(
      `[${message.channel}] to …${message.recipient.slice(-4)}: ${message.title ?? ''} ${message.body}`,
    );
    return Promise.resolve(`log-${message.notificationId}`);
  }
}
