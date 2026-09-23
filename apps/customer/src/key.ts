import { randomUUID } from 'expo-crypto';

/** A fresh idempotency key (cryptographically random on every platform). */
export const newKey = (): string => randomUUID();
