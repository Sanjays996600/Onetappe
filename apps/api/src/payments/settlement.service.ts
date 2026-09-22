import { Inject, Injectable, Logger } from '@nestjs/common';
import { selectRule, type IsoWeekday } from '@onetappe/domain';
import { sql, type Kysely } from 'kysely';
import { BookingTransitionService } from '../booking/booking-transition.service.js';
import type { ActionContext } from '../database/action-context.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { inTransaction, type Tx } from '../database/transaction.js';

export const INVOICE_ISSUER_SETTING = 'invoice.issuer';

/** Configured by operations in business_setting['invoice.issuer']. */
export interface InvoiceIssuer {
  readonly legalName: string;
  readonly gstin: string | null;
  readonly address: string;
  /** Invoice number prefix, e.g. "OT-NOI". */
  readonly series: string;
}

export type SettlementOutcome =
  | { readonly bookingId: string; readonly settled: true; readonly invoiceNumber: string }
  | { readonly bookingId: string; readonly settled: false; readonly blockedBy: string };

/**
 * Settles finished bookings: once the customer's payment is captured, it issues the
 * invoice, creates the worker's earnings from the configured payout rule and closes the
 * booking — all in one transaction. Anything missing (payment, invoice issuer, payout
 * rule) leaves the booking COMPLETED and reports why, rather than guessing.
 */
@Injectable()
export class SettlementService {
  private readonly logger = new Logger('Settlement');

  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly transitions: BookingTransitionService,
  ) {}

  async settleDue(requestId: string, limit = 50): Promise<SettlementOutcome[]> {
    const due = await this.db
      .selectFrom('booking')
      .select('id')
      .where('status', 'in', ['COMPLETED', 'NO_SHOW'])
      .orderBy('completed_at')
      .limit(limit)
      .execute();
    const outcomes: SettlementOutcome[] = [];
    for (const { id } of due) {
      const outcome = await this.settle(id, requestId);
      if (!outcome.settled) this.logger.warn(`Booking ${id} not settled: ${outcome.blockedBy}`);
      outcomes.push(outcome);
    }
    return outcomes;
  }

  async settle(bookingId: string, requestId: string): Promise<SettlementOutcome> {
    const context: ActionContext = {
      actorUserId: null,
      actorRole: 'SYSTEM',
      source: 'SYSTEM',
      requestId,
    };
    return inTransaction(this.db, context, async (tx): Promise<SettlementOutcome> => {
      const locked = await this.transitions.lock(tx, bookingId);
      if (locked.status !== 'COMPLETED' && locked.status !== 'NO_SHOW') {
        return { bookingId, settled: false, blockedBy: `STATUS_${locked.status}` };
      }
      const booking = await tx
        .selectFrom('booking as b')
        .innerJoin('app_user as u', 'u.id', 'b.customer_user_id')
        .innerJoin('city as c', 'c.id', 'b.city_id')
        .selectAll('b')
        .select(['u.full_name', 'c.time_zone'])
        .where('b.id', '=', bookingId)
        .executeTakeFirstOrThrow();

      const paid = await tx
        .selectFrom('payment')
        .select((eb) =>
          eb.fn
            .coalesce(
              eb.fn.sum<number>(eb.fn.coalesce('captured_amount_paise', 'amount_paise')),
              sql<number>`0`,
            )
            .as('total'),
        )
        .where('booking_id', '=', bookingId)
        .where('status', '=', 'CAPTURED')
        .where('is_duplicate', '=', false)
        .executeTakeFirstOrThrow();
      if (paid.total < booking.total_paise) {
        return { bookingId, settled: false, blockedBy: 'AWAITING_PAYMENT' };
      }

      let invoiceNumber = '';
      if (locked.status === 'COMPLETED') {
        const issuer = await this.issuer(tx);
        if (!issuer)
          return { bookingId, settled: false, blockedBy: 'INVOICE_ISSUER_NOT_CONFIGURED' };
        const earningsCreated = await this.createEarnings(tx, booking);
        if (!earningsCreated)
          return { bookingId, settled: false, blockedBy: 'PAYOUT_RULE_NOT_CONFIGURED' };
        invoiceNumber = await this.issueInvoice(tx, booking, issuer);
      }

      await this.transitions.apply(tx, locked, 'CLOSE', context);
      return { bookingId, settled: true, invoiceNumber };
    });
  }

  private async issuer(tx: Tx): Promise<InvoiceIssuer | null> {
    const row = await tx
      .selectFrom('business_setting')
      .select('value')
      .where('key', '=', INVOICE_ISSUER_SETTING)
      .executeTakeFirst();
    const value = row?.value as Partial<InvoiceIssuer> | undefined;
    if (!value?.legalName || !value.address || !value.series) return null;
    return {
      legalName: value.legalName,
      gstin: value.gstin ?? null,
      address: value.address,
      series: value.series,
    };
  }

  private async issueInvoice(
    tx: Tx,
    booking: {
      id: string;
      subtotal_paise: number;
      discount_paise: number;
      tax_paise: number;
      total_paise: number;
      address_snapshot: unknown;
      full_name: string | null;
    },
    issuer: InvoiceIssuer,
  ): Promise<string> {
    const existing = await tx
      .selectFrom('invoice')
      .select('invoice_number')
      .where('booking_id', '=', booking.id)
      .executeTakeFirst();
    if (existing) return existing.invoice_number;

    // Gapless numbering: the counter row is updated inside this transaction.
    const next = await tx
      .insertInto('invoice_sequence')
      .values({ series: issuer.series, next_value: 2 })
      .onConflict((oc) =>
        oc
          .column('series')
          .doUpdateSet({ next_value: sql<number>`invoice_sequence.next_value + 1` }),
      )
      .returning(sql<number>`next_value - 1`.as('value'))
      .executeTakeFirstOrThrow();
    const invoiceNumber = `${issuer.series}-${String(next.value).padStart(6, '0')}`;

    const lines = await tx
      .selectFrom('booking_price_line')
      .select(['line_type', 'code', 'label', 'amount_paise'])
      .where('booking_id', '=', booking.id)
      .orderBy('line_no')
      .execute();
    const address = booking.address_snapshot as Record<string, string | null>;
    await tx
      .insertInto('invoice')
      .values({
        invoice_number: invoiceNumber,
        booking_id: booking.id,
        issuer_legal_name: issuer.legalName,
        issuer_gstin: issuer.gstin,
        issuer_address: issuer.address,
        customer_name: booking.full_name ?? address['contactName'] ?? 'Customer',
        customer_address: [
          address['houseNumber'],
          address['building'],
          address['street'],
          address['landmark'],
          address['cityName'],
          address['pincode'],
        ]
          .filter(Boolean)
          .join(', '),
        subtotal_paise: booking.subtotal_paise,
        discount_paise: booking.discount_paise,
        tax_paise: booking.tax_paise,
        total_paise: booking.total_paise,
        lines: JSON.stringify(lines),
      })
      .execute();
    return invoiceNumber;
  }

  /** Creates JOB (and TRAVEL) earnings for each worker who completed the job. */
  private async createEarnings(
    tx: Tx,
    booking: {
      id: string;
      service_id: string;
      service_option_id: string | null;
      city_id: string;
      zone_id: string;
      scheduled_start: Date;
      time_zone: string;
    },
  ): Promise<boolean> {
    const workers = await tx
      .selectFrom('booking_assignment')
      .select('worker_id')
      .where('booking_id', '=', booking.id)
      .where('status', '=', 'COMPLETED')
      .execute();
    if (workers.length === 0) return true;

    const rules = await tx
      .selectFrom('payout_rule')
      .selectAll()
      .where('service_id', '=', booking.service_id)
      .where('is_active', '=', true)
      .execute();
    const rule = selectRule(
      rules.map((r) => ({
        id: r.id,
        serviceId: r.service_id,
        serviceOptionId: r.service_option_id,
        cityId: r.city_id,
        zoneId: r.zone_id,
        weekdays: r.weekdays as IsoWeekday[] | null,
        startMinute: r.start_minute,
        endMinute: r.end_minute,
        validFrom: r.valid_from,
        validTo: r.valid_to,
        priority: r.priority,
        isActive: r.is_active,
        row: r,
      })),
      {
        serviceId: booking.service_id,
        serviceOptionId: booking.service_option_id,
        cityId: booking.city_id,
        zoneId: booking.zone_id,
        serviceStart: booking.scheduled_start,
        pricedAt: booking.scheduled_start,
        timeZone: booking.time_zone,
      },
    );
    if (!rule) return false;

    for (const { worker_id } of workers) {
      const existing = await tx
        .selectFrom('worker_earning')
        .select('earning_type')
        .where('booking_id', '=', booking.id)
        .where('worker_id', '=', worker_id)
        .where('status', '<>', 'VOID')
        .execute();
      const have = new Set(existing.map((e) => e.earning_type));
      const lines: Array<{ type: 'JOB' | 'TRAVEL'; amount: number; description: string }> = [
        { type: 'JOB', amount: rule.row.base_payout_paise, description: 'Job payout' },
        {
          type: 'TRAVEL',
          amount: rule.row.travel_allowance_paise,
          description: 'Travel allowance',
        },
      ];
      for (const line of lines) {
        if (line.amount <= 0 || have.has(line.type)) continue;
        await tx
          .insertInto('worker_earning')
          .values({
            worker_id,
            booking_id: booking.id,
            earning_type: line.type,
            amount_paise: line.amount,
            payout_rule_id: rule.id,
            description: line.description,
          })
          .execute();
      }
    }
    return true;
  }
}
