import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Linking } from 'react-native';
import type { Job } from '@onetappe/api-client';
import {
  Body,
  Button,
  Card,
  dateTime,
  describeError,
  Field,
  Heading,
  Loading,
  Notice,
  Row,
  Title,
  useLoad,
} from '@onetappe/mobile-kit';
import { useSession } from '../../src/session';
import { JOB_STATUS } from '../../src/strings';
import { AppScreen } from '../../src/ui';

const FINAL = new Set(['COMPLETED', 'CLOSED', 'CANCELLED', 'NO_SHOW']);
const POLL_MS = 5000;

const part = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);

/**
 * W-10 … W-16: the accepted job, one step at a time. Each button asks the server, which
 * checks the booking's state and this worker's assignment; a repeated tap after lost
 * signal is answered with the step already done, not a second transition.
 */
export default function JobScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api, locale, t } = useSession();
  const live = useLoad(() => api.worker.job(id), [id], {
    every: POLL_MS,
    stop: (job) => FINAL.has(job.status),
  });
  const [code, setCode] = useState('');
  const [noShow, setNoShow] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ReturnType<typeof describeError> | null>(null);

  const step = async (action: () => Promise<Job>) => {
    setBusy(true);
    setProblem(null);
    try {
      live.setData(await action());
    } catch (error) {
      setProblem(
        describeError(error, locale, {
          CODE_INCORRECT: t.codeIncorrect,
          CODE_FORMAT: t.codeIncorrect,
          CODE_LOCKED: t.codeLocked,
        }),
      );
      void live.reload();
    } finally {
      setBusy(false);
    }
  };

  const job = live.data;
  if (!job) {
    return (
      <AppScreen>
        {live.error ? (
          <Notice kind="error" locale={locale}>
            {describeError(live.error, locale).message}
          </Notice>
        ) : (
          <Loading locale={locale} />
        )}
      </AppScreen>
    );
  }

  const a = job.address;
  const lines = [a.houseNumber, a.building, a.street, a.landmark].map(part).filter(Boolean);

  return (
    <AppScreen>
      <Title>
        {t.jobTitle} {job.bookingCode}
      </Title>
      <Card>
        <Heading>{job.service}</Heading>
        <Body>{JOB_STATUS[locale][job.status] ?? job.status}</Body>
        <Row
          label={dateTime(job.start, locale)}
          value={`${t.plannedEnd} ${dateTime(job.end, locale)}`}
        />
        {job.customerFirstName ? <Row label={t.customer} value={job.customerFirstName} /> : null}
      </Card>
      {problem ? (
        <Notice kind="error" reference={problem.reference} locale={locale}>
          {problem.message}
        </Notice>
      ) : null}

      <Card>
        <Heading>{t.address}</Heading>
        <Body>{lines.join(', ')}</Body>
        <Body muted>
          {part(a.cityName)} {part(a.pincode)}
        </Body>
        {part(a.accessNotes) ? <Row label={t.accessNotes} value={part(a.accessNotes)} /> : null}
        {a.lat !== null && a.lng !== null ? (
          <Button
            kind="secondary"
            label={t.navigate}
            onPress={() =>
              void Linking.openURL(
                `https://www.google.com/maps/dir/?api=1&destination=${String(a.lat)},${String(a.lng ?? '')}`,
              )
            }
          />
        ) : null}
        {a.contactPhone ? (
          <Button
            kind="secondary"
            label={t.callCustomer}
            onPress={() => void Linking.openURL(`tel:${a.contactPhone ?? ''}`)}
          />
        ) : null}
      </Card>

      {job.notes ? <Notice kind="warning">{job.notes}</Notice> : null}

      {job.tasks.length > 0 ? (
        <Card>
          <Heading>{t.tasks}</Heading>
          {job.tasks.map((task) => (
            <Body key={`${String(task.priority)}-${task.name}`}>
              {String(task.priority)}. {task.name}
            </Body>
          ))}
        </Card>
      ) : null}

      {job.status === 'ASSIGNED' ? (
        <Button
          label={t.onTheWay}
          busy={busy}
          onPress={() => void step(() => api.worker.onTheWay(id))}
          testID="on-the-way"
        />
      ) : null}
      {job.status === 'EN_ROUTE' ? (
        <Button
          label={t.arrived}
          busy={busy}
          onPress={() => void step(() => api.worker.arrived(id))}
          testID="arrived"
        />
      ) : null}
      {job.status === 'ARRIVED' ? (
        <Card>
          <Body>{t.showId}</Body>
          <Field
            label={t.startCode}
            value={code}
            onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 4))}
            keyboardType="number-pad"
            maxLength={4}
          />
          <Button
            label={t.startJob}
            busy={busy}
            disabled={code.length !== 4}
            onPress={() => void step(() => api.worker.start(id, code))}
            testID="start-job"
          />
        </Card>
      ) : null}
      {job.status === 'ARRIVED' ? (
        noShow === null ? (
          <Button kind="secondary" label={t.customerNoShow} onPress={() => setNoShow('')} />
        ) : (
          <Card>
            <Field label={t.noShowReason} value={noShow} onChangeText={setNoShow} maxLength={500} />
            <Button
              kind="danger"
              label={t.confirmNoShow}
              busy={busy}
              disabled={noShow.trim().length < 3}
              onPress={() => void step(() => api.worker.customerNoShow(id, noShow.trim()))}
            />
          </Card>
        )
      ) : null}
      {job.status === 'IN_PROGRESS' ? (
        <Button
          label={t.complete}
          busy={busy}
          onPress={() => void step(() => api.worker.complete(id))}
          testID="complete-job"
        />
      ) : null}
      {job.status === 'COMPLETED' || job.status === 'CLOSED' ? (
        <Notice kind="ok">{t.completed}</Notice>
      ) : null}

      <Button kind="secondary" label={t.home} onPress={() => router.replace('/home')} />
    </AppScreen>
  );
}
