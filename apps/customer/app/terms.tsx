import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Linking } from 'react-native';
import {
  Body,
  Button,
  Card,
  describeError,
  Loading,
  Notice,
  Title,
  useLoad,
} from '@onetappe/mobile-kit';
import { nextStep } from '../src/next-step';
import { useSession } from '../src/session';
import { AppScreen } from '../src/ui';

/** The current terms and privacy notice; accepting records exactly these versions. */
export default function Terms() {
  const router = useRouter();
  const { api, locale, t } = useSession();
  const status = useLoad(() => api.legal.status(locale), [locale]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ReturnType<typeof describeError> | null>(null);

  const pending = status.data?.required.filter((d) => !d.accepted) ?? [];

  const accept = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await api.legal.accept(pending.map((d) => d.id));
      router.replace(await nextStep(api));
    } catch (error) {
      setProblem(describeError(error, locale));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppScreen>
      <Title>{t.termsTitle}</Title>
      {status.error ? (
        <Notice kind="error" locale={locale}>
          {describeError(status.error, locale).message}
        </Notice>
      ) : null}
      {problem ? (
        <Notice kind="error" reference={problem.reference} locale={locale}>
          {problem.message}
        </Notice>
      ) : null}
      {!status.data ? (
        <Loading locale={locale} />
      ) : (
        <>
          <Body>{t.termsIntro}</Body>
          {pending.map((doc) => (
            <Card key={doc.id}>
              <Body>
                {doc.title} ({doc.version})
              </Body>
              <Button
                kind="secondary"
                label={`${t.readDocument}: ${doc.title}`}
                onPress={() => void Linking.openURL(doc.url)}
              />
            </Card>
          ))}
          <Button
            label={t.accept}
            onPress={() => void accept()}
            busy={busy}
            testID="accept-terms"
          />
        </>
      )}
    </AppScreen>
  );
}
