import 'server-only';
import { cookies } from 'next/headers';
import { adminConfig } from './config';
import { seal, unseal } from './seal';

/**
 * A secret shown once on the next page (an invitation link), kept out of the URL so it
 * never lands in browser history or access logs. Sealed, httpOnly, 2 minutes.
 */
const NAME = 'ot_flash';

export async function setFlash(value: Record<string, string>): Promise<void> {
  const expiresAt = Date.now() + 120_000;
  (await cookies()).set(NAME, seal(adminConfig().sessionKey, 'flash', value, expiresAt), {
    httpOnly: true,
    secure: adminConfig().production,
    sameSite: 'strict',
    path: '/',
    expires: new Date(expiresAt),
  });
}

export async function readFlash(): Promise<Record<string, string> | null> {
  return unseal(adminConfig().sessionKey, 'flash', (await cookies()).get(NAME)?.value) as Record<
    string,
    string
  > | null;
}
