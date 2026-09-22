import { BusinessRuleError, ValidationError } from '../common/errors.js';

/** Scheduled bookings start on quarter-hour boundaries. */
export const SLOT_GRANULARITY_MINUTES = 15;
/** Instant bookings are rounded up to the next five minutes. */
const INSTANT_ROUNDING_MINUTES = 5;
const MINUTE_MS = 60_000;

export interface SchedulingRules {
  readonly supports_instant: boolean;
  readonly supports_scheduled: boolean;
  readonly buffer_before_minutes: number;
  readonly min_lead_time_minutes: number;
  readonly max_advance_days: number;
}

/** Earliest arrival for an instant booking: now + travel time, rounded up. */
export function instantStart(service: SchedulingRules, now: Date): Date {
  if (!service.supports_instant) {
    throw new BusinessRuleError(
      'INSTANT_NOT_SUPPORTED',
      'This service must be scheduled in advance',
    );
  }
  const earliest = now.getTime() + service.buffer_before_minutes * MINUTE_MS;
  const step = INSTANT_ROUNDING_MINUTES * MINUTE_MS;
  return new Date(Math.ceil(earliest / step) * step);
}

/** Validates a customer-chosen start time against the service's booking window. */
export function validateScheduledStart(
  service: SchedulingRules,
  start: Date | null,
  now: Date,
): Date {
  if (!service.supports_scheduled) {
    throw new BusinessRuleError(
      'SCHEDULED_NOT_SUPPORTED',
      'This service is only available instantly',
    );
  }
  if (!start || Number.isNaN(start.getTime())) {
    throw new ValidationError('START_TIME_REQUIRED', 'Please choose a date and time');
  }
  if (start.getTime() % (SLOT_GRANULARITY_MINUTES * MINUTE_MS) !== 0) {
    throw new ValidationError(
      'START_TIME_NOT_ON_SLOT',
      `Start time must be on a ${SLOT_GRANULARITY_MINUTES}-minute boundary`,
    );
  }
  const earliest = now.getTime() + service.min_lead_time_minutes * MINUTE_MS;
  if (start.getTime() < earliest) {
    throw new ValidationError('START_TIME_TOO_SOON', 'Please choose a later time', {
      earliest: new Date(earliest).toISOString(),
    });
  }
  const latest = now.getTime() + service.max_advance_days * 24 * 60 * MINUTE_MS;
  if (start.getTime() > latest) {
    throw new ValidationError('START_TIME_TOO_FAR', 'Please choose an earlier date', {
      latest: new Date(latest).toISOString(),
    });
  }
  return start;
}
