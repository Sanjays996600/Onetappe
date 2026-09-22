import { randomInt } from 'node:crypto';
import { StaffAuthService } from '../../src/auth/staff-auth.service.js';
import { inTransaction } from '../../src/database/transaction.js';
import { totpAt, totpStep } from '../../src/security/totp.js';
import type { ApiClient } from './http.js';
import { SYSTEM, type TestApp } from './world.js';

export interface StaffMember {
  readonly userId: string;
  readonly email: string;
  readonly password: string;
  totpSecret: string | null;
  /** Next unused authenticator code (TOTP steps cannot be reused). */
  nextCode(): string;
}

let counter = 0;

/** Creates a staff account with the given roles (optionally limited to one city). */
export async function createStaff(
  app: TestApp,
  roles: readonly string[],
  options: { cityId?: string | null } = {},
): Promise<StaffMember> {
  counter += 1;
  const email = `staff${Date.now()}${counter}${randomInt(1000)}@onetappe.test`;
  const password = 'correct horse battery staple';
  const user = await inTransaction(app.db, SYSTEM, async (tx) => {
    const row = await tx
      .insertInto('app_user')
      .values({ email, full_name: `Staff ${counter}` })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const role of roles) {
      await tx
        .insertInto('user_role')
        .values({ user_id: row.id, role_code: role, city_id: options.cityId ?? null })
        .execute();
    }
    return row;
  });
  await app.http.get(StaffAuthService).setPassword(user.id, password, SYSTEM);

  let lastStep = 0;
  const member: StaffMember = {
    userId: user.id,
    email,
    password,
    totpSecret: null,
    nextCode() {
      if (!member.totpSecret) throw new Error('Staff member has not enrolled MFA yet');
      // Current step, or the next one if the current step was already used (±1 is accepted).
      const step = Math.max(totpStep(new Date()), lastStep + 1);
      lastStep = step;
      return totpAt(member.totpSecret, step);
    },
  };
  return member;
}

/** Full staff sign-in (enrolling MFA on first use); returns an access token. */
export async function signInStaff(api: ApiClient, staff: StaffMember): Promise<string> {
  const login = await api.post<{ step: string; challengeToken: string; totpSecret?: string }>(
    '/auth/staff/login',
    { email: staff.email, password: staff.password },
  );
  if (login.status !== 200) throw new Error(`Staff login failed: ${JSON.stringify(login.body)}`);
  if (login.body.step === 'MFA_ENROLL') staff.totpSecret = login.body.totpSecret ?? null;
  const mfa = await api.post<{ accessToken: string }>('/auth/staff/mfa', {
    challengeToken: login.body.challengeToken,
    code: staff.nextCode(),
  });
  if (mfa.status !== 200) throw new Error(`Staff MFA failed: ${JSON.stringify(mfa.body)}`);
  return mfa.body.accessToken;
}
