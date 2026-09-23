import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestOtpSender } from '../src/auth/otp/otp-sender.js';
import { ApiClient } from './support/http.js';
import { randomMobile, signInWithOtp } from './support/phone-auth.js';
import { createStaff, signInStaff } from './support/staff.js';
import { createTestApp, type TestApp } from './support/world.js';

let app: TestApp;
let api: ApiClient;
let outbox: TestOtpSender;

beforeAll(async () => {
  app = await createTestApp();
  api = new ApiClient(app.http);
  outbox = app.http.get(TestOtpSender);
});

afterAll(async () => {
  await app.close();
});

type Challenge = {
  challengeId: string;
  phone: string;
  expiresAt: string;
  resendAvailableAt: string;
};
type Error = { error: { code: string; details: Record<string, unknown> } };

describe('customer OTP sign-in', () => {
  it('registers a new customer, then recognises the same phone as an existing customer', async () => {
    const phone = randomMobile();
    const first = await signInWithOtp(app, api, 'customer', phone);
    expect(first.user).toMatchObject({ isNew: true, profileComplete: false, hasAddress: false });
    expect(first.accessToken).toBeTruthy();

    await app.db
      .updateTable('otp_challenge')
      .set({ created_at: sql`created_at - interval '1 minute'` })
      .where('phone_e164', '=', `+91${phone}`)
      .execute();
    const second = await signInWithOtp(app, api, 'customer', phone);
    expect(second.user).toMatchObject({ id: first.user.id, isNew: false });
  });

  it('accepts common phone formats and rejects invalid numbers', async () => {
    const digits = randomMobile();
    const ok = await api.post<Challenge>('/customer/auth/otp', {
      phone: `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`,
    });
    expect(ok.body.phone).toBe(`+91${digits}`);
    const bad = await api.post<Error>('/customer/auth/otp', { phone: '12345' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('PHONE_INVALID');
  });

  it('does not reveal whether a phone number already has an account', async () => {
    const existing = await signInWithOtp(app, api, 'customer');
    await app.db
      .updateTable('otp_challenge')
      .set({ created_at: sql`created_at - interval '1 minute'` })
      .where('phone_e164', '=', existing.phone)
      .execute();
    const a = await api.post<Challenge>('/customer/auth/otp', { phone: existing.phone });
    const b = await api.post<Challenge>('/customer/auth/otp', { phone: randomMobile() });
    expect(Object.keys(a.body).sort()).toEqual(Object.keys(b.body).sort());
    expect(a.status).toBe(b.status);
  });

  it('rejects a wrong code, an expired code and a reused code', async () => {
    const phone = randomMobile();
    const request = await api.post<Challenge>('/customer/auth/otp', { phone });
    const code = outbox.latestCodeFor(request.body.phone)!;
    const wrong = code === '000000' ? '111111' : '000000';

    const bad = await api.post<Error>('/customer/auth/verify', {
      challengeId: request.body.challengeId,
      phone,
      code: wrong,
    });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('OTP_INVALID');

    const good = await api.post('/customer/auth/verify', {
      challengeId: request.body.challengeId,
      phone,
      code,
    });
    expect(good.status).toBe(200);
    const reuse = await api.post<Error>('/customer/auth/verify', {
      challengeId: request.body.challengeId,
      phone,
      code,
    });
    expect(reuse.body.error.code).toBe('OTP_INVALID');

    // Expiry.
    await app.db
      .updateTable('otp_challenge')
      .set({ created_at: sql`created_at - interval '1 minute'` })
      .where('phone_e164', '=', request.body.phone)
      .execute();
    const next = await api.post<Challenge>('/customer/auth/otp', { phone });
    await app.db
      .updateTable('otp_challenge')
      .set({ expires_at: sql`now() - interval '1 second'` })
      .where('id', '=', next.body.challengeId)
      .execute();
    const expired = await api.post<Error>('/customer/auth/verify', {
      challengeId: next.body.challengeId,
      phone,
      code: outbox.latestCodeFor(request.body.phone)!,
    });
    expect(expired.body.error.code).toBe('OTP_INVALID');
  });

  it('locks a code after five wrong attempts, even if the right code follows', async () => {
    const phone = randomMobile();
    const request = await api.post<Challenge>('/customer/auth/otp', { phone });
    const code = outbox.latestCodeFor(request.body.phone)!;
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) {
      await api.post('/customer/auth/verify', {
        challengeId: request.body.challengeId,
        phone,
        code: wrong,
      });
    }
    const locked = await api.post<Error>('/customer/auth/verify', {
      challengeId: request.body.challengeId,
      phone,
      code,
    });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('OTP_ATTEMPTS_EXCEEDED');
  });

  it('enforces the resend cooldown and the hourly limit per phone', async () => {
    const phone = randomMobile();
    expect((await api.post('/customer/auth/otp', { phone })).status).toBe(200);
    const tooSoon = await api.post<Error>('/customer/auth/otp', { phone });
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.body.error.code).toBe('OTP_COOLDOWN');
    expect(tooSoon.headers['retry-after']).toBeDefined();

    for (let i = 0; i < 4; i += 1) {
      await app.db
        .updateTable('otp_challenge')
        .set({ created_at: sql`created_at - interval '1 minute'` })
        .where('phone_e164', '=', `+91${phone}`)
        .execute();
      expect((await api.post('/customer/auth/otp', { phone })).status).toBe(200);
    }
    await app.db
      .updateTable('otp_challenge')
      .set({ created_at: sql`created_at - interval '1 minute'` })
      .where('phone_e164', '=', `+91${phone}`)
      .execute();
    const limited = await api.post<Error>('/customer/auth/otp', { phone });
    expect(limited.body.error.code).toBe('OTP_LIMIT');
  });

  it('limits OTP requests from one network', async () => {
    const network = api.fromIp('203.0.113.7');
    for (let i = 0; i < 20; i += 1) {
      expect((await network.post('/customer/auth/otp', { phone: randomMobile() })).status).toBe(
        200,
      );
    }
    const limited = await network.post<Error>('/customer/auth/otp', { phone: randomMobile() });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('OTP_LIMIT');
  });

  it('only the newest code works; older codes are invalidated', async () => {
    const phone = randomMobile();
    const first = await api.post<Challenge>('/customer/auth/otp', { phone });
    const firstCode = outbox.latestCodeFor(first.body.phone)!;
    await app.db
      .updateTable('otp_challenge')
      .set({ created_at: sql`created_at - interval '1 minute'` })
      .where('phone_e164', '=', first.body.phone)
      .execute();
    await api.post<Challenge>('/customer/auth/otp', { phone });
    const old = await api.post<Error>('/customer/auth/verify', {
      challengeId: first.body.challengeId,
      phone,
      code: firstCode,
    });
    expect(old.body.error.code).toBe('OTP_INVALID');
  });

  it('two simultaneous first sign-ins for one phone produce one identity', async () => {
    const phone = randomMobile();
    // Two challenges can only exist if the first is older than the cooldown.
    const a = await api.post<Challenge>('/customer/auth/otp', { phone });
    const codeA = outbox.latestCodeFor(a.body.phone)!;
    await sql`ALTER TABLE otp_challenge DISABLE TRIGGER ALL`.execute(app.db);
    await app.db
      .updateTable('otp_challenge')
      .set({ created_at: sql`created_at - interval '1 minute'` })
      .where('id', '=', a.body.challengeId)
      .execute();
    await sql`ALTER TABLE otp_challenge ENABLE TRIGGER ALL`.execute(app.db);
    const b = await api.post<Challenge>('/worker/auth/otp', { phone });
    const codeB = outbox.latestCodeFor(b.body.phone)!;

    const [customer, worker] = await Promise.all([
      api.post<{ user: { id: string } }>('/customer/auth/verify', {
        challengeId: a.body.challengeId,
        phone,
        code: codeA,
      }),
      api.post<{ user: { id: string } }>('/worker/auth/verify', {
        challengeId: b.body.challengeId,
        phone,
        code: codeB,
      }),
    ]);
    expect(customer.status).toBe(200);
    expect(worker.status).toBe(200);
    expect(customer.body.user.id).toBe(worker.body.user.id);
    const users = await app.db
      .selectFrom('app_user')
      .select('id')
      .where('phone_e164', '=', `+91${phone}`)
      .execute();
    expect(users).toHaveLength(1);
  });

  it('a customer token cannot be used on worker or staff routes', async () => {
    const session = await signInWithOtp(app, api, 'customer');
    const res = await api
      .as(session.accessToken)
      .post<Error>('/auth/staff/step-up', { code: '123456' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('WRONG_APP');
  });
});

describe('sessions', () => {
  it('rotates refresh tokens and revokes the session when an old token is replayed', async () => {
    const session = await signInWithOtp(app, api, 'customer');
    const first = await api.post<{ refreshToken: string; accessToken: string }>('/auth/refresh', {
      refreshToken: session.refreshToken,
    });
    expect(first.status).toBe(200);
    expect(first.body.refreshToken).not.toBe(session.refreshToken);

    // Someone replays the old refresh token: treated as theft.
    const replay = await api.post<Error>('/auth/refresh', { refreshToken: session.refreshToken });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('SESSION_REVOKED');

    // The legitimate holder is signed out too.
    const after = await api.post<Error>('/auth/refresh', { refreshToken: first.body.refreshToken });
    expect(after.status).toBe(401);
    const logout = await api.as(first.body.accessToken).post<Error>('/auth/logout');
    expect(logout.body.error.code).toBe('SESSION_EXPIRED');
  });

  it('logout revokes the access token immediately', async () => {
    const session = await signInWithOtp(app, api, 'customer');
    expect((await api.as(session.accessToken).post('/auth/logout')).status).toBe(204);
    const again = await api.as(session.accessToken).post<Error>('/auth/logout');
    expect(again.status).toBe(401);
  });

  it('rejects missing, malformed and tampered tokens', async () => {
    expect((await api.post('/auth/logout')).status).toBe(401);
    expect((await api.as('not-a-token').post('/auth/logout')).status).toBe(401);
    const session = await signInWithOtp(app, api, 'customer');
    const [header, payload] = session.accessToken.split('.');
    const forged = `${header}.${payload}.${Buffer.from('forged').toString('base64url')}`;
    expect((await api.as(forged).post('/auth/logout')).status).toBe(401);
  });
});

describe('worker sign-in', () => {
  it('signs a new worker in as REGISTERED: authenticated, but not allowed to work', async () => {
    const session = await signInWithOtp(app, api, 'worker');
    expect(session.user).toMatchObject({ isNew: true, workerStatus: 'REGISTERED' });
    const history = await app.db
      .selectFrom('worker_status_history')
      .select(['from_status', 'to_status', 'source'])
      .where('worker_id', '=', session.user.id)
      .execute();
    expect(history).toEqual([{ from_status: null, to_status: 'REGISTERED', source: 'WORKER_APP' }]);
  });
});

describe('staff sign-in', () => {
  it('enrols an authenticator on first sign-in, then requires it every time', async () => {
    const staff = await createStaff(app, ['DISPATCHER']);
    const token = await signInStaff(api, staff);
    expect(token).toBeTruthy();

    const login = await api.post<{ step: string; challengeToken: string }>('/auth/staff/login', {
      email: staff.email,
      password: staff.password,
    });
    expect(login.body.step).toBe('MFA_VERIFY');
    const wrong = await api.post<Error>('/auth/staff/mfa', {
      challengeToken: login.body.challengeToken,
      code: '000000',
    });
    expect(wrong.status).toBe(401);
    const ok = await api.post('/auth/staff/mfa', {
      challengeToken: login.body.challengeToken,
      code: staff.nextCode(),
    });
    expect(ok.status).toBe(200);
  });

  it('refuses to accept the same authenticator code twice', async () => {
    const staff = await createStaff(app, ['DISPATCHER']);
    await signInStaff(api, staff);
    const login = await api.post<{ challengeToken: string }>('/auth/staff/login', {
      email: staff.email,
      password: staff.password,
    });
    const code = staff.nextCode();
    expect(
      (await api.post('/auth/staff/mfa', { challengeToken: login.body.challengeToken, code }))
        .status,
    ).toBe(200);
    const again = await api.post<{ challengeToken: string }>('/auth/staff/login', {
      email: staff.email,
      password: staff.password,
    });
    const replay = await api.post<Error>('/auth/staff/mfa', {
      challengeToken: again.body.challengeToken,
      code,
    });
    expect(replay.body.error.code).toBe('MFA_INVALID');
  });

  it('locks the account after five wrong passwords and gives the same answer for unknown emails', async () => {
    const staff = await createStaff(app, ['FINANCE']);
    const unknown = await api.post<Error>('/auth/staff/login', {
      email: 'nobody@onetappe.test',
      password: 'whatever it is',
    });
    const wrong = await api.post<Error>('/auth/staff/login', {
      email: staff.email,
      password: 'wrong password!!',
    });
    expect(unknown.body.error.code).toBe('LOGIN_INVALID');
    expect(wrong.body.error.code).toBe('LOGIN_INVALID');
    for (let i = 0; i < 4; i += 1) {
      await api.post('/auth/staff/login', { email: staff.email, password: 'wrong password!!' });
    }
    const locked = await api.post<Error>('/auth/staff/login', {
      email: staff.email,
      password: staff.password,
    });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');

    const denied = await app.db
      .selectFrom('audit_log')
      .select('id')
      .where('action', '=', 'ACCESS_DENIED')
      .where('entity_id', '=', staff.userId)
      .execute();
    expect(denied.length).toBeGreaterThanOrEqual(5);
  });

  it('refuses staff tokens for people without a staff role', async () => {
    const staff = await createStaff(app, []);
    const token = await signInStaff(api, staff);
    const res = await api.as(token).post<Error>('/auth/staff/step-up', { code: staff.nextCode() });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_STAFF');
  });
});

describe('OTP provider failures', () => {
  it('a failed send is reported, the code is withdrawn and the user can ask again at once', async () => {
    const phone = randomMobile();
    outbox.failNextSend();
    const failed = await api.post<Error>('/customer/auth/otp', { phone });
    expect(failed.status).toBe(503);
    expect(failed.body.error.code).toBe('OTP_DELIVERY_FAILED');
    expect(failed.headers['retry-after']).toBe('5');

    const withdrawn = await app.db
      .selectFrom('otp_challenge')
      .select(['delivery_status', 'consumed_at'])
      .where('phone_e164', '=', `+91${phone}`)
      .executeTakeFirstOrThrow();
    expect(withdrawn.delivery_status).toBe('FAILED');
    expect(withdrawn.consumed_at).not.toBeNull();

    // No cooldown after a failure: the retry is accepted immediately and works.
    const retry = await api.post<Challenge>('/customer/auth/otp', { phone });
    expect(retry.status).toBe(200);
    const verified = await api.post<{ accessToken: string }>('/customer/auth/verify', {
      challengeId: retry.body.challengeId,
      phone,
      code: outbox.latestCodeFor(retry.body.phone),
    });
    expect(verified.status).toBe(200);
  });

  it('a timeout withdraws the code even though the SMS may still arrive', async () => {
    const phone = randomMobile();
    outbox.failNextSend(true);
    const failed = await api.post<Error>('/customer/auth/otp', { phone });
    expect(failed.body.error.code).toBe('OTP_DELIVERY_FAILED');
    const challenge = await app.db
      .selectFrom('otp_challenge')
      .select('id')
      .where('phone_e164', '=', `+91${phone}`)
      .executeTakeFirstOrThrow();
    // Whatever code might have reached the phone is no longer accepted.
    for (const code of ['000000', '123456']) {
      const attempt = await api.post<Error>('/customer/auth/verify', {
        challengeId: challenge.id,
        phone,
        code,
      });
      expect(attempt.body.error.code).toBe('OTP_INVALID');
    }
  });

  it('failed sends still count towards the hourly limit (no free retries for abuse)', async () => {
    const phone = randomMobile();
    for (let i = 0; i < 5; i += 1) {
      outbox.failNextSend();
      const res = await api.post<Error>('/customer/auth/otp', { phone });
      expect(res.body.error.code).toBe('OTP_DELIVERY_FAILED');
    }
    const blocked = await api.post<Error>('/customer/auth/otp', { phone });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('OTP_LIMIT');
  });

  it('two simultaneous requests for one phone send exactly one code', async () => {
    const phone = randomMobile();
    const before = outbox.sentCount(`+91${phone}`);
    const results = await Promise.all([
      api.post<Challenge | Error>('/customer/auth/otp', { phone }),
      api.post<Challenge | Error>('/customer/auth/otp', { phone }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 429]);
    expect(outbox.sentCount(`+91${phone}`) - before).toBe(1);
  });
});
