import { Global, Module } from '@nestjs/common';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { CHANNEL_SENDERS, LogChannelSender, type ChannelSender } from './channels.js';
import { NotificationDispatcher } from './notification-dispatcher.service.js';
import { NotificationService } from './notification.service.js';
import { FcmPushSender } from './providers/fcm-push.sender.js';
import { Msg91SmsSender } from './providers/msg91-sms.sender.js';
import { ZeptoMailEmailSender } from './providers/zeptomail-email.sender.js';

/**
 * One sender per channel, chosen by configuration. A channel set to `none` has no sender:
 * its messages are recorded as SKIPPED (NO_PROVIDER), never falsely as sent. Required
 * settings per provider are enforced by the environment schema.
 */
export function channelSenders(env: Env): ChannelSender[] {
  const senders: ChannelSender[] = [];
  const timeoutMs = env.NOTIFICATION_HTTP_TIMEOUT_MS;

  if (env.PUSH_PROVIDER === 'log') senders.push(new LogChannelSender('PUSH'));
  if (env.PUSH_PROVIDER === 'fcm') {
    senders.push(
      new FcmPushSender({
        projectId: env.FCM_PROJECT_ID ?? '',
        clientEmail: env.FCM_CLIENT_EMAIL ?? '',
        privateKey: (env.FCM_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
        apiUrl: env.FCM_API_URL,
        tokenUrl: env.GOOGLE_OAUTH_TOKEN_URL,
        timeoutMs,
      }),
    );
  }

  if (env.SMS_PROVIDER === 'log') senders.push(new LogChannelSender('SMS'));
  if (env.SMS_PROVIDER === 'msg91') {
    senders.push(
      new Msg91SmsSender({
        authKey: env.MSG91_AUTH_KEY ?? '',
        apiUrl: env.MSG91_API_URL,
        timeoutMs,
      }),
    );
  }

  if (env.WHATSAPP_PROVIDER === 'log') senders.push(new LogChannelSender('WHATSAPP'));

  if (env.EMAIL_PROVIDER === 'log') senders.push(new LogChannelSender('EMAIL'));
  if (env.EMAIL_PROVIDER === 'zeptomail') {
    senders.push(
      new ZeptoMailEmailSender({
        token: env.ZEPTOMAIL_TOKEN ?? '',
        apiUrl: env.ZEPTOMAIL_API_URL,
        fromAddress: env.EMAIL_FROM_ADDRESS ?? '',
        fromName: env.EMAIL_FROM_NAME,
        timeoutMs,
      }),
    );
  }
  return senders;
}

@Global()
@Module({
  providers: [
    NotificationService,
    NotificationDispatcher,
    { provide: CHANNEL_SENDERS, inject: [ENV], useFactory: channelSenders },
  ],
  exports: [NotificationService, NotificationDispatcher, CHANNEL_SENDERS],
})
export class NotificationModule {}
