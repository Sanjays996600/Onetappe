import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { Quote, QuoteRequest } from '@onetappe/api-client';
import {
  Body,
  Button,
  Card,
  Choice,
  dateTime,
  describeError,
  Heading,
  indiaDate,
  Loading,
  money,
  Notice,
  Row,
  space,
  time,
  Title,
  useLoad,
} from '@onetappe/mobile-kit';
import { newKey } from '../../src/key';
import { useSession } from '../../src/session';
import { AppScreen } from '../../src/ui';

const DAYS_SHOWN = 7;
const NOW = 'NOW';

/**
 * C-09 … C-15: what to do, when, the full price, the address, then book. The booking
 * carries the total the customer saw (refused if the price changed) and one idempotency
 * key for as long as the same choice is retried.
 */
export default function ServiceScreen() {
  const router = useRouter();
  const { id, addressId } = useLocalSearchParams<{ id: string; addressId: string }>();
  const { api, locale, t } = useSession();

  const detail = useLoad(async () => {
    const [service, addresses] = await Promise.all([
      api.customer.service(id),
      api.customer.addresses(),
    ]);
    return { service, address: addresses.find((a) => a.id === addressId) ?? null };
  }, [id, addressId, locale]);
  const service = detail.data?.service;

  const [tasks, setTasks] = useState<Set<string> | null>(null);
  const [day, setDay] = useState(0);
  // A slot's start time, NOW for "as soon as possible", or null while nothing is chosen.
  const [startAt, setStartAt] = useState<string | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    kind: 'error' | 'warning';
    text: string;
    reference: string | null;
  } | null>(null);
  const key = useRef(newKey());
  const messages = {
    PRICE_CHANGED: t.priceChanged,
    NO_AVAILABILITY: t.noAvailability,
    OUTSIDE_OPERATING_HOURS: t.outsideHours,
  };

  useEffect(() => {
    if (service && tasks === null)
      setTasks(new Set(service.tasks.filter((x) => x.selectedByDefault).map((x) => x.id)));
  }, [service, tasks]);

  // The tasks are part of the booking request, so a different selection is a new attempt.
  useEffect(() => {
    key.current = newKey();
  }, [tasks]);

  const maxDays = Math.min(DAYS_SHOWN, (service?.maxAdvanceDays ?? 0) + 1);
  const slots = useLoad(
    () =>
      service?.supportsScheduled
        ? api.customer.availability({ serviceId: id, addressId, date: indiaDate(day) })
        : Promise.resolve({ date: indiaDate(day), slots: [] as string[] }),
    [id, addressId, day, service?.supportsScheduled],
  );

  const request = (): QuoteRequest | null =>
    startAt === null
      ? null
      : {
          serviceId: id,
          addressId,
          bookingType: startAt === NOW ? 'INSTANT' : 'SCHEDULED',
          startAt: startAt === NOW ? null : startAt,
        };

  // Any change to the choice means a new price and a new booking attempt.
  useEffect(() => {
    key.current = newKey();
    setQuote(null);
    setNotice(null);
    const input = request();
    if (!input) return;
    let active = true;
    api.customer
      .quote(input)
      .then((q) => {
        if (active) setQuote(q);
      })
      .catch((error: unknown) => {
        if (!active) return;
        const problem = describeError(error, locale, messages);
        setNotice({ kind: 'error', text: problem.message, reference: problem.reference });
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- request() is derived from these
  }, [startAt, id, addressId, locale]);

  const book = async () => {
    const input = request();
    if (!input || !quote) return;
    setBusy(true);
    setNotice(null);
    try {
      const booking = await api.customer.book(
        {
          ...input,
          taskIds: tasks ? [...tasks] : null,
          expectedTotalPaise: quote.totalPaise,
        },
        key.current,
      );
      router.replace({ pathname: '/pay/[id]', params: { id: booking.id } });
    } catch (error) {
      const problem = describeError(error, locale, messages);
      setNotice({ kind: 'warning', text: problem.message, reference: problem.reference });
      if (problem.code === 'PRICE_CHANGED') {
        key.current = newKey();
        setQuote(await api.customer.quote(input).catch(() => null));
      } else if (problem.code === 'NO_AVAILABILITY' || problem.code === 'OUTSIDE_OPERATING_HOURS') {
        setStartAt(null);
        void slots.reload();
      }
    } finally {
      setBusy(false);
    }
  };

  if (!service || !detail.data) {
    return (
      <AppScreen>
        {detail.error ? (
          <Notice kind="error" locale={locale}>
            {describeError(detail.error, locale).message}
          </Notice>
        ) : (
          <Loading locale={locale} />
        )}
      </AppScreen>
    );
  }
  const address = detail.data.address;

  return (
    <AppScreen>
      <Title>{service.name}</Title>
      {service.description ? <Body muted>{service.description}</Body> : null}

      {service.tasks.length > 0 ? (
        <>
          <Heading>{t.tasksTitle}</Heading>
          {service.tasks.map((task) => (
            <Choice
              key={task.id}
              label={task.name}
              selected={tasks?.has(task.id) ?? false}
              onPress={() =>
                setTasks((current) => {
                  const next = new Set(current);
                  if (next.has(task.id)) next.delete(task.id);
                  else next.add(task.id);
                  return next;
                })
              }
            />
          ))}
        </>
      ) : null}

      <Heading>{t.whenTitle}</Heading>
      {service.supportsInstant ? (
        <Choice label={t.asap} selected={startAt === NOW} onPress={() => setStartAt(NOW)} />
      ) : null}
      {service.supportsScheduled ? (
        <>
          <View style={styles.wrap}>
            {Array.from({ length: maxDays }, (_, offset) => (
              <Choice
                key={offset}
                label={dayLabel(offset, locale)}
                selected={day === offset}
                onPress={() => {
                  setDay(offset);
                  if (startAt !== NOW) setStartAt(null);
                }}
              />
            ))}
          </View>
          {slots.loading && !slots.data ? <Loading locale={locale} /> : null}
          {slots.data && slots.data.slots.length === 0 ? <Body muted>{t.noSlots}</Body> : null}
          <View style={styles.wrap}>
            {slots.data?.slots.map((slot) => (
              <Choice
                key={slot}
                label={time(slot, locale)}
                selected={startAt === slot}
                onPress={() => setStartAt(slot)}
                testID={`slot-${slot}`}
              />
            ))}
          </View>
        </>
      ) : null}

      {quote ? (
        <Card>
          <Heading>{t.priceTitle}</Heading>
          <Body muted>{dateTime(quote.startAt, locale)}</Body>
          {quote.lines.map((line) => (
            <Row
              key={`${line.type}-${line.code}`}
              label={line.label}
              value={money(line.amountPaise, locale)}
            />
          ))}
          <Row label={t.total} value={money(quote.totalPaise, locale)} />
        </Card>
      ) : null}

      {address ? (
        <Card>
          <Heading>{t.addressTitle}</Heading>
          <Body>
            {[address.houseNumber, address.building, address.street, address.landmark]
              .filter(Boolean)
              .join(', ')}
          </Body>
          <Body muted>
            {address.cityName} {address.pincode}
          </Body>
        </Card>
      ) : null}

      {notice ? (
        <Notice kind={notice.kind} reference={notice.reference} locale={locale}>
          {notice.text}
        </Notice>
      ) : null}
      <Button
        label={t.bookNow}
        onPress={() => void book()}
        busy={busy}
        disabled={!quote || !address}
        testID="book"
      />
    </AppScreen>
  );
}

function dayLabel(offset: number, locale: 'en' | 'hi'): string {
  const date = new Date(`${indiaDate(offset)}T12:00:00+05:30`);
  return new Intl.DateTimeFormat(locale === 'hi' ? 'hi-IN' : 'en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(date);
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
});
