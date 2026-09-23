import {
  RESCHEDULABLE_BOOKING_STATUSES,
  availableBookingEvents,
  type BookingStatus,
} from '@onetappe/domain';
import type { StaffMe } from '@onetappe/api-client';
import { can } from './permissions';

export type BookingAction =
  | 'hold'
  | 'releaseHold'
  | 'reschedule'
  | 'cancel'
  | 'redispatch'
  | 'workerNoShow'
  | 'customerNoShow';

/**
 * The actions to offer on a booking: allowed by the booking state machine for operations
 * (the same rules the API and the database enforce) and by the staff member's permissions
 * in the booking's city. The API re-checks everything; this only avoids dead buttons.
 */
export function availableActions(
  me: StaffMe,
  booking: { status: BookingStatus; cityId: string },
): BookingAction[] {
  const events = new Set(availableBookingEvents(booking.status, 'ADMIN'));
  const has = (...permissions: string[]) => permissions.every((p) => can(me, p, booking.cityId));
  const out: BookingAction[] = [];
  if (events.has('PLACE_ON_HOLD') && has('booking.reschedule')) out.push('hold');
  if (events.has('RELEASE_HOLD') && has('booking.reschedule', 'booking.assign'))
    out.push('releaseHold');
  if (RESCHEDULABLE_BOOKING_STATUSES.includes(booking.status) && has('booking.reschedule'))
    out.push('reschedule');
  if (booking.status === 'CONFIRMED' && has('booking.assign')) out.push('redispatch');
  if (events.has('WORKER_UNASSIGNED') && has('booking.mark_no_show', 'booking.assign'))
    out.push('workerNoShow');
  if (events.has('CUSTOMER_NO_SHOW') && has('booking.mark_no_show')) out.push('customerNoShow');
  if (events.has('CANCEL') && has('booking.cancel')) out.push('cancel');
  return out;
}
