import { translator } from '@/i18n/dictionaries';
import { Notice } from '@/components/Notice';
import { formatTime } from '@/lib/format';
import { can } from '@/lib/permissions';
import { call } from '@/server/api';
import { getMe } from '@/server/me';
import { requestLocale } from '@/server/locale';

export default async function SystemPage() {
  const me = await getMe();
  const t = translator(await requestLocale());
  if (!can(me, 'system.read')) return <Notice kind="warning">{t('noPermission')}</Notice>;
  const status = await call((api) => api.admin.systemStatus(), '/system');
  return (
    <>
      <h1>{t('system')}</h1>
      <h2>{t('systemAlerts')}</h2>
      {status.alerts.length === 0 ? (
        <p className="muted">{t('noAlerts')}</p>
      ) : (
        status.alerts.map((a) => (
          <Notice key={a.code + a.message} kind={a.severity === 'critical' ? 'error' : 'warning'}>
            <strong>{a.severity.toUpperCase()}</strong> {a.message}
          </Notice>
        ))
      )}
      <p>
        {t('database')}: {status.database.ok ? 'OK' : '✗'} ({status.database.latencyMs} ms)
      </p>
      <h2>{t('jobs')}</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Job</th>
            <th scope="col">{t('lastSuccess')}</th>
            <th scope="col">{t('failuresLastHour')}</th>
            <th scope="col">{t('status')}</th>
          </tr>
        </thead>
        <tbody>
          {status.jobs.map((j) => (
            <tr key={j.name}>
              <td>{j.name}</td>
              <td>{j.lastSucceededAt ? formatTime(j.lastSucceededAt) : '—'}</td>
              <td>{j.failuresLastHour}</td>
              <td>{j.stale ? `⚠ ${t('stale')}` : 'OK'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>{t('backlog')}</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Queue</th>
            <th scope="col">{t('status')}</th>
            <th scope="col">{t('waiting')}</th>
            <th scope="col">{t('oldest')}</th>
          </tr>
        </thead>
        <tbody>
          {status.backlog.map((b) => (
            <tr key={b.queue + b.state}>
              <td>{b.queue}</td>
              <td>{b.state}</td>
              <td>{b.count}</td>
              <td>{b.oldestWaitingSeconds ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
