import type { ApiClient } from '@onetappe/api-client';

/**
 * Where a signed-in customer goes next: the first thing still missing (current terms,
 * name, a serviceable address), else home. Used after sign-in and after each setup step.
 */
export async function nextStep(
  api: ApiClient,
): Promise<'/terms' | '/profile' | '/location' | '/home'> {
  const consent = await api.legal.status();
  if (!consent.allAccepted) return '/terms';
  const me = await api.customer.me();
  if (!me.profileComplete) return '/profile';
  const addresses = await api.customer.addresses();
  if (!addresses.some((a) => a.serviceable)) return '/location';
  return '/home';
}
