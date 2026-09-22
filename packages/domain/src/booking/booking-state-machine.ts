import type { ActionSource } from '../common/action-source.js';
import type { BookingStatus } from './booking-status.js';

export const BOOKING_EVENTS = [
  'PAYMENT_CAPTURED',
  'CONFIRM_WITHOUT_PREPAYMENT',
  'HOLD_EXPIRED',
  'PLACE_ON_HOLD',
  'RELEASE_HOLD',
  'WORKER_ACCEPTED',
  'WORKER_UNASSIGNED',
  'START_TRAVEL',
  'MARK_ARRIVED',
  'START_SERVICE',
  'CUSTOMER_NO_SHOW',
  'COMPLETE_SERVICE',
  'CLOSE',
  'CANCEL',
] as const;

export type BookingEvent = (typeof BOOKING_EVENTS)[number];

export interface BookingTransition {
  readonly from: BookingStatus;
  readonly event: BookingEvent;
  readonly to: BookingStatus;
  /** Channels allowed to trigger this transition. */
  readonly sources: readonly ActionSource[];
  /** A free-text reason must be recorded (cancellations, holds, overrides). */
  readonly requiresReason: boolean;
}

function t(
  from: BookingStatus,
  event: BookingEvent,
  to: BookingStatus,
  sources: readonly ActionSource[],
  requiresReason = false,
): BookingTransition {
  return { from, event, to, sources, requiresReason };
}

/**
 * The single source of truth for allowed booking transitions.
 * Migration `0007_bookings` seeds `booking_status_transition` from the same pairs and a
 * test asserts both stay identical.
 */
export const BOOKING_TRANSITIONS: readonly BookingTransition[] = [
  // Payment
  t('PENDING_PAYMENT', 'PAYMENT_CAPTURED', 'CONFIRMED', ['PAYMENT_GATEWAY', 'SYSTEM']),
  t('PENDING_PAYMENT', 'CONFIRM_WITHOUT_PREPAYMENT', 'CONFIRMED', ['ADMIN'], true),
  t('PENDING_PAYMENT', 'HOLD_EXPIRED', 'EXPIRED', ['SYSTEM']),
  t('PENDING_PAYMENT', 'CANCEL', 'CANCELLED', ['CUSTOMER_APP', 'ADMIN', 'SYSTEM'], true),

  // Operations hold
  t('CONFIRMED', 'PLACE_ON_HOLD', 'ON_HOLD', ['ADMIN'], true),
  t('ON_HOLD', 'RELEASE_HOLD', 'CONFIRMED', ['ADMIN'], true),
  t('ON_HOLD', 'CANCEL', 'CANCELLED', ['ADMIN', 'CUSTOMER_APP'], true),

  // Assignment
  t('CONFIRMED', 'WORKER_ACCEPTED', 'ASSIGNED', ['WORKER_APP', 'ADMIN']),
  t('CONFIRMED', 'CANCEL', 'CANCELLED', ['CUSTOMER_APP', 'ADMIN', 'SYSTEM'], true),
  t('ASSIGNED', 'WORKER_UNASSIGNED', 'CONFIRMED', ['WORKER_APP', 'ADMIN', 'SYSTEM'], true),
  t('ASSIGNED', 'CANCEL', 'CANCELLED', ['CUSTOMER_APP', 'ADMIN'], true),

  // Travel and arrival
  t('ASSIGNED', 'START_TRAVEL', 'EN_ROUTE', ['WORKER_APP', 'ADMIN']),
  t('EN_ROUTE', 'WORKER_UNASSIGNED', 'CONFIRMED', ['ADMIN', 'SYSTEM'], true),
  t('EN_ROUTE', 'MARK_ARRIVED', 'ARRIVED', ['WORKER_APP', 'ADMIN']),
  t('EN_ROUTE', 'CANCEL', 'CANCELLED', ['CUSTOMER_APP', 'ADMIN'], true),

  // Service
  t('ARRIVED', 'START_SERVICE', 'IN_PROGRESS', ['WORKER_APP', 'ADMIN']),
  t('ARRIVED', 'CUSTOMER_NO_SHOW', 'NO_SHOW', ['WORKER_APP', 'ADMIN'], true),
  t('ARRIVED', 'CANCEL', 'CANCELLED', ['ADMIN'], true),
  t('IN_PROGRESS', 'COMPLETE_SERVICE', 'COMPLETED', ['WORKER_APP', 'ADMIN']),
  // Stop-work for safety or other serious reasons is an operations decision.
  t('IN_PROGRESS', 'CANCEL', 'CANCELLED', ['ADMIN'], true),

  // Settlement
  t('COMPLETED', 'CLOSE', 'CLOSED', ['SYSTEM', 'ADMIN']),
  t('NO_SHOW', 'CLOSE', 'CLOSED', ['SYSTEM', 'ADMIN']),
];

export type TransitionRejection =
  | {
      readonly code: 'EVENT_NOT_ALLOWED_FROM_STATUS';
      readonly from: BookingStatus;
      readonly event: BookingEvent;
    }
  | {
      readonly code: 'SOURCE_NOT_ALLOWED';
      readonly source: ActionSource;
      readonly event: BookingEvent;
    }
  | { readonly code: 'REASON_REQUIRED'; readonly event: BookingEvent };

export type TransitionResult =
  | { readonly ok: true; readonly transition: BookingTransition }
  | { readonly ok: false; readonly rejection: TransitionRejection };

export interface TransitionRequest {
  readonly from: BookingStatus;
  readonly event: BookingEvent;
  readonly source: ActionSource;
  readonly reason?: string | null;
}

/** Pure check of whether `event` may move a booking out of `from` for `source`. */
export function resolveBookingTransition(request: TransitionRequest): TransitionResult {
  const transition = BOOKING_TRANSITIONS.find(
    (candidate) => candidate.from === request.from && candidate.event === request.event,
  );
  if (!transition) {
    return {
      ok: false,
      rejection: {
        code: 'EVENT_NOT_ALLOWED_FROM_STATUS',
        from: request.from,
        event: request.event,
      },
    };
  }
  if (!transition.sources.includes(request.source)) {
    return {
      ok: false,
      rejection: { code: 'SOURCE_NOT_ALLOWED', source: request.source, event: request.event },
    };
  }
  if (transition.requiresReason && !request.reason?.trim()) {
    return { ok: false, rejection: { code: 'REASON_REQUIRED', event: request.event } };
  }
  return { ok: true, transition };
}

/** Events that may be triggered from `from` by `source` (used to render action buttons). */
export function availableBookingEvents(
  from: BookingStatus,
  source: ActionSource,
): readonly BookingEvent[] {
  return BOOKING_TRANSITIONS.filter((tr) => tr.from === from && tr.sources.includes(source)).map(
    (tr) => tr.event,
  );
}

/** Distinct (from, to) pairs; mirrored in the database transition table. */
export function allowedStatusPairs(): ReadonlyArray<readonly [BookingStatus, BookingStatus]> {
  const seen = new Set<string>();
  const pairs: Array<readonly [BookingStatus, BookingStatus]> = [];
  for (const tr of BOOKING_TRANSITIONS) {
    const key = `${tr.from}->${tr.to}`;
    if (!seen.has(key)) {
      seen.add(key);
      pairs.push([tr.from, tr.to] as const);
    }
  }
  return pairs;
}
