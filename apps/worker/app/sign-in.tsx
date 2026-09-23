import { useRouter } from 'expo-router';
import { Button, PhoneSignIn } from '@onetappe/mobile-kit';
import { nextStep } from '../src/next-step';
import { useSession } from '../src/session';
import { AppScreen } from '../src/ui';

/** W-02: mobile number and SMS code (the same number the onboarding team registered). */
export default function SignIn() {
  const router = useRouter();
  const { api, locale, setLocale, signIn, t } = useSession();
  return (
    <AppScreen sos={false}>
      <PhoneSignIn
        api={api.auth.worker}
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
