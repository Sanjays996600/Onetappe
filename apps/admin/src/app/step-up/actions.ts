'use server';

import { redirect } from 'next/navigation';
import { ApiError } from '@onetappe/api-client';
import { staffApi } from '@/server/api';
import { text } from '@/lib/form';

export async function stepUp(form: FormData) {
  const rawNext = text(form, 'next') || '/';
  const next = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/';
  const code = text(form, 'code').replace(/\s/g, '');
  let outcome = next;
  try {
    const { api } = await staffApi();
    await api.auth.staff.stepUp({ code });
  } catch (error) {
    if (error instanceof ApiError && error.isSignedOut) outcome = '/login';
    else outcome = `/step-up?next=${encodeURIComponent(next)}&error=MFA_INVALID`;
  }
  redirect(outcome);
}
