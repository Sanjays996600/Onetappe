import {
  Body,
  Card,
  dateTime,
  describeError,
  Heading,
  Loading,
  money,
  Notice,
  Row,
  Title,
  useLoad,
} from '@onetappe/mobile-kit';
import { useSession } from '../src/session';
import { EARNING_TYPES, JOB_STATUS } from '../src/strings';
import { AppScreen } from '../src/ui';

/** W-17: pay per job with its status, and the jobs done. */
export default function Earnings() {
  const { api, locale, t } = useSession();
  const data = useLoad(async () => {
    const [earnings, jobs] = await Promise.all([api.worker.earnings(), api.worker.jobs()]);
    return { earnings, jobs };
  }, []);

  if (!data.data) {
    return (
      <AppScreen>
        {data.error ? (
          <Notice kind="error" locale={locale}>
            {describeError(data.error, locale).message}
          </Notice>
        ) : (
          <Loading locale={locale} />
        )}
      </AppScreen>
    );
  }
  const { earnings, jobs } = data.data;
  return (
    <AppScreen>
      <Title>{t.earnings}</Title>
      <Card>
        <Heading>{t.totals}</Heading>
        {Object.entries(earnings.totalsPaise).map(([status, paise]) => (
          <Row key={status} label={status} value={money(paise, locale)} />
        ))}
      </Card>
      {earnings.items.length === 0 ? <Body muted>{t.noEarnings}</Body> : null}
      {earnings.items.map((item) => (
        <Card key={item.id}>
          <Row
            label={`${EARNING_TYPES[locale][item.type] ?? item.type}${item.bookingCode ? ` · ${item.bookingCode}` : ''}`}
            value={money(item.amountPaise, locale)}
          />
          <Body muted>
            {item.status} · {dateTime(item.createdAt, locale)}
          </Body>
          {item.description ? <Body muted>{item.description}</Body> : null}
        </Card>
      ))}
      <Heading>{t.history}</Heading>
      {jobs.map((job) => (
        <Card key={job.bookingId}>
          <Body>
            {job.service} · {job.bookingCode}
          </Body>
          <Body muted>
            {job.locality} · {dateTime(job.start, locale)} ·{' '}
            {JOB_STATUS[locale][job.status] ?? job.status}
          </Body>
        </Card>
      ))}
    </AppScreen>
  );
}
