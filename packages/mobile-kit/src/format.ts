import { formatInr } from '@onetappe/domain';
import type { Locale } from './strings';

const TAGS: Record<Locale, string> = { en: 'en-IN', hi: 'hi-IN' };

/** Money: paise → "₹588.82". */
export const money = (paise: number, locale: Locale) => formatInr(paise, TAGS[locale]);

/** "Thu, 24 Sep, 10:00 am" in India time. */
export function dateTime(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(TAGS[locale], {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function time(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(TAGS[locale], {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** YYYY-MM-DD of the day `offset` days from today, in India. */
export function indiaDate(offset = 0, now = new Date()): string {
  const shifted = new Date(now.getTime() + 330 * 60_000 + offset * 86_400_000);
  return shifted.toISOString().slice(0, 10);
}

/** Indian mobile number as typed → E.164 (+91XXXXXXXXXX), or null when invalid. */
export function toE164(input: string): string | null {
  const digits = input.replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
}
