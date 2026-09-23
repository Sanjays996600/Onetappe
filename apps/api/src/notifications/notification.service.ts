import { Injectable } from '@nestjs/common';
import type { Tx } from '../database/transaction.js';
import type { NotificationEvent } from './events.js';

export interface NotificationRequest {
  readonly event: NotificationEvent;
  readonly userId: string;
  readonly bookingId?: string | null;
  /** Raw values; dates and money are formatted per recipient language when sending. */
  readonly variables: Readonly<Record<string, string | number | Date>>;
  /**
   * Identifies the logical message, e.g. `BOOKING_CONFIRMED:<bookingId>`. Enqueueing the
   * same key twice (a retried job, a duplicate webhook) never sends twice.
   */
  readonly dedupeKey: string;
}

/**
 * The single entry point for business events that notify someone. It only writes rows
 * (in the caller's transaction), so a notification exists if and only if the change that
 * caused it was committed. Delivery happens in NotificationDispatcher.
 */
@Injectable()
export class NotificationService {
  async enqueue(tx: Tx, request: NotificationRequest): Promise<number> {
    const user = await tx
      .selectFrom('app_user')
      .select('preferred_locale')
      .where('id', '=', request.userId)
      .executeTakeFirst();
    if (!user) return 0;

    // Channels switched on for the event (routing), each with an active template in the
    // user's language where available, else English.
    const templates = await tx
      .selectFrom('notification_template as t')
      .innerJoin('notification_route as r', (j) =>
        j.onRef('r.event_code', '=', 't.code').onRef('r.channel', '=', 't.channel'),
      )
      .select(['t.id', 't.channel', 't.locale'])
      .where('t.code', '=', request.event)
      .where('t.is_active', '=', true)
      .where('r.is_enabled', '=', true)
      .where('t.locale', 'in', [user.preferred_locale, 'en'])
      .execute();

    const byChannel = new Map<string, { id: string; locale: string }>();
    for (const template of templates) {
      const current = byChannel.get(template.channel);
      if (!current || template.locale === user.preferred_locale) {
        byChannel.set(template.channel, { id: template.id, locale: template.locale });
      }
    }
    if (byChannel.size === 0) return 0;

    const variables = Object.fromEntries(
      Object.entries(request.variables).map(([key, value]) => [
        key,
        value instanceof Date ? { $date: value.toISOString() } : value,
      ]),
    );

    const inserted = await tx
      .insertInto('notification')
      .values(
        [...byChannel.entries()].map(([channel, template]) => ({
          user_id: request.userId,
          booking_id: request.bookingId ?? null,
          template_id: template.id,
          channel,
          locale: template.locale,
          variables: JSON.stringify(variables),
          dedupe_key: `${request.dedupeKey}:${channel}`,
        })),
      )
      .onConflict((oc) => oc.column('dedupe_key').doNothing())
      .returning('id')
      .execute();
    return inserted.length;
  }
}
