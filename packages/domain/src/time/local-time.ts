/**
 * All instants are stored in UTC. Rules that depend on the wall clock (e.g. "evening
 * surcharge after 18:00") are evaluated in the city's IANA time zone.
 */
export const DEFAULT_TIME_ZONE = 'Asia/Kolkata';

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface LocalClock {
  readonly weekday: IsoWeekday;
  /** Minutes since local midnight, 0–1439. */
  readonly minuteOfDay: number;
  /** Local calendar date, `YYYY-MM-DD`. */
  readonly date: string;
}

const WEEKDAYS: Record<string, IsoWeekday> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

export function toLocalClock(instant: Date, timeZone: string = DEFAULT_TIME_ZONE): LocalClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);

  const get = (type: Intl.DateTimeFormatPartTypes): string => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`Missing ${type} while formatting ${instant.toISOString()}`);
    return part.value;
  };

  const weekday = WEEKDAYS[get('weekday')];
  if (!weekday) throw new Error(`Unexpected weekday for ${instant.toISOString()}`);

  return {
    weekday,
    minuteOfDay: Number(get('hour')) * 60 + Number(get('minute')),
    date: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

/**
 * Whether `minuteOfDay` falls inside [start, end). Windows may cross midnight
 * (e.g. 22:00–06:00 is start=1320, end=360).
 */
export function isWithinDailyWindow(minuteOfDay: number, start: number, end: number): boolean {
  if (start === end) return true;
  return start < end
    ? minuteOfDay >= start && minuteOfDay < end
    : minuteOfDay >= start || minuteOfDay < end;
}
