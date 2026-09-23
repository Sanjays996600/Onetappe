import { translator } from '@/i18n/dictionaries';
import { Notice } from '@/components/Notice';
import { requestLocale } from '@/server/locale';
import { login } from './actions';

type Search = Promise<{ error?: string; notice?: string; next?: string }>;

export default async function LoginPage({ searchParams }: { searchParams: Search }) {
  const t = translator(await requestLocale());
  const { error, notice, next } = await searchParams;
  const message =
    error === 'LOGIN_INVALID'
      ? t('loginInvalid')
      : error === 'ACCOUNT_LOCKED'
        ? t('accountLocked')
        : error === 'MFA_EXPIRED'
          ? t('mfaExpired')
          : error
            ? t('apiUnavailable')
            : null;
  return (
    <main className="narrow">
      <h1>{t('appName')}</h1>
      {notice === 'INVITATION_ACCEPTED' && <Notice kind="ok">{t('invitationAccepted')}</Notice>}
      {message && <Notice kind="error">{message}</Notice>}
      <form action={login} className="stack card">
        <input type="hidden" name="next" value={next ?? '/'} />
        <label>
          {t('email')}
          <input name="email" type="email" autoComplete="username" required />
        </label>
        <label>
          {t('password')}
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <button type="submit">{t('signIn')}</button>
      </form>
    </main>
  );
}
