import Link from 'next/link';
import { translator } from '@/i18n/dictionaries';
import { formatTime } from '@/lib/format';
import { call } from '@/server/api';
import { requestLocale } from '@/server/locale';

export default async function TracePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = translator(await requestLocale());
  const trace = await call((api) => api.admin.bookings.trace(id), `/bookings/${id}/trace`);
  return (
    <>
      <p>
        <Link href={`/bookings/${id}`}>← {trace.booking.bookingCode}</Link>
      </p>
      <h1>{t('trace')}</h1>
      <p className="muted">{t('traceIntro')}</p>
      <table>
        <tbody>
          {trace.entries.map((e, i) => (
            <tr key={i}>
              <td>{formatTime(e.at)}</td>
              <td>{e.area}</td>
              <td>{e.what}</td>
              <td>
                <code>{JSON.stringify(e.detail)}</code>
              </td>
              <td>
                <code>{e.requestId}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
