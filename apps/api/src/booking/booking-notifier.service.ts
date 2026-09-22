import { Injectable } from '@nestjs/common';
import type { Tx } from '../database/transaction.js';
import type { NotificationEvent } from '../notifications/events.js';
import { NotificationService } from '../notifications/notification.service.js';

/**
 * Turns booking events into notifications for the customer or worker. Each message has a
 * deterministic dedupe key so a retried job or duplicate webhook never notifies twice.
 */
@Injectable()
export class BookingNotifier {
  constructor(private readonly notifications: NotificationService) {}

  async toCustomer(
    tx: Tx,
    bookingId: string,
    event: NotificationEvent,
    options: { dedupeSuffix?: string; extra?: Record<string, string | number | Date> } = {},
  ): Promise<void> {
    const booking = await this.details(tx, bookingId);
    await this.notifications.enqueue(tx, {
      event,
      userId: booking.customer_user_id,
      bookingId,
      variables: { ...this.variables(booking), ...options.extra },
      dedupeKey: `${event}:${bookingId}${options.dedupeSuffix ? `:${options.dedupeSuffix}` : ''}`,
    });
  }

  async toWorker(
    tx: Tx,
    bookingId: string,
    workerId: string,
    event: NotificationEvent,
    options: { dedupeSuffix?: string; extra?: Record<string, string | number | Date> } = {},
  ): Promise<void> {
    const booking = await this.details(tx, bookingId);
    await this.notifications.enqueue(tx, {
      event,
      userId: workerId,
      bookingId,
      variables: { ...this.variables(booking), ...options.extra },
      dedupeKey: `${event}:${bookingId}:${workerId}${options.dedupeSuffix ? `:${options.dedupeSuffix}` : ''}`,
    });
  }

  /** Workers with a live offer or accepted job on the booking. */
  async activeWorkers(tx: Tx, bookingId: string): Promise<string[]> {
    const rows = await tx
      .selectFrom('booking_assignment')
      .select('worker_id')
      .where('booking_id', '=', bookingId)
      .where('status', 'in', ['OFFERED', 'ACCEPTED'])
      .execute();
    return [...new Set(rows.map((r) => r.worker_id))];
  }

  private details(tx: Tx, bookingId: string) {
    return tx
      .selectFrom('booking as b')
      .innerJoin('service as s', 's.id', 'b.service_id')
      .innerJoin('locality as l', 'l.id', 'b.locality_id')
      .leftJoin('booking_assignment as a', (join) =>
        join.onRef('a.booking_id', '=', 'b.id').on('a.status', '=', 'ACCEPTED'),
      )
      .leftJoin('app_user as w', 'w.id', 'a.worker_id')
      .select([
        'b.customer_user_id',
        'b.booking_code',
        'b.scheduled_start',
        'b.total_paise',
        's.name as service_name',
        'l.name as locality',
        'w.full_name as worker_name',
      ])
      .where('b.id', '=', bookingId)
      .executeTakeFirstOrThrow();
  }

  private variables(booking: Awaited<ReturnType<BookingNotifier['details']>>) {
    return {
      bookingCode: booking.booking_code,
      serviceName: booking.service_name,
      startTime: booking.scheduled_start,
      locality: booking.locality,
      // Workers are introduced by first name only.
      workerName: booking.worker_name?.split(/\s+/)[0] ?? '',
      amount: booking.total_paise,
    };
  }
}
