import * as Location from 'expo-location';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ApiError, type CustomerBooking, type Invoice } from '@onetappe/api-client';
import {
  Body,
  Button,
  Card,
  Choice,
  commonStrings,
  dateTime,
  describeError,
  Field,
  Heading,
  Loading,
  money,
  Notice,
  Row,
  space,
  Title,
  useLoad,
} from '@onetappe/mobile-kit';
import { newKey } from '../../src/key';
import { useSession } from '../../src/session';
import { STATUS } from '../../src/strings';
import { AppScreen } from '../../src/ui';

const FINAL = new Set(['CLOSED', 'CANCELLED', 'EXPIRED', 'NO_SHOW']);
const VISIT = new Set(['EN_ROUTE', 'ARRIVED', 'IN_PROGRESS']);
const POLL_MS = 5000;

type Problem = ReturnType<typeof describeError>;

/**
 * C-17 … C-26, C-28: the booking as it happens — assignment, the professional on the way,
 * the start code, the timer, completion, rating and invoice. The screen follows the
 * server's status; nothing here moves the booking forward except the customer's own
 * actions (cancel, rate).
 */
export default function BookingScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api, locale, t } = useSession();
  const live = useLoad(() => api.customer.booking(id), [id], {
    every: POLL_MS,
    stop: (b) => FINAL.has(b.status) && !b.actions.canRate,
  });
  const booking = live.data;
  const [notice, setNotice] = useState<{
    kind: 'ok' | 'error';
    text: string;
    reference: string | null;
  } | null>(null);

  const report = (problem: Problem) =>
    setNotice({ kind: 'error', text: problem.message, reference: problem.reference });

  if (!booking) {
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

  const rescheduled = booking.schedule.original.start !== booking.schedule.current.start;

  return (
    <AppScreen>
      <Title>{t.statusTitle}</Title>
      <Card>
        <Heading>{booking.service.name}</Heading>
        <Body>{STATUS[locale][booking.status] ?? booking.status}</Body>
        <Row label={t.bookingCode} value={booking.bookingCode} />
        <Row label={t.scheduled} value={dateTime(booking.schedule.current.start, locale)} />
        {rescheduled ? (
          <Row label={t.originally} value={dateTime(booking.schedule.original.start, locale)} />
        ) : null}
        <Row label={t.total} value={money(booking.price.totalPaise, locale)} />
      </Card>
      {notice ? (
        <Notice kind={notice.kind} reference={notice.reference} locale={locale}>
          {notice.text}
        </Notice>
      ) : null}

      {booking.actions.canPay ? (
        <Button
          label={t.payNow}
          onPress={() => router.push({ pathname: '/pay/[id]', params: { id } })}
        />
      ) : null}

      {booking.worker ? (
        <Card>
          <Heading>{t.professional}</Heading>
          <Body>
            {booking.worker.firstName ?? ''} · {t.workerId} {booking.worker.workerCode}
          </Body>
          <Body muted>{t.checkId}</Body>
        </Card>
      ) : null}

      {booking.actions.canViewStartCode ? <StartCode bookingId={id} onError={report} /> : null}
      {booking.status === 'IN_PROGRESS' ? <Timer booking={booking} /> : null}

      {booking.tasks.length > 0 ? (
        <Card>
          <Heading>{t.tasksTitle}</Heading>
          {booking.tasks.map((task) => (
            <Body key={`${String(task.priority)}-${task.name}`}>
              {task.status === 'DONE' ? '✓ ' : '• '}
              {task.name}
            </Body>
          ))}
        </Card>
      ) : null}

      {booking.actions.canRate ? (
        <Rate
          bookingId={id}
          onDone={() => {
            setNotice({ kind: 'ok', text: t.thanksRating, reference: null });
            void live.reload();
          }}
          onError={report}
        />
      ) : null}
      {booking.status === 'COMPLETED' || booking.status === 'CLOSED' ? (
        <InvoiceCard bookingId={id} />
      ) : null}

      {booking.actions.canCancel ? (
        <Cancel
          bookingId={id}
          onDone={(updated) => {
            live.setData(updated);
            setNotice({ kind: 'ok', text: t.cancelled, reference: null });
          }}
          onError={report}
        />
      ) : null}

      {VISIT.has(booking.status) ? <Sos bookingId={id} onError={report} /> : null}
      <Button
        kind="secondary"
        label={t.support}
        onPress={() => router.push({ pathname: '/support', params: { bookingId: id } })}
      />
      <Button kind="secondary" label={t.home} onPress={() => router.replace('/home')} />
    </AppScreen>
  );
}

function StartCode({ bookingId, onError }: { bookingId: string; onError: (p: Problem) => void }) {
  const { api, locale, t } = useSession();
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const show = async () => {
    setBusy(true);
    try {
      setCode((await api.customer.startCode(bookingId)).code);
    } catch (error) {
      onError(describeError(error, locale));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <Heading>{t.startCodeTitle}</Heading>
      <Body>{t.startCodeGuidance}</Body>
      {code ? (
        <Title testID="start-code">{code.split('').join(' ')}</Title>
      ) : (
        <Button
          label={t.showStartCode}
          onPress={() => void show()}
          busy={busy}
          testID="show-start-code"
        />
      )}
    </Card>
  );
}

/** Counts from the recorded start (the status history), not from the phone's clock. */
function Timer({ booking }: { booking: CustomerBooking }) {
  const { api, locale, t } = useSession();
  const timeline = useLoad(() => api.customer.timeline(booking.id), [booking.id]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const started = timeline.data?.statuses.find((s) => s.to === 'IN_PROGRESS')?.at;
  if (!started) return null;
  const seconds = Math.max(0, Math.floor((now - Date.parse(started)) / 1000));
  const hh = Math.floor(seconds / 3600);
  const mm = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  return (
    <Card>
      <Heading>{t.serviceStarted}</Heading>
      <Row label={dateTime(started, locale)} value={`${String(hh)}:${mm}:${ss}`} />
      <Row label={t.serviceEnds} value={dateTime(booking.schedule.current.end, locale)} />
    </Card>
  );
}

function Rate({
  bookingId,
  onDone,
  onError,
}: {
  bookingId: string;
  onDone: () => void;
  onError: (p: Problem) => void;
}) {
  const { api, locale, t } = useSession();
  const [score, setScore] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api.customer.rate(bookingId, { score, comment: comment.trim() || null });
      onDone();
    } catch (error) {
      onError(describeError(error, locale));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <Heading>{t.rateTitle}</Heading>
      <View style={styles.wrap}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Choice
            key={n}
            label={`${String(n)} ★`}
            selected={score === n}
            onPress={() => setScore(n)}
            testID={`rate-${String(n)}`}
          />
        ))}
      </View>
      <Field
        label={t.ratingComment}
        value={comment}
        onChangeText={setComment}
        maxLength={1000}
        multiline
      />
      <Button
        label={t.submitRating}
        onPress={() => void submit()}
        busy={busy}
        disabled={score === 0}
      />
    </Card>
  );
}

function InvoiceCard({ bookingId }: { bookingId: string }) {
  const { api, locale, t } = useSession();
  // The invoice is issued shortly after completion; until then there is simply none yet.
  const invoice = useLoad<Invoice | null>(
    () =>
      api.customer.invoice(bookingId).catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }),
    [bookingId],
    { every: 10_000, stop: (value) => value !== null },
  );
  if (!invoice.data) return null;
  const inv = invoice.data;
  return (
    <Card>
      <Heading>{t.invoice}</Heading>
      <Row label={t.invoiceNumber} value={inv.invoiceNumber} />
      <Body muted>
        {inv.issuer.legalName}
        {inv.issuer.gstin ? ` · GSTIN ${inv.issuer.gstin}` : ''}
      </Body>
      <Body muted>{dateTime(inv.issuedAt, locale)}</Body>
      {inv.lines.map((line) => (
        <Row
          key={`${line.type}-${line.code}`}
          label={line.label}
          value={money(line.amountPaise, locale)}
        />
      ))}
      <Row label={t.total} value={money(inv.totalPaise, locale)} />
    </Card>
  );
}

function Cancel({
  bookingId,
  onDone,
  onError,
}: {
  bookingId: string;
  onDone: (booking: CustomerBooking) => void;
  onError: (p: Problem) => void;
}) {
  const { api, locale, t } = useSession();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  if (!open)
    return <Button kind="secondary" label={t.cancelBooking} onPress={() => setOpen(true)} />;
  const confirm = async () => {
    setBusy(true);
    try {
      onDone((await api.customer.cancel(bookingId, reason.trim())).booking);
      setOpen(false);
    } catch (error) {
      onError(describeError(error, locale));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <Heading>{t.cancelBooking}</Heading>
      <Body muted>{t.cancelRefundNote}</Body>
      <Field label={t.cancelReason} value={reason} onChangeText={setReason} maxLength={500} />
      <Button
        kind="danger"
        label={t.confirmCancel}
        onPress={() => void confirm()}
        busy={busy}
        disabled={reason.trim().length < 3}
      />
      <Button kind="secondary" label={t.keepBooking} onPress={() => setOpen(false)} />
    </Card>
  );
}

/** Opens a critical safety incident; the location is attached when the phone has it. */
function Sos({ bookingId, onError }: { bookingId: string; onError: (p: Problem) => void }) {
  const { api, locale, t } = useSession();
  const [armed, setArmed] = useState(false);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const key = useRef(newKey());
  const send = async () => {
    setBusy(true);
    try {
      let lat: number | null = null;
      let lng: number | null = null;
      try {
        const permission = await Location.getForegroundPermissionsAsync();
        if (permission.granted) {
          const position = await Location.getLastKnownPositionAsync();
          lat = position?.coords.latitude ?? null;
          lng = position?.coords.longitude ?? null;
        }
      } catch {
        // Location is helpful, never a reason to delay an SOS.
      }
      await api.customer.sos({ bookingId, lat, lng }, key.current);
      setSent(true);
    } catch (error) {
      onError(describeError(error, locale));
    } finally {
      setBusy(false);
    }
  };
  if (sent) return <Notice kind="ok">{t.sosSent}</Notice>;
  return armed ? (
    <Card>
      <Body>{t.sosConfirm}</Body>
      <Button kind="danger" label={t.sosSend} onPress={() => void send()} busy={busy} />
      <Button kind="secondary" label={commonStrings[locale].back} onPress={() => setArmed(false)} />
    </Card>
  ) : (
    <Button kind="danger" label={t.sos} onPress={() => setArmed(true)} />
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
});
