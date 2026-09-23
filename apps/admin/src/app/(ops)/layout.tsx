import Link from 'next/link';
import type { ReactNode } from 'react';
import { translator } from '@/i18n/dictionaries';
import { can } from '@/lib/permissions';
import { getMe } from '@/server/me';
import { requestLocale } from '@/server/locale';
import { logout } from '../login/actions';

export default async function OpsLayout({ children }: { children: ReactNode }) {
  const me = await getMe();
  const t = translator(await requestLocale());
  return (
    <>
      <header className="top">
        <strong>{t('appName')}</strong>
        <nav aria-label="Main">
          {can(me, 'booking.read') && <Link href="/">{t('board')}</Link>}
          {can(me, 'booking.read') && <Link href="/bookings">{t('bookings')}</Link>}
          {can(me, 'user.manage') && <Link href="/staff">{t('staff')}</Link>}
          {can(me, 'system.read') && <Link href="/system">{t('system')}</Link>}
        </nav>
        <span className="who">
          {me.fullName ?? me.email} · {me.roles.join(', ')}
        </span>
        <form action={logout}>
          <button type="submit" className="secondary">
            {t('signOut')}
          </button>
        </form>
      </header>
      <main>{children}</main>
    </>
  );
}
