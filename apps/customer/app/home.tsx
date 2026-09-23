import { useRouter } from 'expo-router';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import {
  Body,
  Button,
  Card,
  describeError,
  Heading,
  Loading,
  money,
  Notice,
  space,
  Title,
  useLoad,
} from '@onetappe/mobile-kit';
import { useSession } from '../src/session';
import { AppScreen } from '../src/ui';

/** C-07 / C-08: services offered at the customer's address, in their language. */
export default function Home() {
  const router = useRouter();
  const { api, locale, setLocale, signOut, signOutEverywhere, t } = useSession();
  const home = useLoad(async () => {
    const addresses = await api.customer.addresses();
    const address =
      addresses.find((a) => a.isDefault && a.serviceable) ?? addresses.find((a) => a.serviceable);
    if (!address) return { address: null, catalog: null };
    const catalog = await api.customer.catalog({
      pincode: address.pincode,
      lat: address.lat,
      lng: address.lng,
      locale,
    });
    return { address, catalog };
  }, [locale]);

  const address = home.data?.address;
  const categories = home.data?.catalog?.categories ?? [];

  return (
    <AppScreen>
      <Title>{t.homeTitle}</Title>
      {address ? (
        <Body muted>
          📍 {address.houseNumber}, {address.street ?? address.cityName} — {address.pincode}
        </Body>
      ) : null}
      {home.error ? (
        <Notice kind="error" locale={locale}>
          {describeError(home.error, locale).message}
        </Notice>
      ) : null}
      {home.loading && !home.data ? <Loading locale={locale} /> : null}
      {home.data && !address ? (
        <Button label={t.addAddress} onPress={() => router.push('/location')} />
      ) : null}
      {home.data && address && categories.length === 0 ? <Body>{t.notServed}</Body> : null}
      {categories.map((category) => (
        <View key={category.id} style={styles.group}>
          <Heading>{category.name}</Heading>
          {category.services.map((service) => (
            <Pressable
              key={service.id}
              accessibilityRole="button"
              accessibilityLabel={service.name}
              onPress={() =>
                router.push({
                  pathname: '/service/[id]',
                  params: { id: service.id, addressId: address?.id ?? '' },
                })
              }
            >
              <Card>
                <Heading>{service.name}</Heading>
                {service.description ? <Body muted>{service.description}</Body> : null}
                <Body>
                  {String(service.durationMinutes)} {t.minutes}
                  {service.fromPricePaise !== null
                    ? ` · ${t.from} ${money(service.fromPricePaise, locale)}`
                    : ''}
                </Body>
              </Card>
            </Pressable>
          ))}
        </View>
      ))}
      <Button kind="secondary" label={t.myBookings} onPress={() => router.push('/bookings')} />
      <Button kind="secondary" label={t.help} onPress={() => router.push('/support')} />
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

const styles = StyleSheet.create({ group: { gap: space.sm } });
