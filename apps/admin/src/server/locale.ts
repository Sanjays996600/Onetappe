import 'server-only';
import { cookies, headers } from 'next/headers';
import type { Locale } from '@/i18n/dictionaries';

export const LOCALE_COOKIE = 'ot_locale';

/** The staff member's language (saved at sign-in), else the browser's, else English. */
export async function requestLocale(): Promise<Locale> {
  const saved = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (saved === 'hi' || saved === 'en') return saved;
  const accept = (await headers()).get('accept-language') ?? '';
  return /^hi\b/i.test(accept) ? 'hi' : 'en';
}
