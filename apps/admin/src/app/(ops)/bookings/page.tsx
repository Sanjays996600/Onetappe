import { BOOKING_STATUSES, type BookingStatus } from '@onetappe/domain';
import { translator, STATUS_LABELS } from '@/i18n/dictionaries';
import { Notice } from '@/components/Notice';
import { can } from '@/lib/permissions';
import { istLocalToIso } from '@/lib/format';
import { call } from '@/server/api';
import { getMe } from '@/server/me';
import { requestLocale } from '@/server/locale';
import { BookingTable } from '@/components/BookingTable';

type Search = Promise<{ code?: string; status?: string; from?: string; to?: string }>;

export default async function BookingsPage({ searchParams }: { searchParams: Search }) {
  const me = await getMe();
  const locale = await requestLocale();
  const t = translator(locale);
  if (!can(me, 'booking.read')) return <Notice kind="warning">{t('noPermission')}</Notice>;
  const q = await searchParams;
  const status = (BOOKING_STATUSES as readonly string[]).includes(q.status ?? '')
    ? (q.status as BookingStatus)
    : undefined;
  const code = q.code && /^OT\d{8}$/i.test(q.code.trim()) ? q.code.trim() : undefined;
  const rows = await call(
    (api) =>
      api.admin.bookings.search({
        status,
        code,
        from: q.from ? istLocalToIso(`${q.from}T00:00`) : undefined,
        to: q.to ? istLocalToIso(`${q.to}T23:59`) : undefined,
        limit: 100,
      }),
    '/bookings',
  );
  return (
    <>
      <h1>{t('bookings')}</h1>
      <form className="inline card" role="search">
        <label>
          {t('bookingCode')}
          <input name="code" defaultValue={q.code ?? ''} placeholder="OT00000000" />
        </label>
        <label>
          {t('status')}
          <select name="status" defaultValue={status ?? ''}>
            <option value="">{t('anyStatus')}</option>
            {BOOKING_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[locale][s] ?? s}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('from')}
          <input type="date" name="from" defaultValue={q.from ?? ''} />
        </label>
        <label>
          {t('to')}
          <input type="date" name="to" defaultValue={q.to ?? ''} />
        </label>
        <button type="submit">{t('search')}</button>
      </form>
      <h2 className="muted">{rows.length}</h2>
      {rows.length === 0 ? (
        <p className="muted">{t('noBookings')}</p>
      ) : (
        <BookingTable rows={rows} locale={locale} />
      )}
    </>
  );
}
