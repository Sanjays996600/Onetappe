import { Global, Module } from '@nestjs/common';
import { CHANNEL_SENDERS, LogChannelSender, type ChannelSender } from './channels.js';
import { NOTIFICATION_CHANNELS } from './events.js';
import { NotificationDispatcher } from './notification-dispatcher.service.js';
import { NotificationService } from './notification.service.js';

@Global()
@Module({
  providers: [
    NotificationService,
    NotificationDispatcher,
    {
      // Real providers (FCM, SMS gateway, WhatsApp BSP, email) replace these per channel
      // once the company accounts exist; nothing else changes.
      provide: CHANNEL_SENDERS,
      useFactory: (): ChannelSender[] =>
        NOTIFICATION_CHANNELS.filter((c) => c !== 'IN_APP').map((c) => new LogChannelSender(c)),
    },
  ],
  exports: [NotificationService, NotificationDispatcher, CHANNEL_SENDERS],
})
export class NotificationModule {}
