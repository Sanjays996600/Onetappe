import { z } from 'zod';
import { IsoDate, TokensSchema, Uuid } from './common.js';

export const OtpChallengeSchema = z.object({
  challengeId: Uuid,
  phone: z.string(),
  expiresAt: IsoDate,
  resendAvailableAt: IsoDate,
});
export type OtpChallenge = z.infer<typeof OtpChallengeSchema>;

export const CustomerSignInSchema = TokensSchema.extend({
  user: z.object({
    id: Uuid,
    isNew: z.boolean(),
    profileComplete: z.boolean(),
    hasAddress: z.boolean(),
  }),
});
export type CustomerSignIn = z.infer<typeof CustomerSignInSchema>;

export const WorkerSignInSchema = TokensSchema.extend({
  user: z.object({
    id: Uuid,
    isNew: z.boolean(),
    profileComplete: z.boolean(),
    workerStatus: z.string().nullable(),
  }),
});
export type WorkerSignIn = z.infer<typeof WorkerSignInSchema>;

export const StaffLoginStepSchema = z.discriminatedUnion('step', [
  z.object({ step: z.literal('MFA_VERIFY'), challengeToken: z.string() }),
  z.object({
    step: z.literal('MFA_ENROLL'),
    challengeToken: z.string(),
    totpSecret: z.string(),
    otpauthUrl: z.string(),
  }),
]);
export type StaffLoginStep = z.infer<typeof StaffLoginStepSchema>;
