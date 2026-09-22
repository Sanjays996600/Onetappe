import { describe, expect, it } from 'vitest';
import { ACTION_SOURCES } from '../common/action-source.js';
import {
  BOOKING_TRANSITIONS,
  allowedStatusPairs,
  availableBookingEvents,
  resolveBookingTransition,
} from './booking-state-machine.js';
import { BOOKING_STATUSES, TERMINAL_BOOKING_STATUSES } from './booking-status.js';

describe('booking state machine', () => {
  it('follows the happy path from payment to closure', () => {
    const path = [
      ['PENDING_PAYMENT', 'PAYMENT_CAPTURED', 'PAYMENT_GATEWAY', 'CONFIRMED'],
      ['CONFIRMED', 'WORKER_ACCEPTED', 'WORKER_APP', 'ASSIGNED'],
      ['ASSIGNED', 'START_TRAVEL', 'WORKER_APP', 'EN_ROUTE'],
      ['EN_ROUTE', 'MARK_ARRIVED', 'WORKER_APP', 'ARRIVED'],
      ['ARRIVED', 'START_SERVICE', 'WORKER_APP', 'IN_PROGRESS'],
      ['IN_PROGRESS', 'COMPLETE_SERVICE', 'WORKER_APP', 'COMPLETED'],
      ['COMPLETED', 'CLOSE', 'SYSTEM', 'CLOSED'],
    ] as const;
    for (const [from, event, source, to] of path) {
      const result = resolveBookingTransition({ from, event, source });
      expect(result).toMatchObject({ ok: true, transition: { to } });
    }
  });

  it('rejects an event that is not valid from the current status', () => {
    const result = resolveBookingTransition({
      from: 'PENDING_PAYMENT',
      event: 'START_SERVICE',
      source: 'WORKER_APP',
    });
    expect(result).toEqual({
      ok: false,
      rejection: {
        code: 'EVENT_NOT_ALLOWED_FROM_STATUS',
        from: 'PENDING_PAYMENT',
        event: 'START_SERVICE',
      },
    });
  });

  it('rejects a channel that may not trigger the event', () => {
    const result = resolveBookingTransition({
      from: 'PENDING_PAYMENT',
      event: 'PAYMENT_CAPTURED',
      source: 'CUSTOMER_APP',
    });
    expect(result).toMatchObject({ ok: false, rejection: { code: 'SOURCE_NOT_ALLOWED' } });
  });

  it('requires a reason for cancellations', () => {
    expect(
      resolveBookingTransition({
        from: 'CONFIRMED',
        event: 'CANCEL',
        source: 'CUSTOMER_APP',
        reason: '  ',
      }),
    ).toMatchObject({ ok: false, rejection: { code: 'REASON_REQUIRED' } });
    expect(
      resolveBookingTransition({
        from: 'CONFIRMED',
        event: 'CANCEL',
        source: 'CUSTOMER_APP',
        reason: 'Plans changed',
      }),
    ).toMatchObject({ ok: true });
  });

  it('customers cannot cancel once the service has started', () => {
    expect(availableBookingEvents('IN_PROGRESS', 'CUSTOMER_APP')).toEqual([]);
  });

  it('has no transitions out of terminal statuses', () => {
    for (const status of TERMINAL_BOOKING_STATUSES) {
      for (const source of ACTION_SOURCES) {
        expect(availableBookingEvents(status, source)).toEqual([]);
      }
    }
  });

  it('declares each (from, event) pair once and only uses known statuses', () => {
    const keys = BOOKING_TRANSITIONS.map((tr) => `${tr.from}:${tr.event}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const tr of BOOKING_TRANSITIONS) {
      expect(BOOKING_STATUSES).toContain(tr.from);
      expect(BOOKING_STATUSES).toContain(tr.to);
      expect(tr.sources.length).toBeGreaterThan(0);
    }
  });

  it('every non-terminal status can be left', () => {
    const froms = new Set(allowedStatusPairs().map(([from]) => from));
    for (const status of BOOKING_STATUSES) {
      if (!TERMINAL_BOOKING_STATUSES.includes(status)) expect(froms).toContain(status);
    }
  });
});
