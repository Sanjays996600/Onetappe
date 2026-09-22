/**
 * Booking lifecycle.
 *
 * One booking is one service visit. The status only moves through the transitions
 * declared in `BOOKING_TRANSITIONS`; the same table is loaded into PostgreSQL so the
 * database rejects any other change (see migration `0007_bookings`).
 */
export const BOOKING_STATUSES = [
  /** Created with a capacity hold; waiting for payment before the hold expires. */
  'PENDING_PAYMENT',
  /** Paid (or approved to pay later); capacity is held and a worker is being assigned. */
  'CONFIRMED',
  /** Paused by operations; capacity released until resumed. */
  'ON_HOLD',
  /** A worker has accepted the job. */
  'ASSIGNED',
  /** Worker has left for the customer's address. */
  'EN_ROUTE',
  /** Worker is at the address; waiting for start verification. */
  'ARRIVED',
  /** Start verified; the service is being delivered. */
  'IN_PROGRESS',
  /** Service delivered; waiting for settlement and follow-up. */
  'COMPLETED',
  /** Money settled and follow-up done. Terminal. */
  'CLOSED',
  /** Cancelled by the customer, operations or the system. Terminal. */
  'CANCELLED',
  /** Payment never arrived before the hold expired. Terminal. */
  'EXPIRED',
  /** Customer could not be reached / gave no access at the address. */
  'NO_SHOW',
] as const;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const TERMINAL_BOOKING_STATUSES: readonly BookingStatus[] = [
  'CLOSED',
  'CANCELLED',
  'EXPIRED',
];

/** Statuses in which the booking still holds (or should hold) worker capacity. */
export const CAPACITY_HOLDING_STATUSES: readonly BookingStatus[] = [
  'PENDING_PAYMENT',
  'CONFIRMED',
  'ASSIGNED',
  'EN_ROUTE',
  'ARRIVED',
  'IN_PROGRESS',
];

/** Statuses in which the promised time may still be changed. */
export const RESCHEDULABLE_BOOKING_STATUSES: readonly BookingStatus[] = [
  'PENDING_PAYMENT',
  'CONFIRMED',
  'ON_HOLD',
  'ASSIGNED',
];

export function isTerminalBookingStatus(status: BookingStatus): boolean {
  return TERMINAL_BOOKING_STATUSES.includes(status);
}
