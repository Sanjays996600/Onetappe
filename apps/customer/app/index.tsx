import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ApiError } from '@onetappe/api-client';
import { Button, commonStrings, describeError, Loading, Notice } from '@onetappe/mobile-kit';
import { nextStep } from '../src/next-step';
import { useSession } from '../src/session';
import { AppScreen } from '../src/ui';

/** C-01: decides where to go — sign in, finish setting up, or home. */
export default function Start() {
  const router = useRouter();
  const { api, isSignedIn, locale } = useSession();
  const [problem, setProblem] = useState<ReturnType<typeof describeError> | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    const stillHere = () => active;
    void (async () => {
      try {
        if (!(await isSignedIn())) {
          router.replace('/sign-in');
          return;
        }
        const next = await nextStep(api);
        if (stillHere()) router.replace(next);
      } catch (error) {
        if (!stillHere()) return;
        if (error instanceof ApiError && error.isSignedOut) {
          router.replace('/sign-in');
          return;
        }
        setProblem(describeError(error, locale));
      }
    })();
    return () => {
      active = false;
    };
  }, [api, isSignedIn, locale, router, attempt]);

  return (
    <AppScreen>
      {problem ? (
        <>
          <Notice kind="error" reference={problem.reference} locale={locale}>
            {problem.message}
          </Notice>
          <Button
            label={commonStrings[locale].retry}
            onPress={() => {
              setProblem(null);
              setAttempt((n) => n + 1);
            }}
          />
        </>
      ) : (
        <Loading locale={locale} />
      )}
    </AppScreen>
  );
}
