import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, type AdminBooking } from '@onetappe/api-client';
import { translator, type Locale } from '@/i18n/dictionaries';
import { Notice } from '@/components/Notice';
import { StatusBadge } from '@/components/StatusBadge';
import { availableActions, type BookingAction } from '@/lib/booking-actions';
import { formatMoney, formatTime, isoToIstLocal } from '@/lib/format';
import { can } from '@/lib/permissions';
import { call } from '@/server/api';
import { getMe } from '@/server/me';
import { requestLocale } from '@/server/locale';
import { bookingAction } from './actions';

type Params = Promise<{ id: string }>;
type Search = Promise<{ notice?: string; error?: string; message?: string; rid?: string }>;

export default async function BookingPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  const { id } = await params;
  const q = await searchParams;
  const me = await getMe();
  const locale = await requestLocale();
  const t = translator(locale);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let booking: AdminBooking;
  try {
    booking = await call((api) => api.admin.bookings.get(id), `/bookings/${id}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
  const actions = availableActions(me, booking);

  return (
    <>
      <p>
        <Link href="/bookings">← {t('back')}</Link>
      </p>
      <h1>
        {booking.bookingCode} <StatusBadge status={booking.status} locale={locale} />
      </h1>
      {q.notice === 'saved' && <Notice kind="ok">{t('changeSaved')}</Notice>}
      {q.notice === 'stale' && <Notice kind="warning">{t('staleBooking')}</Notice>}
      {q.error && (
        <Notice kind="error">
          {t('changeFailed')}: {q.message ?? q.error} ({q.error})
          {q.rid && (
            <>
              {' '}
              · {t('requestId')} <code>{q.rid}</code>
            </>
          )}
        </Notice>
      )}

      <div className="grid2">
        <section className="card" aria-label="Summary">
          <dl>
            <dt className="muted">{t('service')}</dt>
            <dd>{booking.service}</dd>
            <dt className="muted">{t('locality')}</dt>
            <dd>{booking.locality}</dd>
            <dt className="muted">{t('scheduled')}</dt>
            <dd>
              {formatTime(booking.schedule.current.start)}
              {booking.schedule.rescheduleCount > 0 && (
                <div className="muted">
                  {t('originally')}: {formatTime(booking.schedule.original.start)}
                </div>
              )}
            </dd>
            <dt className="muted">{t('customer')}</dt>
            <dd>
              {booking.customer.name} {booking.customer.phone}
            </dd>
            <dt className="muted">{t('total')}</dt>
            <dd>{formatMoney(booking.totalPaise)}</dd>
            <dt className="muted">{t('version')}</dt>
            <dd>{booking.version}</dd>
          </dl>
          <Link href={`/bookings/${booking.id}/trace`}>{t('trace')}</Link>
        </section>

        {actions.length > 0 && (
          <section aria-labelledby="actions">
            <h2 id="actions">{t('actions')}</h2>
            {actions.map((action) => (
              <ActionForm key={action} action={action} booking={booking} locale={locale} />
            ))}
          </section>
        )}
      </div>

      <h2>{t('timeline')}</h2>
      <table>
        <tbody>
          {booking.timeline.map((h, i) => (
            <tr key={i}>
              <td>{formatTime(h.at)}</td>
              <td>
                {h.from ?? '—'} → <strong>{h.to}</strong>
              </td>
              <td>{h.event}</td>
              <td>
                {h.source}
                {h.actor && (
                  <div className="muted">
                    {h.actor.name} ({h.actor.role})
                  </div>
                )}
              </td>
              <td>{h.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>{t('assignments')}</h2>
      {booking.assignments.length === 0 ? (
        <p className="muted">{t('none')}</p>
      ) : (
        <table>
          <tbody>
            {booking.assignments.map((a) => (
              <tr key={a.id}>
                <td>
                  {a.worker.code} {a.worker.name}
                </td>
                <td>{a.status}</td>
                <td>{formatTime(a.offeredAt)}</td>
                <td>{a.responseReason ?? a.endReason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {can(me, 'payment.read', booking.cityId) && (
        <>
          <h2>{t('payments')}</h2>
          {booking.payments.length === 0 ? (
            <p className="muted">{t('none')}</p>
          ) : (
            <table>
              <tbody>
                {booking.payments.map((p) => (
                  <tr key={p.id}>
                    <td>{p.provider}</td>
                    <td>{p.status}</td>
                    <td>{p.amountPaise === undefined ? '' : formatMoney(p.amountPaise)}</td>
                    <td>{p.failureReason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </>
  );
}

function ActionForm({
  action,
  booking,
  locale,
}: {
  action: BookingAction;
  booking: AdminBooking;
  locale: Locale;
}) {
  const t = translator(locale);
  return (
    <details className="action">
      <summary>{t(action)}</summary>
      <form action={bookingAction} className="stack">
        <input type="hidden" name="bookingId" value={booking.id} />
        <input type="hidden" name="action" value={action} />
        <input type="hidden" name="expectedVersion" value={booking.version} />
        {action === 'reschedule' && (
          <label>
            {t('newStart')} (IST)
            <input
              type="datetime-local"
              name="startAt"
              step={900}
              defaultValue={isoToIstLocal(booking.schedule.current.start)}
              required
            />
          </label>
        )}
        {action === 'cancel' && (
          <label>
            {t('fault')}
            <select name="fault" required>
              <option value="CUSTOMER">{t('faultCustomer')}</option>
              <option value="COMPANY">{t('faultCompany')}</option>
              <option value="NO_WORKER">{t('faultNoWorker')}</option>
            </select>
          </label>
        )}
        <label>
          {t('reason')}
          <textarea name="reason" minLength={5} maxLength={500} required rows={2} />
        </label>
        <button type="submit" className={action === 'cancel' ? 'danger' : undefined}>
          {t(action)}
        </button>
      </form>
    </details>
  );
}
