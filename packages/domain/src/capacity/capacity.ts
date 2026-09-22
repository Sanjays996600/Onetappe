/**
 * Capacity arithmetic from the pilot playbook: a worker's reservation covers travel
 * before the visit, the visit itself and reset time after it, and only a share of the
 * workable day is sold so there is room to recover from disruption.
 */

export interface ServiceTiming {
  readonly durationMinutes: number;
  readonly bufferBeforeMinutes: number;
  readonly bufferAfterMinutes: number;
}

export interface TimeRange {
  readonly start: Date;
  readonly end: Date;
}

const MINUTE_MS = 60_000;

function assertWholeMinutes(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative whole number of minutes`);
  }
}

/** The customer-facing promise: [start, start + duration). */
export function servicePeriod(start: Date, timing: ServiceTiming): TimeRange {
  assertWholeMinutes(timing.durationMinutes, 'durationMinutes');
  if (timing.durationMinutes === 0) throw new RangeError('durationMinutes must be positive');
  return { start, end: new Date(start.getTime() + timing.durationMinutes * MINUTE_MS) };
}

/** The worker's blocked time: travel buffer + service + reset buffer. */
export function reservationPeriod(start: Date, timing: ServiceTiming): TimeRange {
  assertWholeMinutes(timing.bufferBeforeMinutes, 'bufferBeforeMinutes');
  assertWholeMinutes(timing.bufferAfterMinutes, 'bufferAfterMinutes');
  const service = servicePeriod(start, timing);
  return {
    start: new Date(service.start.getTime() - timing.bufferBeforeMinutes * MINUTE_MS),
    end: new Date(service.end.getTime() + timing.bufferAfterMinutes * MINUTE_MS),
  };
}

export function blockMinutes(timing: ServiceTiming): number {
  return timing.bufferBeforeMinutes + timing.durationMinutes + timing.bufferAfterMinutes;
}

export interface DailyCapacityInput {
  readonly workers: number;
  readonly rosterMinutesPerWorker: number;
  readonly breakAndAdminMinutesPerWorker: number;
  /** Share of workable time that may be sold, in basis points (8000 = 80%). */
  readonly bookableShareBp: number;
  readonly timing: ServiceTiming;
}

/** Upper bound on jobs per day for planning; always rounded down. */
export function maxJobsPerDay(input: DailyCapacityInput): number {
  const workable =
    input.workers * (input.rosterMinutesPerWorker - input.breakAndAdminMinutesPerWorker);
  if (workable <= 0) return 0;
  const bookable = Math.floor((workable * input.bookableShareBp) / 10_000);
  return Math.floor(bookable / blockMinutes(input.timing));
}

export function rangesOverlap(a: TimeRange, b: TimeRange): boolean {
  return a.start < b.end && b.start < a.end;
}
