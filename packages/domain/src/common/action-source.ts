/**
 * Where an action came from. Stored on every history and audit row so we can answer
 * "who did this, and through which channel?".
 */
export const ACTION_SOURCES = [
  'CUSTOMER_APP',
  'WORKER_APP',
  'ADMIN',
  'SYSTEM',
  'PAYMENT_GATEWAY',
] as const;

export type ActionSource = (typeof ACTION_SOURCES)[number];

/** Channels through which a booking can be created. */
export const BOOKING_SOURCES = ['CUSTOMER_APP', 'ADMIN'] as const satisfies readonly ActionSource[];

export type BookingSource = (typeof BOOKING_SOURCES)[number];

export function isActionSource(value: string): value is ActionSource {
  return (ACTION_SOURCES as readonly string[]).includes(value);
}
