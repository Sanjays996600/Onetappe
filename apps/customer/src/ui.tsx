import type { ReactNode } from 'react';
import { EmergencyBar, Screen } from '@onetappe/mobile-kit';
import { useSession } from './session';

/** Every customer screen: content above, "Emergency? Call 112" always at the bottom. */
export function AppScreen({ children }: { children: ReactNode }) {
  const { locale } = useSession();
  return <Screen footer={<EmergencyBar locale={locale} />}>{children}</Screen>;
}
