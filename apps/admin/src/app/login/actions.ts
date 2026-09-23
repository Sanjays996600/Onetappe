'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ApiError, createApiClient } from '@onetappe/api-client';
import { anonymousApi } from '@/server/api';
import { adminConfig } from '@/server/config';
import { LOCALE_COOKIE } from '@/server/locale';
import {
  clearChallenge,
  clearSession,
  readChallenge,
  readSession,
  sessionFromTokens,
  writeChallenge,
  writeSession,
} from '@/server/session';
import { text } from '@/lib/form';

/** Only paths inside this app (no open redirects to other sites). */
function safeNext(next: string): string {
  return next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export async function login(form: FormData) {
  const email = text(form, 'email').trim();
  const password = text(form, 'password');
  const next = safeNext(text(form, 'next') || '/');
  let outcome: string;
  try {
    const step = await (await anonymousApi()).auth.staff.login({ email, password });
    await writeChallenge({
      challengeToken: step.challengeToken,
      email,
      enrol:
        step.step === 'MFA_ENROLL'
          ? { secret: step.totpSecret, otpauthUrl: step.otpauthUrl }
          : null,
      next,
    });
    outcome = '/login/mfa';
  } catch (error) {
    const code = error instanceof ApiError ? error.code : 'UNAVAILABLE';
    outcome = `/login?error=${encodeURIComponent(code)}&next=${encodeURIComponent(next)}`;
  }
  redirect(outcome);
}

export async function completeMfa(form: FormData) {
  const challenge = await readChallenge();
  if (!challenge) redirect('/login?error=MFA_EXPIRED');
  const code = text(form, 'code').replace(/\s/g, '');
  let outcome: string;
  try {
    const tokens = await (
      await anonymousApi()
    ).auth.staff.completeMfa({
      challengeToken: challenge.challengeToken,
      code,
    });
    await writeSession(sessionFromTokens(tokens, Date.parse(tokens.sessionExpiresAt)));
    await clearChallenge();
    // Remember the staff member's language for the pages outside the session too.
    const me = await createApiClient({
      baseUrl: adminConfig().apiUrl,
      tokens: { get: () => tokens, set: () => undefined },
    }).admin.me();
    (await cookies()).set(LOCALE_COOKIE, me.locale === 'hi' ? 'hi' : 'en', {
      httpOnly: true,
      sameSite: 'strict',
      secure: adminConfig().production,
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
    });
    outcome = challenge.next;
  } catch (error) {
    const expired = error instanceof ApiError && error.code !== 'MFA_INVALID';
    outcome = expired ? '/login?error=MFA_EXPIRED' : '/login/mfa?error=MFA_INVALID';
    if (expired) await clearChallenge();
  }
  redirect(outcome);
}

export async function logout() {
  const session = await readSession();
  if (session) {
    try {
      await createApiClient({
        baseUrl: adminConfig().apiUrl,
        tokens: { get: () => session, set: () => undefined },
      }).auth.logout();
    } catch {
      // The session ends here regardless; the API expires it on its own.
    }
  }
  await clearSession();
  redirect('/login');
}

export async function acceptInvitation(form: FormData) {
  const token = text(form, 'token');
  const password = text(form, 'password');
  let outcome: string;
  try {
    await (await anonymousApi()).auth.staff.acceptInvitation({ token, password });
    outcome = '/login?notice=INVITATION_ACCEPTED';
  } catch (error) {
    const code = error instanceof ApiError ? error.code : 'UNAVAILABLE';
    outcome = `/accept-invitation?token=${encodeURIComponent(token)}&error=${encodeURIComponent(code)}`;
  }
  redirect(outcome);
}
