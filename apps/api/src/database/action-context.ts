import type { ActionSource } from '@onetappe/domain';

/**
 * Who is acting and through which channel. Every write transaction carries one; the
 * database copies it into history and audit rows and rejects critical writes without it.
 */
export interface ActionContext {
  readonly actorUserId: string | null;
  /** Role the actor is acting in, e.g. CUSTOMER, WORKER, OPERATIONS_AGENT. */
  readonly actorRole: string | null;
  readonly source: ActionSource;
  /** Correlates all rows written by one API request. */
  readonly requestId: string;
  /**
   * Why the action is taken. Required for operations overrides; recorded on every audit
   * and history row written in the transaction.
   */
  readonly reason?: string | null;
  /**
   * The booking version the actor's screen showed. When set, the transaction fails with
   * STALE_BOOKING if that booking changed since, instead of overwriting someone else's
   * change (two staff acting on the same booking). Checked under the booking's row lock.
   */
  readonly expectedBookingVersion?: { readonly bookingId: string; readonly version: number };
}

export function systemContext(requestId: string): ActionContext {
  return { actorUserId: null, actorRole: 'SYSTEM', source: 'SYSTEM', requestId };
}
