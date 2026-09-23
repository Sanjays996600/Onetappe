import { useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import {
  Body,
  Button,
  Card,
  Choice,
  dateTime,
  describeError,
  Field,
  Heading,
  Notice,
  Title,
  useLoad,
} from '@onetappe/mobile-kit';
import { newKey } from '../src/key';
import { useSession } from '../src/session';
import { SUPPORT_CATEGORIES } from '../src/strings';
import { AppScreen } from '../src/ui';

/**
 * C-27: report a problem. The case is recorded by One Tappe first and then handed to the
 * support desk (Zoho Desk) in the background, so a desk outage never loses a request.
 * Feeling unsafe is not a support case: that is the SOS on the booking (or 112).
 */
export default function Support() {
  const { bookingId } = useLocalSearchParams<{ bookingId?: string }>();
  const { api, locale, t } = useSession();
  const cases = useLoad(() => api.customer.supportCases(), []);
  const [category, setCategory] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    kind: 'ok' | 'error';
    text: string;
    reference: string | null;
  } | null>(null);
  const key = useRef(newKey());

  const send = async () => {
    if (!category) return;
    setBusy(true);
    setNotice(null);
    try {
      const opened = await api.customer.openSupportCase(
        {
          bookingId: bookingId || null,
          category,
          subject: subject.trim(),
          description: description.trim(),
        },
        key.current,
      );
      key.current = newKey();
      setNotice({ kind: 'ok', text: `${t.caseOpened}: ${opened.caseCode}`, reference: null });
      setCategory(null);
      setSubject('');
      setDescription('');
      void cases.reload();
    } catch (error) {
      const problem = describeError(error, locale);
      setNotice({ kind: 'error', text: problem.message, reference: problem.reference });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppScreen>
      <Title>{t.supportTitle}</Title>
      {notice ? (
        <Notice kind={notice.kind} reference={notice.reference} locale={locale}>
          {notice.text}
        </Notice>
      ) : null}
      <Heading>{t.category}</Heading>
      {SUPPORT_CATEGORIES[locale].map(([code, label]) => (
        <Choice
          key={code}
          label={label}
          selected={category === code}
          onPress={() => {
            setCategory(code);
            key.current = newKey();
          }}
        />
      ))}
      <Field
        label={t.subject}
        value={subject}
        onChangeText={(v) => {
          setSubject(v);
          key.current = newKey();
        }}
        maxLength={150}
      />
      <Field
        label={t.description}
        value={description}
        onChangeText={(v) => {
          setDescription(v);
          key.current = newKey();
        }}
        maxLength={4000}
        multiline
      />
      <Button
        label={t.sendToSupport}
        onPress={() => void send()}
        busy={busy}
        disabled={!category || subject.trim().length < 3 || description.trim().length < 10}
      />
      {cases.data && cases.data.length > 0 ? <Heading>{t.yourCases}</Heading> : null}
      {cases.data?.map((c) => (
        <Card key={c.id}>
          <Body>
            {c.caseCode} · {c.subject}
          </Body>
          <Body muted>
            {c.status} · {dateTime(c.openedAt, locale)}
          </Body>
          {c.resolution ? <Body>{c.resolution}</Body> : null}
        </Card>
      ))}
    </AppScreen>
  );
}
