import { useRouter } from 'expo-router';
import { Pressable } from 'react-native';
import {
  Body,
  Card,
  dateTime,
  describeError,
  Heading,
  Loading,
  money,
  Notice,
  Title,
  useLoad,
} from '@onetappe/mobile-kit';
import { useSession } from '../src/session';
import { STATUS } from '../src/strings';
import { AppScreen } from '../src/ui';

/** The customer's bookings, newest first. */
export default function Bookings() {
  const router = useRouter();
  const { api, locale, t } = useSession();
  const list = useLoad(() => api.customer.bookings({ limit: 30 }), []);
  return (
    <AppScreen>
      <Title>{t.myBookings}</Title>
      {list.error ? (
        <Notice kind="error" locale={locale}>
          {describeError(list.error, locale).message}
        </Notice>
      ) : null}
      {list.loading && !list.data ? <Loading locale={locale} /> : null}
      {list.data?.items.length === 0 ? <Body>{t.noBookings}</Body> : null}
      {list.data?.items.map((b) => (
        <Pressable
          key={b.id}
          accessibilityRole="button"
          accessibilityLabel={`${b.serviceName} ${b.bookingCode}`}
          onPress={() => router.push({ pathname: '/booking/[id]', params: { id: b.id } })}
        >
          <Card>
            <Heading>{b.serviceName}</Heading>
            <Body>{STATUS[locale][b.status] ?? b.status}</Body>
            <Body muted>
              {b.bookingCode} · {dateTime(b.scheduledStart, locale)} · {money(b.totalPaise, locale)}
            </Body>
          </Card>
        </Pressable>
      ))}
    </AppScreen>
  );
}
