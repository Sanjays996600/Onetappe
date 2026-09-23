import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import type { PaymentStart } from '@onetappe/api-client';
import {
  Body,
  Button,
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
import { openRazorpay } from '../../src/payments/razorpay';
import { sandboxCheckout } from '../../src/payments/sandbox';
import { useSession } from '../../src/session';
import { AppScreen } from '../../src/ui';

const CHECKS = 10;
const CHECK_EVERY_MS = 3000;

/**
 * C-16: pay for a booking. The gateway's checkout collects the card or UPI details; this
 * screen only learns the outcome from the server, which trusts the gateway's signed webhook
 * or its own query to the gateway — never what the checkout screen reported.
 */
export default function Pay() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api, apiUrl, locale, t } = useSession();
  const loaded = useLoad(
    async () => ({ booking: await api.customer.booking(id), me: await api.customer.me() }),
    [id],
  );
  const [start, setStart] = useState<PaymentStart | null>(null);
  const [phase, setPhase] = useState<'idle' | 'checking' | 'pending'>('idle');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ReturnType<typeof describeError> | null>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const booking = loaded.data?.booking;
  useEffect(() => {
    if (booking && booking.status !== 'PENDING_PAYMENT')
      router.replace({ pathname: '/booking/[id]', params: { id } });
  }, [booking, id, router]);

  const messages = { PAYMENT_GATEWAY_UNAVAILABLE: t.gatewayUnavailable };

  /** Asks the server (which asks the gateway) until the booking is confirmed or we give up. */
  const check = async (paymentId: string) => {
    setPhase('checking');
    setProblem(null);
    for (let i = 0; i < CHECKS && mounted.current; i++) {
      try {
        const result = await api.customer.refreshPayment(id, paymentId);
        if (result.booking.status !== 'PENDING_PAYMENT') {
          router.replace({ pathname: '/booking/[id]', params: { id } });
          return;
        }
        if (result.paymentStatus === 'FAILED') {
          // Nothing was charged; the next attempt starts a fresh gateway order.
          setProblem({ message: t.paymentFailed, reference: null, code: 'PAYMENT_FAILED' });
          setStart(null);
          setPhase('idle');
          return;
        }
      } catch (error) {
        setProblem(describeError(error, locale, messages));
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, CHECK_EVERY_MS));
    }
    if (mounted.current) setPhase('pending');
  };

  const payNow = async () => {
    if (!booking || !loaded.data) return;
    setBusy(true);
    setProblem(null);
    try {
      const started = await api.customer.startPayment(id);
      setStart(started);
      const checkout = started.checkout as Record<string, unknown>;
      if (started.checkout.provider === 'RAZORPAY') {
        await openRazorpay({
          keyId: String(checkout['keyId']),
          orderId: started.checkout.orderId,
          amount: Number(checkout['amount']),
          currency: String(checkout['currency']),
          name: String(checkout['name']),
          description: String(checkout['description']),
          contact: loaded.data.me.phone,
        });
        // Submitted or closed, the server decides what happened.
        await check(started.paymentId);
      }
    } catch (error) {
      setProblem(describeError(error, locale, messages));
    } finally {
      setBusy(false);
    }
  };

  const sandbox = async (outcome: 'capture' | 'fail') => {
    if (!start) return;
    setBusy(true);
    try {
      await sandboxCheckout(apiUrl, start.checkout.orderId, outcome);
      await check(start.paymentId);
    } catch (error) {
      setProblem(describeError(error, locale, messages));
    } finally {
      setBusy(false);
    }
  };

  if (!booking) {
    return (
      <AppScreen>
        {loaded.error ? (
          <Notice kind="error" locale={locale}>
            {describeError(loaded.error, locale).message}
          </Notice>
        ) : (
          <Loading locale={locale} />
        )}
      </AppScreen>
    );
  }

  return (
    <AppScreen>
      <Title>{t.payTitle}</Title>
      <Card>
        <Heading>{booking.service.name}</Heading>
        <Row label={t.bookingCode} value={booking.bookingCode} />
        <Row label={t.scheduled} value={dateTime(booking.schedule.current.start, locale)} />
        {booking.price.lines.map((line) => (
          <Row
            key={`${line.type}-${line.code}`}
            label={line.label}
            value={money(line.amountPaise, locale)}
          />
        ))}
        <Row label={t.total} value={money(booking.price.totalPaise, locale)} />
        {booking.payment.payBy ? (
          <Row label={t.payWithin} value={dateTime(booking.payment.payBy, locale)} />
        ) : null}
      </Card>
      {problem ? (
        <Notice kind="error" reference={problem.reference} locale={locale}>
          {problem.message}
        </Notice>
      ) : null}
      {phase === 'checking' ? (
        <>
          <Body>{t.checkingPayment}</Body>
          <Loading locale={locale} />
        </>
      ) : null}
      {phase === 'pending' ? <Notice kind="warning">{t.paymentPending}</Notice> : null}

      {start?.checkout.provider === 'SANDBOX' && phase === 'idle' ? (
        <Card>
          <Heading>{t.testPaymentTitle}</Heading>
          <Body muted>{t.testPaymentIntro}</Body>
          <Button
            label={t.testPay}
            onPress={() => void sandbox('capture')}
            busy={busy}
            testID="sandbox-pay"
          />
          <Button
            kind="secondary"
            label={t.testFail}
            onPress={() => void sandbox('fail')}
            disabled={busy}
          />
        </Card>
      ) : null}
      {!start ? (
        <Button label={t.payNow} onPress={() => void payNow()} busy={busy} testID="pay-now" />
      ) : null}
      {start && phase === 'pending' ? (
        <Button label={t.iHavePaid} onPress={() => void check(start.paymentId)} />
      ) : null}
      {start && phase === 'pending' && start.checkout.provider === 'RAZORPAY' ? (
        <Button kind="secondary" label={t.payNow} onPress={() => void payNow()} busy={busy} />
      ) : null}
    </AppScreen>
  );
}
