import { randomInt } from 'node:crypto';
import { TestOtpSender } from '../../src/auth/otp/otp-sender.js';
import type { ApiClient } from './http.js';
import type { TestApp } from './world.js';

export function randomMobile(): string {
  return `9${randomInt(100_000_000, 999_999_999)}`;
}

export interface PhoneSession {
  readonly phone: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly user: {
    id: string;
    isNew: boolean;
    profileComplete: boolean;
    hasAddress?: boolean;
    workerStatus?: string;
  };
}

/** Signs in through the public OTP endpoints, reading the code from the test SMS outbox. */
export async function signInWithOtp(
  app: TestApp,
  api: ApiClient,
  appKind: 'customer' | 'worker',
  phone = randomMobile(),
): Promise<PhoneSession> {
  const request = await api.post<{ challengeId: string; phone: string }>(`/${appKind}/auth/otp`, {
    phone,
  });
  if (request.status !== 200)
    throw new Error(`OTP request failed: ${JSON.stringify(request.body)}`);
  const code = app.http.get(TestOtpSender).latestCodeFor(request.body.phone);
  if (!code) throw new Error('No OTP was sent');
  const verify = await api.post<Omit<PhoneSession, 'phone'>>(`/${appKind}/auth/verify`, {
    challengeId: request.body.challengeId,
    phone,
    code,
  });
  if (verify.status !== 200) throw new Error(`OTP verify failed: ${JSON.stringify(verify.body)}`);
  return { phone: request.body.phone, ...verify.body };
}
