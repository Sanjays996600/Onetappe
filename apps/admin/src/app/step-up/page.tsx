import { translator } from '@/i18n/dictionaries';
import { Notice } from '@/components/Notice';
import { requestLocale } from '@/server/locale';
import { stepUp } from './actions';

type Search = Promise<{ next?: string; error?: string }>;

export default async function StepUpPage({ searchParams }: { searchParams: Search }) {
  const t = translator(await requestLocale());
  const { next, error } = await searchParams;
  return (
    <main className="narrow">
      <h1>{t('stepUpTitle')}</h1>
      <p>{t('stepUpIntro')}</p>
      {error && <Notice kind="error">{t('mfaInvalid')}</Notice>}
      <form action={stepUp} className="stack card">
        <input type="hidden" name="next" value={next ?? '/'} />
        <label>
          {t('mfaCode')}
          <input name="code" inputMode="numeric" autoComplete="one-time-code" required autoFocus />
        </label>
        <button type="submit">{t('continue')}</button>
      </form>
    </main>
  );
}
