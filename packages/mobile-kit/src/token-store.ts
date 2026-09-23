import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type { TokenStore, Tokens } from '@onetappe/api-client';

/**
 * Tokens live in the Android Keystore / iOS Keychain (expo-secure-store), readable only by
 * this app and only while the device is unlocked. The web build (used for automated tests
 * only, never published) keeps them in memory.
 */
export function secureTokenStore(key: string): TokenStore & { clear(): Promise<void> } {
  let memory: Tokens | null = null;
  const native = Platform.OS === 'android' || Platform.OS === 'ios';
  return {
    async get() {
      if (!native) return memory;
      const raw = await SecureStore.getItemAsync(key);
      return raw ? (JSON.parse(raw) as Tokens) : null;
    },
    async set(tokens) {
      if (!native) {
        memory = tokens;
        return;
      }
      if (tokens === null) await SecureStore.deleteItemAsync(key);
      else
        await SecureStore.setItemAsync(key, JSON.stringify(tokens), {
          keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        });
    },
    async clear() {
      await this.set(null);
    },
  };
}
