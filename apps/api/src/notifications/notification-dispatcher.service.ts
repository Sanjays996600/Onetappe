import { Inject, Injectable } from '@nestjs/common';
import { DEFAULT_TIME_ZONE } from '@onetappe/domain';
import { sql, type Kysely, type UpdateObject } from 'kysely';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { CHANNEL_SENDERS, ChannelError, type ChannelSender } from './channels.js';
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
        'n.booking_id',
        'n.channel',
        'n.locale',
        'n.variables',
        'n.attempts',
        't.code',
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

    // Routing may have been switched off after the message was queued.
    const route = await this.db
      .selectFrom('notification_route')
      .select('is_enabled')
      .where('event_code', '=', row.code)
      .where('channel', '=', channel)
      .executeTakeFirst();
    if (!route?.is_enabled) return this.skip(id, 'ROUTE_DISABLED');

    const sender = this.senders.get(channel);
    if (!sender) return this.skip(id, 'NO_PROVIDER');
    if (channel === 'WHATSAPP' && !(await this.hasConsent(row.user_id, 'WHATSAPP'))) {
      return this.skip(id, 'NO_CONSENT');
    }
    const recipients = await this.recipients(channel, row);
    if (recipients.length === 0) return this.skip(id, 'NO_RECIPIENT');

    const outcomes = await Promise.all(
      recipients.map(async (recipient) => {
        try {
          const providerId = await sender.send({
            notificationId: id,
            channel,
            recipient: recipient.address,
            title,
            body,
            providerTemplateId: row.provider_template_id,
            variables,
            data: { event: row.code, ...(row.booking_id ? { bookingId: row.booking_id } : {}) },
          });
          return { ok: true as const, providerId };
        } catch (error) {
          const failure =
            error instanceof ChannelError
              ? error
              : new ChannelError('RETRYABLE', error instanceof Error ? error.message : 'Unknown');
          if (failure.kind === 'INVALID_RECIPIENT' && recipient.deviceId) {
            // The app was uninstalled or the token rotated: stop sending to it.
            await this.db
              .updateTable('user_device')
              .set({ disabled_at: sql<Date>`now()` })
              .where('id', '=', recipient.deviceId)
              .execute();
          }
          return { ok: false as const, failure };
        }
      }),
    );

    const attempts = row.attempts + 1;
    const delivered = outcomes.find((o) => o.ok);
    if (delivered) {
      // At least one device/address received it. Others that failed are not retried,
      // so nobody gets the same message twice.
      await this.mark(id, {
        status: 'SENT',
        sent_at: sql<Date>`now()`,
        provider_message_id: delivered.providerId,
        attempts,
        last_error: null,
      });
      return;
    }
    const failures = outcomes.flatMap((o) => (o.ok ? [] : [o.failure]));
    const retryable = failures.some((f) => f.kind === 'RETRYABLE');
    const message = failures
      .map((f) => f.message)
      .join('; ')
      .slice(0, 500);
    if (!retryable) {
      // Nothing will change by retrying (invalid recipient, refused template): stop here.
      await this.mark(id, {
        status: 'FAILED',
        attempts: DISPATCH_POLICY.maxAttempts,
        last_error: message,
      });
      return;
    }
    const wait =
      DISPATCH_POLICY.backoffMinutes[
        Math.min(attempts, DISPATCH_POLICY.backoffMinutes.length) - 1
      ] ?? 60;
    await this.mark(id, {
      status: 'FAILED',
      attempts,
      last_error: message,
      next_attempt_at: sql<Date>`now() + make_interval(mins => ${wait})`,
    });
  }

  private async skip(
    id: string,
    reason: 'NO_RECIPIENT' | 'NO_PROVIDER' | 'NO_CONSENT' | 'ROUTE_DISABLED',
  ): Promise<void> {
    await this.mark(id, { status: 'SKIPPED', skipped_reason: reason, last_error: reason });
  }

  private async hasConsent(userId: string, purpose: 'WHATSAPP'): Promise<boolean> {
    const consent = await this.db
      .selectFrom('consent_record')
      .select('id')
      .where('user_id', '=', userId)
      .where('purpose', '=', purpose)
      .where('withdrawn_at', 'is', null)
      .executeTakeFirst();
    return consent !== undefined;
  }

  private async recipients(
    channel: NotificationChannel,
    row: { user_id: string; phone_e164: string | null; email: string | null },
  ): Promise<Array<{ address: string; deviceId?: string }>> {
    switch (channel) {
      case 'SMS':
      case 'WHATSAPP':
        return row.phone_e164 ? [{ address: row.phone_e164 }] : [];
      case 'EMAIL':
        return row.email ? [{ address: row.email }] : [];
      case 'PUSH': {
        const devices = await this.db
          .selectFrom('user_device')
          .select(['id', 'push_token'])
          .where('user_id', '=', row.user_id)
          .where('disabled_at', 'is', null)
          .where('push_token', 'is not', null)
          .execute();
        return devices.flatMap((d) =>
          d.push_token ? [{ address: d.push_token, deviceId: d.id }] : [],
        );
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
