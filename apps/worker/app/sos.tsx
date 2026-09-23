import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Linking } from 'react-native';
import {
  Body,
  Button,
  commonStrings,
  describeError,
  Notice,
  Title,
  useLoad,
} from '@onetappe/mobile-kit';
import { newKey } from '../src/key';
import { useSession } from '../src/session';
import { AppScreen } from '../src/ui';

/**
 * W-99: opens a critical safety incident, linked to the current job, with the location
 * when the phone has it. One key per SOS: pressing again after lost signal does not open
 * a second incident.
 */
export default function Sos() {
  const router = useRouter();
  const { api, locale, t } = useSession();
  const current = useLoad(() => api.worker.currentJob().catch(() => null), []);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ReturnType<typeof describeError> | null>(null);
  const key = useRef(newKey());

  const send = async () => {
    setBusy(true);
    setProblem(null);
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
        // Location helps the team; it is never a reason to delay an SOS.
      }
      await api.worker.sos({ bookingId: current.data?.bookingId ?? null, lat, lng }, key.current);
      setSent(true);
    } catch (error) {
      setProblem(describeError(error, locale));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppScreen sos={false}>
      <Title>{t.sosTitle}</Title>
      {sent ? <Notice kind="ok">{t.sosSent}</Notice> : <Body>{t.sosIntro}</Body>}
      {problem ? (
        <Notice kind="error" reference={problem.reference} locale={locale}>
          {problem.message}
        </Notice>
      ) : null}
      {!sent ? (
        <Button kind="danger" label={t.sosSend} onPress={() => void send()} busy={busy} />
      ) : null}
      <Button
        kind="danger"
        label={commonStrings[locale].emergency}
        onPress={() => void Linking.openURL('tel:112')}
      />
      <Button kind="secondary" label={commonStrings[locale].back} onPress={() => router.back()} />
    </AppScreen>
  );
}
