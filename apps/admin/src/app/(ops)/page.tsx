import { translator } from '@/i18n/dictionaries';
import { BookingTable } from '@/components/BookingTable';
import { StatusBadge } from '@/components/StatusBadge';
import { Notice } from '@/components/Notice';
import { redirect } from 'next/navigation';
import { can, homeFor } from '@/lib/permissions';
import { call } from '@/server/api';
import { getMe } from '@/server/me';
import { requestLocale } from '@/server/locale';

/** Statuses operations must act on (unpaid, unassigned, paused). */
const ATTENTION = new Set(['PENDING_PAYMENT', 'CONFIRMED', 'ON_HOLD']);

export default async function BoardPage() {
  const me = await getMe();
  const locale = await requestLocale();
  const t = translator(locale);
  if (!can(me, 'booking.read')) {
    const home = homeFor(me);
    if (home) redirect(home);
    return <Notice kind="warning">{t('noAccessAnywhere')}</Notice>;
  }

  const start = new Date();
  start.setUTCHours(-5, -30, 0, 0); // midnight India time (UTC+05:30)
  const end = new Date(start.getTime() + 24 * 3_600_000);
  const [today, status] = await Promise.all([
    call(
      (api) =>
        api.admin.bookings.search({
          from: start.toISOString(),
          to: end.toISOString(),
          limit: 200,
        }),
      '/',
    ),
    can(me, 'system.read') ? call((api) => api.admin.systemStatus(), '/') : Promise.resolve(null),
  ]);
  const counts = new Map<string, number>();
  for (const b of today) counts.set(b.status, (counts.get(b.status) ?? 0) + 1);
  const attention = today.filter((b) => ATTENTION.has(b.status));

  return (
    <>
      <h1>{t('board')}</h1>
      {status && (
        <section aria-labelledby="alerts">
          <h2 id="alerts">{t('systemAlerts')}</h2>
          {status.alerts.length === 0 ? (
            <p className="muted">{t('noAlerts')}</p>
          ) : (
            status.alerts.map((a) => (
              <Notice
                key={a.code + a.message}
                kind={a.severity === 'critical' ? 'error' : 'warning'}
              >
                <strong>{a.severity.toUpperCase()}</strong> {a.message}
              </Notice>
            ))
          )}
        </section>
      )}
      <h2>{t('today')}</h2>
      <div className="counts">
        {[...counts.entries()].map(([s, n]) => (
          <div className="card" key={s}>
            <strong>{n}</strong>
            <StatusBadge status={s} locale={locale} />
          </div>
        ))}
      </div>
      <h2>{t('needsAttention')}</h2>
      {attention.length === 0 ? (
        <p className="muted">{t('nothingNeedsAttention')}</p>
      ) : (
        <BookingTable rows={attention} locale={locale} />
      )}
    </>
  );
}
