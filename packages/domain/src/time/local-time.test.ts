import { describe, expect, it } from 'vitest';
import { isWithinDailyWindow, toLocalClock } from './local-time.js';

describe('local time', () => {
  it('converts UTC instants to India wall-clock time', () => {
    // 2026-09-22T18:45Z is 2026-09-23 00:15 IST (a Wednesday).
    expect(toLocalClock(new Date('2026-09-22T18:45:00Z'))).toEqual({
      weekday: 3,
      minuteOfDay: 15,
      date: '2026-09-23',
    });
  });

  it('handles windows that cross midnight', () => {
    expect(isWithinDailyWindow(23 * 60, 22 * 60, 6 * 60)).toBe(true);
    expect(isWithinDailyWindow(5 * 60, 22 * 60, 6 * 60)).toBe(true);
    expect(isWithinDailyWindow(12 * 60, 22 * 60, 6 * 60)).toBe(false);
    expect(isWithinDailyWindow(8 * 60, 8 * 60, 18 * 60)).toBe(true);
    expect(isWithinDailyWindow(18 * 60, 8 * 60, 18 * 60)).toBe(false);
  });
});
