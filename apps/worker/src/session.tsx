import Constants from 'expo-constants';
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { createApiClient, type ApiClient, type Tokens } from '@onetappe/api-client';
import { secureTokenStore, type Locale } from '@onetappe/mobile-kit';
import { strings } from './strings';

const apiUrl = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ?? '';
const tokens = secureTokenStore('onetappe.worker.session');

interface Session {
  readonly api: ApiClient;
  readonly apiUrl: string;
  readonly locale: Locale;
  readonly t: (typeof strings)['en'];
  setLocale: (locale: Locale) => void;
  signIn: (session: Tokens) => Promise<void>;
  signOut: () => Promise<void>;
  isSignedIn: () => Promise<boolean>;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>('en');
  const value = useMemo<Session>(() => {
    const api = createApiClient({ baseUrl: apiUrl, tokens, headers: { 'x-client': 'worker-app' } });
    return {
      api,
      apiUrl,
      locale,
      t: strings[locale],
      setLocale,
      signIn: async (session) => {
        await tokens.set({ accessToken: session.accessToken, refreshToken: session.refreshToken });
      },
      signOut: async () => {
        try {
          await api.auth.logout();
        } catch {
          // Signing out locally is what matters; the server session expires on its own.
        }
        await tokens.clear();
      },
      isSignedIn: async () => (await tokens.get()) !== null,
    };
  }, [locale]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession outside SessionProvider');
  return session;
}
