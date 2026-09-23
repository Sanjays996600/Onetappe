'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ApiError } from '@onetappe/api-client';
import { call } from '@/server/api';
import { setFlash } from '@/server/flash';
import { text } from '@/lib/form';

const BACK = '/staff';

/** Where the invited person opens their link: this admin panel's own address. */
async function publicUrl(): Promise<string> {
  const configured = process.env['ADMIN_PUBLIC_URL'];
  if (configured) return configured.replace(/\/$/, '');
  const h = await headers();
  const proto = h.get('x-forwarded-proto') ?? 'http';
  return `${proto}://${h.get('host') ?? 'localhost'}`;
}

function field(form: FormData, name: string): string {
  return text(form, name).trim();
}

const city = (form: FormData) => field(form, 'cityId') || null;

async function run(work: Parameters<typeof call>[0], notice: string) {
  let outcome = `${BACK}?notice=${notice}`;
  try {
    await call(work, BACK);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    outcome = `${BACK}?error=${encodeURIComponent(error.code)}&message=${encodeURIComponent(error.message)}`;
  }
  redirect(outcome);
}

export async function inviteStaff(form: FormData) {
  let outcome = `${BACK}?notice=invited`;
  try {
    const created = await call(
      (api) =>
        api.admin.staff.invite({
          email: field(form, 'email'),
          fullName: field(form, 'fullName'),
          grants: [{ role: field(form, 'role'), cityId: city(form) }],
          reason: field(form, 'reason'),
        }),
      BACK,
    );
    await setFlash({
      link: `${await publicUrl()}/accept-invitation?token=${created.invitation.token}`,
      email: field(form, 'email'),
    });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    outcome = `${BACK}?error=${encodeURIComponent(error.code)}&message=${encodeURIComponent(error.message)}`;
  }
  redirect(outcome);
}

export async function staffChange(form: FormData) {
  const id = field(form, 'userId');
  const reason = field(form, 'reason');
  const kind = field(form, 'kind');
  if (!/^[0-9a-f-]{36}$/i.test(id)) redirect(BACK);
  switch (kind) {
    case 'grant':
      return run(
        (api) =>
          api.admin.staff.grant(id, { role: field(form, 'role'), cityId: city(form), reason }),
        'saved',
      );
    case 'revoke':
      return run(
        (api) =>
          api.admin.staff.revoke(id, { role: field(form, 'role'), cityId: city(form), reason }),
        'saved',
      );
    case 'suspend':
      return run((api) => api.admin.staff.setStatus(id, { status: 'SUSPENDED', reason }), 'saved');
    case 'reactivate':
      return run((api) => api.admin.staff.setStatus(id, { status: 'ACTIVE', reason }), 'saved');
    case 'resetMfa':
      return run((api) => api.admin.staff.resetMfa(id, { reason }), 'saved');
    case 'reinvite': {
      let outcome = `${BACK}?notice=invited`;
      try {
        const invitation = await call((api) => api.admin.staff.reinvite(id, { reason }), BACK);
        await setFlash({
          link: `${await publicUrl()}/accept-invitation?token=${invitation.token}`,
        });
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        outcome = `${BACK}?error=${encodeURIComponent(error.code)}&message=${encodeURIComponent(error.message)}`;
      }
      return redirect(outcome);
    }
    default:
      return redirect(BACK);
  }
}
