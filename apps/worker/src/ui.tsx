import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Button, EmergencyBar, Screen } from '@onetappe/mobile-kit';
import { useSession } from './session';

/**
 * Every worker screen: content above; the SOS (W-99) and "Emergency? Call 112" always at
 * the bottom, never behind a form. `sos={false}` only before sign-in.
 */
export function AppScreen({ children, sos = true }: { children: ReactNode; sos?: boolean }) {
  const { locale, t } = useSession();
  const router = useRouter();
  return (
    <Screen
      footer={
        <View>
          {sos ? (
            <Button kind="danger" label={t.sos} onPress={() => router.push('/sos')} testID="sos" />
          ) : null}
          <EmergencyBar locale={locale} />
        </View>
      }
    >
      {children}
    </Screen>
  );
}
