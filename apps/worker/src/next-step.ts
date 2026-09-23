import type { ApiClient } from '@onetappe/api-client';

/** Where a signed-in worker goes next: the current terms first, then home. */
export async function nextStep(api: ApiClient): Promise<'/terms' | '/home'> {
  const consent = await api.legal.status();
  return consent.allAccepted ? '/home' : '/terms';
}
