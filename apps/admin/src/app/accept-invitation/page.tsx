import { translator } from '@/i18n/dictionaries';
import { Notice } from '@/components/Notice';
import { requestLocale } from '@/server/locale';
import { acceptInvitation } from '../login/actions';

type Search = Promise<{ token?: string; error?: string }>;

export default async function AcceptInvitationPage({ searchParams }: { searchParams: Search }) {
  const t = translator(await requestLocale());
  const { token, error } = await searchParams;
  const message =
    error === 'PASSWORD_WEAK'
      ? t('passwordWeak')
      : error === 'INVITATION_INVALID' || !token
        ? t('invitationInvalid')
        : error
          ? t('apiUnavailable')
          : null;
  return (
    <main className="narrow">
      <h1>{t('invitationTitle')}</h1>
      {message && <Notice kind="error">{message}</Notice>}
      {token && (
        <form action={acceptInvitation} className="stack card">
          <p>{t('invitationIntro')}</p>
          <input type="hidden" name="token" value={token} />
          <label>
            {t('newPassword')}
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              required
            />
          </label>
          <button type="submit">{t('continue')}</button>
        </form>
      )}
    </main>
  );
}
