import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Body, Button, describeError, Field, Notice, Title, useLoad } from '@onetappe/mobile-kit';
import { MapPin } from '../src/location/MapPin';
import { newKey } from '../src/key';
import { nextStep } from '../src/next-step';
import { useSession } from '../src/session';
import { AppScreen } from '../src/ui';

interface Point {
  lat: number;
  lng: number;
}

/**
 * C-04 / C-05 / C-06: find the customer's location, check we serve it, and save the
 * address. Serviceability is decided by the server from the configured areas.
 */
export default function LocationScreen() {
  const router = useRouter();
  const { api, locale, t } = useSession();
  const me = useLoad(() => api.customer.me(), []);
  const [point, setPoint] = useState<Point | null>(null);
  const [form, setForm] = useState({
    houseNumber: '',
    building: '',
    street: '',
    landmark: '',
    pincode: '',
    cityName: '',
    accessNotes: '',
  });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    kind: 'ok' | 'error' | 'warning';
    text: string;
    reference?: string | null;
  } | null>(null);
  // One key per address being saved: a retry after a lost response does not add it twice.
  const key = useRef(newKey());

  const set = (field: keyof typeof form) => (value: string) =>
    setForm((f) => ({ ...f, [field]: value }));

  const locate = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) {
        setNotice({ kind: 'warning', text: t.locationDenied });
        return;
      }
      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      const found = { lat: position.coords.latitude, lng: position.coords.longitude };
      setPoint(found);
      setNotice({ kind: 'ok', text: t.locationFound });
      try {
        const [place] = await Location.reverseGeocodeAsync({
          latitude: found.lat,
          longitude: found.lng,
        });
        if (place)
          setForm((f) => ({
            ...f,
            pincode: f.pincode || (place.postalCode ?? ''),
            cityName: f.cityName || (place.city ?? place.subregion ?? ''),
            street: f.street || (place.street ?? place.district ?? ''),
          }));
      } catch {
        // Reverse geocoding is a convenience (not available everywhere); the person types.
      }
    } catch {
      setNotice({ kind: 'warning', text: t.locationDenied });
    } finally {
      setBusy(false);
    }
  };

  /** Without GPS: centre the pin on the pincode, and the person moves it to their door. */
  const findPincode = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const [hit] = await Location.geocodeAsync(`${form.pincode}, India`);
      if (hit) setPoint({ lat: hit.latitude, lng: hit.longitude });
      else setNotice({ kind: 'warning', text: t.pincodeNotFound });
    } catch {
      setNotice({ kind: 'warning', text: t.pincodeNotFound });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!point || !me.data) return;
    setBusy(true);
    setNotice(null);
    try {
      const check = await api.customer.serviceability({
        pincode: form.pincode,
        lat: point.lat,
        lng: point.lng,
      });
      if (!check.serviceable) {
        setNotice({ kind: 'warning', text: t.notServed });
        return;
      }
      await api.customer.addAddress(
        {
          label: 'Home',
          contactName: me.data.fullName ?? '',
          contactPhone: me.data.phone,
          houseNumber: form.houseNumber.trim(),
          building: form.building.trim() || null,
          street: form.street.trim() || null,
          landmark: form.landmark.trim() || null,
          pincode: form.pincode.trim(),
          cityName: form.cityName.trim(),
          lat: point.lat,
          lng: point.lng,
          accessNotes: form.accessNotes.trim() || null,
        },
        key.current,
      );
      key.current = newKey();
      router.replace(await nextStep(api));
    } catch (error) {
      const problem = describeError(error, locale, { AREA_NOT_SERVICEABLE: t.notServed });
      setNotice({ kind: 'error', text: problem.message, reference: problem.reference });
    } finally {
      setBusy(false);
    }
  };

  const complete =
    point !== null &&
    /^\d{6}$/.test(form.pincode.trim()) &&
    form.houseNumber.trim().length > 0 &&
    form.cityName.trim().length > 1;

  return (
    <AppScreen>
      <Title>{t.locationTitle}</Title>
      <Body muted>{t.locationIntro}</Body>
      {notice ? (
        <Notice kind={notice.kind} reference={notice.reference ?? null} locale={locale}>
          {notice.text}
        </Notice>
      ) : null}
      <Button label={t.useMyLocation} onPress={() => void locate()} busy={busy} />
      {point ? <MapPin point={point} onChange={setPoint} /> : null}
      <Field
        label={t.pincode}
        value={form.pincode}
        onChangeText={(v) => set('pincode')(v.replace(/\D/g, '').slice(0, 6))}
        keyboardType="number-pad"
        autoComplete="postal-code"
        maxLength={6}
      />
      {!point && /^\d{6}$/.test(form.pincode) ? (
        <Button
          kind="secondary"
          label={t.findPincode}
          onPress={() => void findPincode()}
          busy={busy}
        />
      ) : null}
      <Field
        label={t.houseNumber}
        value={form.houseNumber}
        onChangeText={set('houseNumber')}
        maxLength={60}
      />
      <Field
        label={t.building}
        value={form.building}
        onChangeText={set('building')}
        maxLength={120}
      />
      <Field label={t.street} value={form.street} onChangeText={set('street')} maxLength={120} />
      <Field
        label={t.landmark}
        value={form.landmark}
        onChangeText={set('landmark')}
        maxLength={120}
      />
      <Field label={t.city} value={form.cityName} onChangeText={set('cityName')} maxLength={60} />
      <Field
        label={t.accessNotes}
        value={form.accessNotes}
        onChangeText={set('accessNotes')}
        maxLength={300}
        multiline
      />
      <Button
        label={t.saveAddress}
        onPress={() => void save()}
        busy={busy}
        disabled={!complete || !me.data}
      />
    </AppScreen>
  );
}
