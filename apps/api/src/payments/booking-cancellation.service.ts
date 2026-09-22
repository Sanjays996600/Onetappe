import { Inject, Injectable } from '@nestjs/common';
import { applyBasisPoints } from '@onetappe/domain';
import type { Kysely } from 'kysely';
import { BookingLifecycleService } from '../booking/booking-lifecycle.service.js';
import { Clock } from '../common/clock.js';
import type { ActionContext } from '../database/action-context.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { inTransaction } from '../database/transaction.js';
import { CancellationPolicyService } from './cancellation-policy.service.js';
import { RefundService, type RefundReason } from './refund.service.js';

/** Who caused the cancellation decides the refund. */
export type CancellationFault = 'CUSTOMER' | 'COMPANY' | 'NO_WORKER' | 'WORKER_NO_SHOW';

export interface CancellationResult {
  readonly refundId: string | null;
  readonly refundAmountPaise: number;
}

const COMPANY_FAULT_REASON: Record<Exclude<CancellationFault, 'CUSTOMER'>, RefundReason> = {
  COMPANY: 'COMPANY_CANCELLED',
  NO_WORKER: 'NO_WORKER_AVAILABLE',
  WORKER_NO_SHOW: 'WORKER_NO_SHOW',
};

/**
 * Cancels a booking and creates the matching refund in one transaction:
 * customer cancellations follow the configured policy; cancellations caused by One Tappe
 * (no worker, worker no-show, operations decision) are refunded in full automatically.
 */
@Injectable()
export class BookingCancellationService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly lifecycle: BookingLifecycleService,
    private readonly refunds: RefundService,
    private readonly policy: CancellationPolicyService,
    private readonly clock: Clock,
  ) {}

  async cancel(
    bookingId: string,
    reason: string,
    fault: CancellationFault,
    context: ActionContext,
  ): Promise<CancellationResult> {
    const result = await inTransaction(this.db, context, async (tx) => {
      const booking = await this.lifecycle.cancelInTx(tx, bookingId, reason, context);

      let refundId: string | null;
      if (fault === 'CUSTOMER') {
        const policy = await this.policy.forCustomerCancellation(
          tx,
          booking.serviceId,
          booking.scheduledStart,
          this.clock.now(),
        );
        const paid = await tx
          .selectFrom('payment')
          .select(['amount_paise', 'captured_amount_paise'])
          .where('booking_id', '=', bookingId)
          .where('status', '=', 'CAPTURED')
          .where('is_duplicate', '=', false)
          .executeTakeFirst();
        const amount = paid
          ? applyBasisPoints(paid.captured_amount_paise ?? paid.amount_paise, policy.refundBp)
          : 0;
        refundId =
          amount > 0
            ? await this.refunds.requestInTx(tx, context, {
                bookingId,
                amountPaise: amount,
                reasonCode: 'CUSTOMER_CANCELLED',
                reasonText: `${reason} (${policy.description})`,
                autoApprovePolicy: policy.ruleId
                  ? `CANCELLATION_RULE:${policy.ruleId}`
                  : 'CANCELLATION_DEFAULT_FULL_REFUND',
              })
            : null;
      } else {
        refundId = await this.refunds.requestInTx(tx, context, {
          bookingId,
          amountPaise: null,
          reasonCode: COMPANY_FAULT_REASON[fault],
          reasonText: reason,
          autoApprovePolicy: 'COMPANY_FAULT_FULL_REFUND',
        });
      }

      const amount = refundId
        ? (
            await tx
              .selectFrom('refund')
              .select('amount_paise')
              .where('id', '=', refundId)
              .executeTakeFirstOrThrow()
          ).amount_paise
        : 0;
      return { refundId, refundAmountPaise: amount };
    });

    // Send to the gateway right away; the background job retries if this fails.
    if (result.refundId) await this.refunds.initiate(result.refundId, context.requestId);
    return result;
  }
}
