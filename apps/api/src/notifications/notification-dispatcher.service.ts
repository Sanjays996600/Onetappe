import { Inject, Injectable } from '@nestjs/common';
import { DEFAULT_TIME_ZONE } from '@onetappe/domain';
import { sql, type Kysely, type UpdateObject } from 'kysely';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { CHANNEL_SENDERS, type ChannelSender } from './channels.js';
import type { NotificationChannel } from './events.js';
import { formatAmount, formatDateTime, renderTemplate } from './render.js';

export const DISPATCH_POLICY = {
  batchSize: 50,
  maxAttempts: 5,
  /** Minutes to wait after attempt n (1-based). */
  backoffMinutes: [1, 5, 15, 60],
  /** A message stuck in SENDING this long (crashed worker) is retried. */
  staleSendingMinutes: 10,
} as const;

/**
 * Delivers queued notifications. Rows are claimed with SKIP LOCKED so several workers can
 * run without sending a message twice; failures are retried with backoff.
 */
@Injectable()
export class NotificationDispatcher {
  private readonly senders: Map<NotificationChannel, ChannelSender>;

  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    @Inject(CHANNEL_SENDERS) senders: readonly ChannelSender[],
  ) {
    this.senders = new Map(senders.map((sender) => [sender.channel, sender]));
  }

  async dispatchDue(): Promise<number> {
    await this.db
      .updateTable('notification')
      .set({ status: 'QUEUED' })
      .where('status', '=', 'SENDING')
      .where(
        'next_attempt_at',
        '<',
        sql<Date>`now() - make_interval(mins => ${DISPATCH_POLICY.staleSendingMinutes})`,
      )
      .execute();

    const claimed = await this.db.transaction().execute(async (tx) => {
      const rows = await tx
        .selectFrom('notification')
        .select('id')
        .where('status', 'in', ['QUEUED', 'FAILED'])
        .where('attempts', '<', DISPATCH_POLICY.maxAttempts)
        .where('next_attempt_at', '<=', sql<Date>`now()`)
        .orderBy('next_attempt_at')
        .limit(DISPATCH_POLICY.batchSize)
        .forUpdate()
        .skipLocked()
        .execute();
      if (rows.length === 0) return [];
      await tx
        .updateTable('notification')
        .set({ status: 'SENDING', next_attempt_at: sql<Date>`now()` })
        .where(
          'id',
          'in',
          rows.map((r) => r.id),
        )
        .execute();
      return rows.map((r) => r.id);
    });

    for (const id of claimed) await this.deliver(id);
    return claimed.length;
  }

  private async deliver(id: string): Promise<void> {
    const row = await this.db
      .selectFrom('notification as n')
      .innerJoin('notification_template as t', 't.id', 'n.template_id')
      .innerJoin('app_user as u', 'u.id', 'n.user_id')
      .leftJoin('booking as b', 'b.id', 'n.booking_id')
      .leftJoin('city as c', 'c.id', 'b.city_id')
      .select([
        'n.id',
        'n.user_id',
        'n.channel',
        'n.locale',
        'n.variables',
        'n.attempts',
        't.title',
        't.body',
        't.provider_template_id',
        'u.phone_e164',
        'u.email',
        'c.time_zone',
      ])
      .where('n.id', '=', id)
      .executeTakeFirstOrThrow();

    const channel = row.channel as NotificationChannel;
    const variables = this.format(row.variables, row.locale, row.time_zone ?? DEFAULT_TIME_ZONE);
    const title = row.title ? renderTemplate(row.title, variables) : null;
    const body = renderTemplate(row.body, variables);

    if (channel === 'IN_APP') {
      // The in-app inbox reads the row itself; nothing to deliver.
      await this.mark(id, { status: 'SENT', sent_at: sql<Date>`now()` });
      return;
    }

    const recipients = await this.recipients(channel, row);
    const sender = this.senders.get(channel);
    if (recipients.length === 0 || !sender) {
      await this.mark(id, {
        status: 'SKIPPED',
        last_error: recipients.length === 0 ? 'NO_RECIPIENT' : 'NO_PROVIDER',
      });
      return;
    }

    try {
      let providerId = '';
      for (const recipient of recipients) {
        providerId = await sender.send({
          notificationId: id,
          channel,
          recipient,
          title,
          body,
          providerTemplateId: row.provider_template_id,
        });
      }
      await this.mark(id, {
        status: 'SENT',
        sent_at: sql<Date>`now()`,
        provider_message_id: providerId,
        attempts: row.attempts + 1,
      });
    } catch (error) {
      const attempts = row.attempts + 1;
      const wait =
        DISPATCH_POLICY.backoffMinutes[
          Math.min(attempts, DISPATCH_POLICY.backoffMinutes.length) - 1
        ] ?? 60;
      await this.mark(id, {
        status: 'FAILED',
        attempts,
        last_error: error instanceof Error ? error.message.slice(0, 500) : 'Unknown error',
        next_attempt_at: sql<Date>`now() + make_interval(mins => ${wait})`,
      });
    }
  }

  private async recipients(
    channel: NotificationChannel,
    row: { user_id: string; phone_e164: string | null; email: string | null },
  ): Promise<string[]> {
    switch (channel) {
      case 'SMS':
      case 'WHATSAPP':
        return row.phone_e164 ? [row.phone_e164] : [];
      case 'EMAIL':
        return row.email ? [row.email] : [];
      case 'PUSH': {
        const devices = await this.db
          .selectFrom('user_device')
          .select('push_token')
          .where('user_id', '=', row.user_id)
          .where('disabled_at', 'is', null)
          .where('push_token', 'is not', null)
          .execute();
        return devices.flatMap((d) => (d.push_token ? [d.push_token] : []));
      }
      case 'IN_APP':
        return [];
    }
  }

  private format(raw: unknown, locale: string, timeZone: string): Record<string, string> {
    const values = (raw ?? {}) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      if (value && typeof value === 'object' && '$date' in value) {
        out[key] = formatDateTime(new Date(String(value.$date)), timeZone, locale);
      } else if (typeof value === 'number' && /amount/i.test(key)) {
        out[key] = formatAmount(value, locale);
      } else {
        out[key] = String(value);
      }
    }
    return out;
  }

  private async mark(id: string, values: UpdateObject<DB, 'notification'>): Promise<void> {
    await this.db.updateTable('notification').set(values).where('id', '=', id).execute();
  }
}
