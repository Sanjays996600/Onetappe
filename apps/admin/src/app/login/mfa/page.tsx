import { redirect } from 'next/navigation';
import QRCode from 'qrcode';
import { translator } from '@/i18n/dictionaries';
import { Notice } from '@/components/Notice';
import { requestLocale } from '@/server/locale';
import { readChallenge } from '@/server/session';
import { completeMfa } from '../actions';

export default async function MfaPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const t = translator(await requestLocale());
  const challenge = await readChallenge();
  if (!challenge) redirect('/login?error=MFA_EXPIRED');
  const { error } = await searchParams;
  const qr = challenge.enrol
    ? await QRCode.toDataURL(challenge.enrol.otpauthUrl, { margin: 1, width: 220 })
    : null;
  return (
    <main className="narrow">
      <h1>{t('mfaTitle')}</h1>
      {error === 'MFA_INVALID' && <Notice kind="error">{t('mfaInvalid')}</Notice>}
      <form action={completeMfa} className="stack card">
        {challenge.enrol && qr ? (
          <>
            <p>{t('mfaEnrolIntro')}</p>
            <img src={qr} alt={t('mfaEnrolIntro')} width={220} height={220} />
            <p className="muted">
              {t('setupKey')}: <code data-testid="totp-secret">{challenge.enrol.secret}</code>
            </p>
          </>
        ) : (
          <p>{t('mfaEnterCode')}</p>
        )}
        <label>
          {t('mfaCode')}
          <input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 ]{6,7}"
            required
            autoFocus
          />
        </label>
        <button type="submit">{t('continue')}</button>
      </form>
    </main>
  );
}
