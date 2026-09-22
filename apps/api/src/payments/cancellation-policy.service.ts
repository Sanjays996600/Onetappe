import { Injectable } from '@nestjs/common';
import type { Tx } from '../database/transaction.js';

export interface CancellationRefund {
  readonly refundBp: number;
  /** Rule applied, or null when no rule matched (full refund by default). */
  readonly ruleId: string | null;
  readonly description: string;
}

/**
 * Customer-cancellation refunds come from configured rules (cancellation_rule), never from
 * code. The applicable rule is the one with the largest "minutes before start" threshold
 * that has been reached; service-specific rules win over general ones. With no rule, the
 * customer gets a full refund.
 */
@Injectable()
export class CancellationPolicyService {
  async forCustomerCancellation(
    tx: Tx,
    serviceId: string,
    scheduledStart: Date,
    now: Date,
  ): Promise<CancellationRefund> {
    const minutesBefore = Math.floor((scheduledStart.getTime() - now.getTime()) / 60_000);
    const rule = await tx
      .selectFrom('cancellation_rule')
      .select(['id', 'refund_bp', 'description', 'service_id'])
      .where('is_active', '=', true)
      .where('valid_from', '<=', now)
      .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>', now)]))
      .where((eb) => eb.or([eb('service_id', 'is', null), eb('service_id', '=', serviceId)]))
      .where('min_minutes_before_start', '<=', Math.max(minutesBefore, 0))
      .orderBy((eb) => eb.case().when('service_id', 'is', null).then(1).else(0).end())
      .orderBy('min_minutes_before_start', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!rule)
      return {
        refundBp: 10_000,
        ruleId: null,
        description: 'No cancellation rule configured: full refund',
      };
    return { refundBp: rule.refund_bp, ruleId: rule.id, description: rule.description };
  }
}
