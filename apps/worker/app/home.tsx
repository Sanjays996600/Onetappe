import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import { Alert } from 'react-native';
import { useEffect, useRef, useState } from 'react';
import type { Offer, WorkerProfile } from '@onetappe/api-client';
import {
  Body,
  Button,
  Card,
  dateTime,
  describeError,
  Field,
  Heading,
  Loading,
  money,
  Notice,
  Row,
  time,
  Title,
  useLoad,
} from '@onetappe/mobile-kit';
import { useSession } from '../src/session';
import { JOB_STATUS } from '../src/strings';
import { AppScreen } from '../src/ui';

const OFFERS_EVERY_MS = 5000;

type Problem = ReturnType<typeof describeError>;

/** W-07 / W-08 / W-09: application status, online switch, offers and the current job. */
export default function Home() {
  const router = useRouter();
  const { api, locale, setLocale, signOut, signOutEverywhere, t } = useSession();
  const me = useLoad(() => api.worker.me(), []);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);

  const online = me.data?.online ?? false;
  const work = useLoad(
    async () => {
      if (!me.data?.canWork) return { job: null, offers: [] as Offer[] };
      const [job, offers] = await Promise.all([
        api.worker.currentJob(),
        online ? api.worker.offers() : Promise.resolve([] as Offer[]),
      ]);
      return { job, offers };
    },
    [me.data?.canWork, online],
    { every: OFFERS_EVERY_MS },
  );

  const switchOnline = async (next: boolean) => {
    setBusy(true);
    setProblem(null);
    try {
      let position: { lat: number; lng: number } | undefined;
      if (next) {
        const permission = await Location.requestForegroundPermissionsAsync();
        if (!permission.granted) {
          setProblem({ message: t.locationNeeded, reference: null, code: 'LOCATION' });
          return;
        }
        const here = await Location.getCurrentPositionAsync({});
        position = { lat: here.coords.latitude, lng: here.coords.longitude };
      }
      await api.worker.setOnline(next, position);
      await me.reload();
    } catch (error) {
      const described = describeError(error, locale);
      if (described.code === 'LEGAL_ACCEPTANCE_REQUIRED') router.replace('/terms');
      else setProblem(described);
    } finally {
      setBusy(false);
    }
  };

  if (!me.data) {
    return (
      <AppScreen>
        {me.error ? (
          <Notice kind="error" locale={locale}>
            {describeError(me.error, locale).message}
          </Notice>
        ) : (
          <Loading locale={locale} />
        )}
      </AppScreen>
    );
  }
  const profile = me.data;
  const job = work.data?.job;

  return (
    <AppScreen>
      <Title>
        {profile.fullName ?? ''} · {profile.workerCode}
      </Title>
      {problem ? (
        <Notice kind="error" reference={problem.reference} locale={locale}>
          {problem.message}
        </Notice>
      ) : null}

      {!profile.canWork ? (
        <Onboarding profile={profile} />
      ) : (
        <>
          <Notice kind={online ? 'ok' : 'warning'}>{online ? t.online : t.offline}</Notice>
          <Button
            kind={online ? 'secondary' : 'primary'}
            label={online ? t.goOffline : t.goOnline}
            onPress={() => void switchOnline(!online)}
            busy={busy}
            testID="presence"
          />
        </>
      )}

      {job ? (
        <Card>
          <Heading>{t.currentJob}</Heading>
          <Body>
            {job.service} · {job.bookingCode}
          </Body>
          <Body muted>
            {JOB_STATUS[locale][job.status] ?? job.status} · {dateTime(job.start, locale)}
          </Body>
          <Button
            label={t.openJob}
            onPress={() => router.push({ pathname: '/job/[id]', params: { id: job.bookingId } })}
          />
        </Card>
      ) : null}

      {profile.canWork && online ? (
        <>
          <Heading>{t.offersTitle}</Heading>
          {work.data && work.data.offers.length === 0 ? <Body muted>{t.noOffers}</Body> : null}
          {work.data?.offers.map((offer) => (
            <OfferCard
              key={offer.offerId}
              offer={offer}
              onAccepted={() =>
                router.push({ pathname: '/job/[id]', params: { id: offer.bookingId } })
              }
              onGone={() => void work.reload()}
              onError={setProblem}
            />
          ))}
        </>
      ) : null}

      <Button kind="secondary" label={t.earnings} onPress={() => router.push('/earnings')} />
      <Button
        kind="secondary"
        label={t.language}
        onPress={() => setLocale(locale === 'en' ? 'hi' : 'en')}
      />
      <Button
        kind="secondary"
        label={t.signOutEverywhere}
        onPress={() =>
          void signOutEverywhere().then(
            () => {
              router.replace('/sign-in');
            },
            (error: unknown) => {
              // The other phones are still signed in: say so, never pretend it worked.
              const problem = describeError(error, locale);
              Alert.alert(t.signOutEverywhere, problem.message);
            },
          )
        }
      />
      <Button
        kind="secondary"
        label={t.signOut}
        onPress={() =>
          void signOut().then(() => {
            router.replace('/sign-in');
          })
        }
      />
    </AppScreen>
  );
}

/** W-07: what is done and what is still needed before the worker can take jobs. */
function Onboarding({ profile }: { profile: WorkerProfile }) {
  const { t } = useSession();
  const o = profile.onboarding;
  const all = (required: string[], done: string[]) => required.every((x) => done.includes(x));
  const steps: [string, 'done' | 'pending' | 'rejected'][] = [
    [t.profileStep, o.profileComplete ? 'done' : 'pending'],
    [t.documentsStep, all(o.documentsRequired, o.documentsSubmitted) ? 'done' : 'pending'],
    [
      t.verificationStep,
      o.verificationsRejected.length > 0
        ? 'rejected'
        : all(o.verificationsRequired, o.verificationsVerified)
          ? 'done'
          : 'pending',
    ],
    [t.trainingStep, all(o.trainingRequired, o.trainingPassed) ? 'done' : 'pending'],
    [t.approvalStep, profile.canWork ? 'done' : 'pending'],
  ];
  const label = { done: `✓ ${t.done}`, pending: `… ${t.pending}`, rejected: `! ${t.rejected}` };
  return (
    <Card>
      <Heading>{profile.status === 'SUSPENDED' ? t.suspended : t.onboardingTitle}</Heading>
      {profile.statusReason ? (
        <Body>{profile.statusReason}</Body>
      ) : (
        <Body muted>{t.onboardingIntro}</Body>
      )}
      {steps.map(([name, state]) => (
        <Row key={name} label={name} value={label[state]} />
      ))}
      <Body muted>{t.onboardingHelp}</Body>
    </Card>
  );
}

/** W-09: limited details (locality, not the address) and a countdown to the offer's expiry. */
function OfferCard({
  offer,
  onAccepted,
  onGone,
  onError,
}: {
  offer: Offer;
  onAccepted: () => void;
  onGone: () => void;
  onError: (p: Problem) => void;
}) {
  const { api, locale, t } = useSession();
  const [now, setNow] = useState(Date.now());
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const left = Math.max(0, Math.floor((Date.parse(offer.expiresAt) - now) / 1000));
  // Once, when the countdown ends: the list reloads without the expired offer.
  const expired = left === 0;
  const onGoneRef = useRef(onGone);
  onGoneRef.current = onGone;
  useEffect(() => {
    if (expired) onGoneRef.current();
  }, [expired]);

  const act = async (action: () => Promise<unknown>, after: () => void) => {
    setBusy(true);
    try {
      await action();
      after();
    } catch (error) {
      const described = describeError(error, locale);
      onError(
        described.code.startsWith('OFFER_') ? { ...described, message: t.offerGone } : described,
      );
      onGone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Heading>{offer.service}</Heading>
      <Body>
        {offer.locality} · {offer.pincode}
      </Body>
      <Row label={dateTime(offer.start, locale)} value={`– ${time(offer.end, locale)}`} />
      <Row label={t.payout} value={money(offer.estimatedPayoutPaise, locale)} />
      <Row
        label={t.expiresIn}
        value={`${String(Math.floor(left / 60))}:${String(left % 60).padStart(2, '0')}`}
      />
      {rejecting ? (
        <>
          <Field label={t.rejectReason} value={reason} onChangeText={setReason} maxLength={500} />
          <Button
            kind="secondary"
            label={t.rejectJob}
            busy={busy}
            disabled={reason.trim().length < 3}
            onPress={() => void act(() => api.worker.reject(offer.offerId, reason.trim()), onGone)}
          />
        </>
      ) : (
        <>
          <Button
            label={t.acceptJob}
            busy={busy}
            disabled={left === 0}
            onPress={() => void act(() => api.worker.accept(offer.offerId), onAccepted)}
            testID={`accept-${offer.bookingId}`}
          />
          <Button kind="secondary" label={t.rejectJob} onPress={() => setRejecting(true)} />
        </>
      )}
    </Card>
  );
}
