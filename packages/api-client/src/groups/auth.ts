import type { HttpClient } from '../http.js';
import {
  CustomerSignInSchema,
  OtpChallengeSchema,
  StaffLoginStepSchema,
  WorkerSignInSchema,
} from '../schemas/auth.js';
import { NoContent, TokensSchema } from '../schemas/common.js';

export type Locale = 'en' | 'hi';

/** Sign-in for the three apps. None of these calls sends a token. */
export function authApi(http: HttpClient) {
  const phone = (prefix: 'customer' | 'worker') => ({
    requestOtp: (input: { phone: string; locale?: Locale }) =>
      http.request(OtpChallengeSchema, 'POST', `/${prefix}/auth/otp`, {
        body: input,
        anonymous: true,
      }),
  });
  return {
    customer: {
      ...phone('customer'),
      verifyOtp: (input: { challengeId: string; phone: string; code: string }) =>
        http.request(CustomerSignInSchema, 'POST', '/customer/auth/verify', {
          body: input,
          anonymous: true,
        }),
    },
    worker: {
      ...phone('worker'),
      verifyOtp: (input: { challengeId: string; phone: string; code: string }) =>
        http.request(WorkerSignInSchema, 'POST', '/worker/auth/verify', {
          body: input,
          anonymous: true,
        }),
    },
    staff: {
      login: (input: { email: string; password: string }) =>
        http.request(StaffLoginStepSchema, 'POST', '/auth/staff/login', {
          body: input,
          anonymous: true,
        }),
      completeMfa: (input: { challengeToken: string; code: string }) =>
        http.request(TokensSchema, 'POST', '/auth/staff/mfa', { body: input, anonymous: true }),
      acceptInvitation: (input: { token: string; password: string }) =>
        http.request(NoContent, 'POST', '/auth/staff/invitation/accept', {
          body: input,
          anonymous: true,
        }),
      /** Fresh authenticator check before money and override actions. */
      stepUp: (input: { code: string }) =>
        http.request(NoContent, 'POST', '/auth/staff/step-up', { body: input }),
    },
    logout: () => http.request(NoContent, 'POST', '/auth/logout'),
    /** Lost or stolen phone: ends every session of this account, on every device. */
    logoutAll: () => http.request(NoContent, 'POST', '/auth/logout-all'),
  };
}
