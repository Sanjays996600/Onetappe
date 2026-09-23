import { useRouter } from 'expo-router';
import { Button, PhoneSignIn } from '@onetappe/mobile-kit';
import { nextStep } from '../src/next-step';
import { useSession } from '../src/session';
import { AppScreen } from '../src/ui';

/** C-02 / C-03: mobile number and SMS code. */
export default function SignIn() {
  const router = useRouter();
  const { api, locale, setLocale, signIn, t } = useSession();
  return (
    <AppScreen>
      <PhoneSignIn
        api={api.auth.customer}
        locale={locale}
        title={t.signInTitle}
        onSignedIn={async (session) => {
          await signIn(session);
          router.replace(await nextStep(api));
        }}
      />
      <Button
        kind="secondary"
        label={t.language}
        onPress={() => setLocale(locale === 'en' ? 'hi' : 'en')}
      />
    </AppScreen>
  );
}
