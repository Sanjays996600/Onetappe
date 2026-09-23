import 'server-only';
import { cookies } from 'next/headers';
import { adminConfig } from './config';
import { seal, unseal } from './seal';
import {
  sealSession,
  sessionCookieName,
  sessionCookieOptions,
  unsealSession,
  type AdminSession,
} from './session-codec';

export { sessionFromTokens, type AdminSession } from './session-codec';

/** Between password and authenticator code (5 minutes). */
export interface MfaChallenge {
  readonly challengeToken: string;
  readonly email: string;
  readonly enrol: { readonly secret: string; readonly otpauthUrl: string } | null;
  readonly next: string;
}

const production = () => adminConfig().production;
const mfaCookieName = () => (production() ? '__Host-ot_mfa' : 'ot_mfa');

const cookieOptions = sessionCookieOptions;

export async function readSession(): Promise<AdminSession | null> {
  return unsealSession((await cookies()).get(sessionCookieName())?.value);
}

/** Only possible in a server action or route handler (not while rendering a page). */
export async function writeSession(session: AdminSession): Promise<void> {
  (await cookies()).set(
    sessionCookieName(),
    sealSession(session),
    cookieOptions(session.sessionExpiresAt),
  );
}

export async function clearSession(): Promise<void> {
  (await cookies()).set(sessionCookieName(), '', cookieOptions(0));
}

export async function readChallenge(): Promise<MfaChallenge | null> {
  return unseal(
    adminConfig().sessionKey,
    'mfa',
    (await cookies()).get(mfaCookieName())?.value,
  ) as MfaChallenge | null;
}

export async function writeChallenge(challenge: MfaChallenge): Promise<void> {
  const expiresAt = Date.now() + 5 * 60_000;
  (await cookies()).set(
    mfaCookieName(),
    seal(adminConfig().sessionKey, 'mfa', challenge, expiresAt),
    cookieOptions(expiresAt),
  );
}

export async function clearChallenge(): Promise<void> {
  (await cookies()).set(mfaCookieName(), '', cookieOptions(0));
}
