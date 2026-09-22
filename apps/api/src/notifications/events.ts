/** Business events that notify people. Wording lives in notification_template rows. */
export const NOTIFICATION_EVENTS = [
  'BOOKING_CONFIRMED',
  'PAYMENT_SUCCESSFUL',
  'WORKER_ASSIGNED',
  'WORKER_EN_ROUTE',
  'WORKER_ARRIVED',
  'SERVICE_STARTED',
  'SERVICE_COMPLETED',
  'BOOKING_RESCHEDULED',
  'BOOKING_CANCELLED',
  'NO_WORKER_AVAILABLE',
  'REFUND_INITIATED',
  'REFUND_COMPLETED',
  'JOB_OFFER',
  'JOB_CANCELLED',
] as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export const NOTIFICATION_CHANNELS = ['PUSH', 'SMS', 'WHATSAPP', 'EMAIL', 'IN_APP'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
