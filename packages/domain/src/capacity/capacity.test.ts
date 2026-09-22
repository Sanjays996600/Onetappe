import { describe, expect, it } from 'vitest';
import { maxJobsPerDay, rangesOverlap, reservationPeriod, servicePeriod } from './capacity.js';

const HH60 = { durationMinutes: 60, bufferBeforeMinutes: 20, bufferAfterMinutes: 10 };

describe('capacity', () => {
  it('reproduces the playbook example: five helpers give 18 HH60 jobs a day', () => {
    expect(
      maxJobsPerDay({
        workers: 5,
        rosterMinutesPerWorker: 480,
        breakAndAdminMinutesPerWorker: 60,
        bookableShareBp: 8_000,
        timing: HH60,
      }),
    ).toBe(18);
  });

  it('blocks travel and reset time around the promised service window', () => {
    const start = new Date('2026-10-01T04:30:00Z');
    expect(servicePeriod(start, HH60)).toEqual({
      start,
      end: new Date('2026-10-01T05:30:00Z'),
    });
    expect(reservationPeriod(start, HH60)).toEqual({
      start: new Date('2026-10-01T04:10:00Z'),
      end: new Date('2026-10-01T05:40:00Z'),
    });
  });

  it('treats touching ranges as non-overlapping', () => {
    const a = { start: new Date('2026-10-01T04:00:00Z'), end: new Date('2026-10-01T05:00:00Z') };
    const b = { start: new Date('2026-10-01T05:00:00Z'), end: new Date('2026-10-01T06:00:00Z') };
    expect(rangesOverlap(a, b)).toBe(false);
    expect(rangesOverlap(a, { ...b, start: new Date('2026-10-01T04:59:00Z') })).toBe(true);
  });
});
