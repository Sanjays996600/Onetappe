import type { ReactNode } from 'react';
import type { City, StaffMember } from '@onetappe/api-client';
import { ROLE_LABELS, translator, type Locale } from '@/i18n/dictionaries';
import { Notice } from '@/components/Notice';
import { can } from '@/lib/permissions';
import { call } from '@/server/api';
import { readFlash } from '@/server/flash';
import { getMe } from '@/server/me';
import { requestLocale } from '@/server/locale';
import { inviteStaff, staffChange } from './actions';

type Search = Promise<{ notice?: string; error?: string; message?: string }>;
const ROLES = Object.keys(ROLE_LABELS.en);

export default async function StaffPage({ searchParams }: { searchParams: Search }) {
  const me = await getMe();
  const locale = await requestLocale();
  const t = translator(locale);
  if (!can(me, 'user.manage')) return <Notice kind="warning">{t('noPermission')}</Notice>;
  const q = await searchParams;
  const [staff, cities, flash] = await Promise.all([
    call((api) => api.admin.staff.list(), '/staff'),
    can(me, 'service_area.manage')
      ? call((api) => api.admin.config.cities(), '/staff')
      : Promise.resolve([] as City[]),
    readFlash(),
  ]);
  const cityName = (id: string | null) =>
    id === null ? t('allCities') : (cities.find((c) => c.id === id)?.name ?? id);

  return (
    <>
      <h1>{t('staff')}</h1>
      {q.notice === 'saved' && <Notice kind="ok">{t('changeSaved')}</Notice>}
      {q.notice === 'invited' && flash?.['link'] && (
        <Notice kind="ok">
          {t('invitationLink')}
          <div>
            <code data-testid="invitation-link">{flash['link']}</code>
          </div>
        </Notice>
      )}
      {q.error && (
        <Notice kind="error">
          {t('changeFailed')}: {q.message ?? q.error} ({q.error})
        </Notice>
      )}

      <details className="action">
        <summary>{t('inviteStaff')}</summary>
        <form action={inviteStaff} className="stack">
          <label>
            {t('email')}
            <input name="email" type="email" required />
          </label>
          <label>
            {t('fullName')}
            <input name="fullName" required minLength={2} />
          </label>
          <RoleFields cities={cities} locale={locale} />
          <label>
            {t('reason')}
            <textarea name="reason" required minLength={5} rows={2} />
          </label>
          <button type="submit">{t('invite')}</button>
        </form>
      </details>

      <table>
        <thead>
          <tr>
            <th scope="col">{t('fullName')}</th>
            <th scope="col">{t('roles')}</th>
            <th scope="col">{t('status')}</th>
            <th scope="col">{t('mfaEnrolled')}</th>
            <th scope="col">{t('actions')}</th>
          </tr>
        </thead>
        <tbody>
          {staff.map((member) => (
            <tr key={member.id}>
              <td>
                {member.fullName}
                <div className="muted">{member.email}</div>
              </td>
              <td>
                {member.roles.map((r) => (
                  <div key={r.role + (r.cityId ?? '')}>
                    {ROLE_LABELS[locale][r.role] ?? r.role} · {cityName(r.cityId)}
                  </div>
                ))}
              </td>
              <td>{member.status === 'ACTIVE' ? t('active') : t('suspended')}</td>
              <td>{member.mfaEnrolled ? t('enrolled') : t('notEnrolled')}</td>
              <td>
                {member.id !== me.id && (
                  <MemberActions member={member} cities={cities} locale={locale} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function RoleFields({ cities, locale }: { cities: City[]; locale: Locale }) {
  const t = translator(locale);
  return (
    <>
      <label>
        {t('role')}
        <select name="role" required>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[locale][r]}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t('city')}
        <select name="cityId">
          <option value="">{t('allCities')}</option>
          {cities.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

function MemberActions({
  member,
  cities,
  locale,
}: {
  member: StaffMember;
  cities: City[];
  locale: Locale;
}) {
  const t = translator(locale);
  const change = (kind: string, label: string, extra?: ReactNode) => (
    <details className="action" key={label}>
      <summary>{label}</summary>
      <form action={staffChange} className="stack">
        <input type="hidden" name="userId" value={member.id} />
        <input type="hidden" name="kind" value={kind} />
        {extra}
        <label>
          {t('reason')}
          <textarea name="reason" required minLength={5} rows={2} />
        </label>
        <button type="submit">{label}</button>
      </form>
    </details>
  );
  return (
    <>
      {change('grant', t('grantRole'), <RoleFields cities={cities} locale={locale} />)}
      {member.roles.map((r) =>
        change(
          `revoke`,
          `${t('revokeRole')}: ${ROLE_LABELS[locale][r.role] ?? r.role}`,
          <>
            <input type="hidden" name="role" value={r.role} />
            <input type="hidden" name="cityId" value={r.cityId ?? ''} />
          </>,
        ),
      )}
      {member.status === 'ACTIVE'
        ? change('suspend', t('suspend'))
        : change('reactivate', t('reactivate'))}
      {change('resetMfa', t('resetMfa'))}
      {change('reinvite', t('newInvitation'))}
    </>
  );
}
