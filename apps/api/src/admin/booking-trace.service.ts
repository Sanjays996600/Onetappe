import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { hasPermission, type Principal } from '../auth/principal.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { AdminBookingService } from './admin-booking.service.js';

export interface TraceEntry {
  readonly at: string;
  readonly area:
    | 'status'
    | 'schedule'
    | 'assignment'
    | 'payment'
    | 'gateway'
    | 'refund'
    | 'notification'
    | 'support'
    | 'integration'
    | 'audit';
  readonly what: string;
  readonly detail: Record<string, unknown>;
  /** The request (or job run) that caused it: the key to find the matching log lines. */
  readonly requestId: string | null;
}

/**
 * Everything that happened to one booking, in time order, from every part of the system:
 * status history, schedule changes, worker offers, payments and gateway events, refunds,
 * notifications, support cases, integration deliveries and audit entries. Each entry
 * carries the request or job id that produced it, so the matching log lines are one
 * search away. Personal data is not included; money details need `payment.read`.
 */
@Injectable()
export class BookingTraceService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly bookings: AdminBookingService,
  ) {}

  async trace(principal: Principal, bookingId: string) {
    await this.bookings.assertCity(principal, bookingId, 'booking.read');
    const money = hasPermission(principal, 'payment.read');

    const booking = await this.db
      .selectFrom('booking')
      .select([
        'id',
        'booking_code',
        'status',
        'source',
        'customer_user_id',
        'scheduled_start',
        'original_start',
        'created_at',
      ])
      .where('id', '=', bookingId)
      .executeTakeFirstOrThrow();

    const [history, schedule, assignments, payments, refunds, notifications, cases, audit] =
      await Promise.all([
        this.db
          .selectFrom('booking_status_history')
          .selectAll()
          .where('booking_id', '=', bookingId)
          .execute(),
        this.db
          .selectFrom('booking_schedule_change')
          .selectAll()
          .where('booking_id', '=', bookingId)
          .execute(),
        this.db
          .selectFrom('booking_assignment')
          .selectAll()
          .where('booking_id', '=', bookingId)
          .execute(),
        this.db.selectFrom('payment').selectAll().where('booking_id', '=', bookingId).execute(),
        this.db.selectFrom('refund').selectAll().where('booking_id', '=', bookingId).execute(),
        this.db
          .selectFrom('notification as n')
          .innerJoin('notification_template as t', 't.id', 'n.template_id')
          .select([
            'n.id',
            'n.channel',
            'n.status',
            'n.attempts',
            'n.created_at',
            'n.sent_at',
            'n.last_error',
            'n.user_id',
            't.code',
          ])
          .where('n.booking_id', '=', bookingId)
          .execute(),
        this.db
          .selectFrom('support_case as c')
          .leftJoin('external_link as l', (j) =>
            j
              .onRef('l.internal_id', '=', 'c.id')
              .on('l.target', '=', 'ZOHO_DESK')
              .on('l.entity_type', '=', 'support_case'),
          )
          .select([
            'c.id',
            'c.case_code',
            'c.category',
            'c.status',
            'c.opened_at',
            'c.raised_by_role',
            'l.external_ref as ticket_number',
          ])
          .where('c.booking_id', '=', bookingId)
          .execute(),
        this.db
          .selectFrom('audit_log')
          .select([
            'occurred_at',
            'action',
            'entity_type',
            'changed_fields',
            'actor_role',
            'source',
            'request_id',
            'reason',
          ])
          .where('entity_type', '=', 'booking')
          .where('entity_id', '=', bookingId)
          .execute(),
      ]);

    const paymentIds = payments.map((p) => p.id);
    const caseIds = cases.map((c) => c.id);
    const [gatewayEvents, integrationEvents] = await Promise.all([
      paymentIds.length
        ? this.db
            .selectFrom('payment_event')
            .select([
              'id',
              'event_type',
              'received_at',
              'processed_at',
              'processing_error',
              'signature_verified',
            ])
            .where('payment_id', 'in', paymentIds)
            .execute()
        : [],
      this.db
        .selectFrom('integration_event')
        .select([
          'id',
          'target',
          'event_type',
          'status',
          'attempts',
          'created_at',
          'processed_at',
          'last_error',
          'request_id',
        ])
        .where('aggregate_id', 'in', [bookingId, ...caseIds])
        .execute(),
    ]);

    const entries: TraceEntry[] = [
      ...history.map((h) => ({
        at: h.occurred_at.toISOString(),
        area: 'status' as const,
        what: `${h.from_status ?? 'NEW'} → ${h.to_status} (${h.event})`,
        detail: { source: h.source, actorRole: h.actor_role, reason: h.reason },
        requestId: h.request_id,
      })),
      ...schedule.map((s) => ({
        at: s.occurred_at.toISOString(),
        area: 'schedule' as const,
        what: `Moved ${s.previous_start.toISOString()} → ${s.new_start.toISOString()}`,
        detail: { source: s.source, actorRole: s.actor_role, reason: s.reason },
        requestId: s.request_id,
      })),
      ...assignments.map((a) => ({
        at: a.offered_at.toISOString(),
        area: 'assignment' as const,
        what: `Offered to worker (${a.status})`,
        detail: {
          workerId: a.worker_id,
          respondedAt: a.responded_at?.toISOString() ?? null,
          endedAt: a.ended_at?.toISOString() ?? null,
          endReason: a.end_reason,
          source: a.source,
        },
        requestId: null,
      })),
      ...payments.map((p) => ({
        at: p.created_at.toISOString(),
        area: 'payment' as const,
        what: `Payment ${p.status}${p.is_duplicate ? ' (duplicate)' : ''}`,
        detail: {
          paymentId: p.id,
          provider: p.provider,
          ...(money
            ? {
                amountPaise: p.amount_paise,
                providerOrderId: p.provider_order_id,
                providerPaymentId: p.provider_payment_id,
                capturedAt: p.captured_at?.toISOString() ?? null,
                failureReason: p.failure_reason,
              }
            : {}),
        },
        requestId: null,
      })),
      ...gatewayEvents.map((e) => ({
        at: e.received_at.toISOString(),
        area: 'gateway' as const,
        what: `Gateway event ${e.event_type}`,
        detail: {
          signatureVerified: e.signature_verified,
          processed: e.processed_at !== null,
          problem: e.processing_error,
        },
        requestId: null,
      })),
      ...refunds.map((r) => ({
        at: r.created_at.toISOString(),
        area: 'refund' as const,
        what: `Refund ${r.status} (${r.reason_code})`,
        detail: money
          ? { amountPaise: r.amount_paise, policy: r.decision_policy, failure: r.failure_reason }
          : { policy: r.decision_policy },
        requestId: null,
      })),
      ...notifications.map((n) => ({
        at: n.created_at.toISOString(),
        area: 'notification' as const,
        what: `${n.code} via ${n.channel}: ${n.status}`,
        detail: {
          to: n.user_id === booking.customer_user_id ? 'customer' : 'worker',
          attempts: n.attempts,
          sentAt: n.sent_at?.toISOString() ?? null,
          lastError: n.last_error,
        },
        requestId: null,
      })),
      ...cases.map((c) => ({
        at: c.opened_at.toISOString(),
        area: 'support' as const,
        what: `Support case ${c.case_code} (${c.category}) ${c.status}`,
        detail: { raisedBy: c.raised_by_role, zohoDeskTicket: c.ticket_number },
        requestId: null,
      })),
      ...integrationEvents.map((e) => ({
        at: e.created_at.toISOString(),
        area: 'integration' as const,
        what: `${e.target} ${e.event_type}: ${e.status}`,
        detail: {
          attempts: e.attempts,
          processedAt: e.processed_at?.toISOString() ?? null,
          lastError: e.last_error,
        },
        requestId: e.request_id,
      })),
      ...audit.map((a) => ({
        at: a.occurred_at.toISOString(),
        area: 'audit' as const,
        what: `${a.action} ${a.entity_type}${a.changed_fields ? ` [${a.changed_fields.join(', ')}]` : ''}`,
        detail: { actorRole: a.actor_role, source: a.source, reason: a.reason },
        requestId: a.request_id,
      })),
    ];
    entries.sort((a, b) => a.at.localeCompare(b.at));

    return {
      booking: {
        id: booking.id,
        bookingCode: booking.booking_code,
        status: booking.status,
        source: booking.source,
        customerId: booking.customer_user_id,
        scheduledStart: booking.scheduled_start.toISOString(),
        originalScheduledStart: booking.original_start.toISOString(),
        createdAt: booking.created_at.toISOString(),
      },
      entries,
    };
  }
}
