import { formatInr } from '@onetappe/domain';

/** Replaces {{name}} placeholders; unknown placeholders are left visible so they get noticed. */
export function renderTemplate(
  template: string,
  variables: Readonly<Record<string, string>>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => variables[name] ?? match);
}

const LOCALE_TAGS: Record<string, string> = { en: 'en-IN', hi: 'hi-IN' };

/** "24 Sep, 10:00 am" in the city's time zone and the reader's language. */
export function formatDateTime(instant: Date, timeZone: string, locale: string): string {
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale] ?? 'en-IN', {
    timeZone,
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(instant);
}

export function formatAmount(paise: number, locale: string): string {
  return formatInr(paise, LOCALE_TAGS[locale] ?? 'en-IN');
}

/**
 * Stored notification variables → display strings in the reader's language: instants
 * (stored as { $date }) in the city's time zone, amounts (paise) as rupees.
 */
export function formatVariables(
  raw: unknown,
  locale: string,
  timeZone: string,
): Record<string, string> {
  const values = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value && typeof value === 'object' && '$date' in value) {
      out[key] = formatDateTime(new Date(String(value.$date)), timeZone, locale);
    } else if (typeof value === 'number' && /amount/i.test(key)) {
      out[key] = formatAmount(value, locale);
    } else {
      out[key] = String(value);
    }
  }
  return out;
}
