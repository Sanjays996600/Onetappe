'use server';

import { redirect } from 'next/navigation';
import { ApiError, type ApiClient } from '@onetappe/api-client';
import type { BookingAction } from '@/lib/booking-actions';
import { istLocalToIso } from '@/lib/format';
import { call } from '@/server/api';
import { text } from '@/lib/form';

const ACTIONS: readonly BookingAction[] = [
  'hold',
  'releaseHold',
  'reschedule',
  'cancel',
  'redispatch',
  'workerNoShow',
  'customerNoShow',
];

function perform(api: ApiClient, action: BookingAction, id: string, form: FormData) {
  const change = {
    reason: text(form, 'reason').trim(),
    expectedVersion: Number(form.get('expectedVersion')),
  };
  const b = api.admin.bookings;
  switch (action) {
    case 'reschedule':
      return b.reschedule(id, { ...change, startAt: istLocalToIso(text(form, 'startAt')) });
    case 'cancel': {
      const fault = text(form, 'fault');
      return b.cancel(id, {
        ...change,
        fault: fault === 'CUSTOMER' || fault === 'NO_WORKER' ? fault : 'COMPANY',
      });
    }
    default:
      return b[action](id, change);
  }
}

/**
 * One staff action on a booking. It carries the version the staff member saw, so a change
 * made meanwhile by someone else is reported (STALE_BOOKING) instead of overwritten.
 */
export async function bookingAction(form: FormData) {
  const id = text(form, 'bookingId');
  const action = text(form, 'action') as BookingAction;
  const back = `/bookings/${encodeURIComponent(id)}`;
  if (!/^[0-9a-f-]{36}$/i.test(id) || !ACTIONS.includes(action)) redirect('/bookings');
  let outcome = `${back}?notice=saved`;
  try {
    await call((api) => perform(api, action, id, form), back);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    outcome =
      error.code === 'STALE_BOOKING'
        ? `${back}?notice=stale`
        : `${back}?error=${encodeURIComponent(error.code)}&message=${encodeURIComponent(error.message)}&rid=${encodeURIComponent(error.requestId ?? '')}`;
  }
  redirect(outcome);
}
