import Link from 'next/link';
import type { BookingRow } from '@onetappe/api-client';
import { translator, type Locale } from '@/i18n/dictionaries';
import { formatTime } from '@/lib/format';
import { StatusBadge } from './StatusBadge';

export function BookingTable({ rows, locale }: { rows: BookingRow[]; locale: Locale }) {
  const t = translator(locale);
  return (
    <table>
      <thead>
        <tr>
          <th scope="col">{t('bookingCode')}</th>
          <th scope="col">{t('status')}</th>
          <th scope="col">{t('service')}</th>
          <th scope="col">{t('locality')}</th>
          <th scope="col">{t('scheduled')}</th>
          <th scope="col">{t('customer')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((b) => (
          <tr key={b.id}>
            <td>
              <Link href={`/bookings/${b.id}`}>{b.bookingCode}</Link>
            </td>
            <td>
              <StatusBadge status={b.status} locale={locale} />
            </td>
            <td>{b.service}</td>
            <td>
              {b.locality} {b.pincode}
            </td>
            <td>
              {formatTime(b.scheduledStart)}
              {b.scheduledStart !== b.originalStart && (
                <div className="muted">
                  {t('originally')}: {formatTime(b.originalStart)}
                </div>
              )}
            </td>
            <td>
              {b.customer.name} {b.customer.phone}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
