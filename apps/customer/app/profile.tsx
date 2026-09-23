import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Button, describeError, Field, Notice, Title } from '@onetappe/mobile-kit';
import { nextStep } from '../src/next-step';
import { useSession } from '../src/session';
import { AppScreen } from '../src/ui';

/** C-06 (first part): the customer's name, as the professional will see it. */
export default function Profile() {
  const router = useRouter();
  const { api, locale, t } = useSession();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ReturnType<typeof describeError> | null>(null);

  const save = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await api.customer.updateMe({ fullName: name.trim(), preferredLocale: locale });
      router.replace(await nextStep(api));
    } catch (error) {
      setProblem(describeError(error, locale));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppScreen>
      <Title>{t.profileTitle}</Title>
      {problem ? (
        <Notice kind="error" reference={problem.reference} locale={locale}>
          {problem.message}
        </Notice>
      ) : null}
      <Field
        label={t.fullName}
        value={name}
        onChangeText={setName}
        autoComplete="name"
        textContentType="name"
        maxLength={80}
      />
      <Button
        label={t.saveName}
        onPress={() => void save()}
        busy={busy}
        disabled={name.trim().length < 2}
      />
    </AppScreen>
  );
}
