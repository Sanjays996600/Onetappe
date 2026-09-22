import { z } from 'zod';

/**
 * Deployment environments. They are kept strictly apart:
 *   local       a developer machine
 *   test        automated tests (database is wiped)
 *   staging     shared pre-production with sandbox gateways
 *   production  real customers and money
 */
export const APP_ENVS = ['local', 'test', 'staging', 'production'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

const secret = (name: string) =>
  z.string().min(32, `${name} must be at least 32 characters of random data`);

const EnvSchema = z
  .object({
    APP_ENV: z.enum(APP_ENVS),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    DATABASE_URL: z.url(),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

    /** Signs access tokens. */
    AUTH_TOKEN_SECRET: secret('AUTH_TOKEN_SECRET'),
    /** Peppers OTP hashes so a database leak does not reveal codes. */
    OTP_HASH_SECRET: secret('OTP_HASH_SECRET'),
    /** Derives booking start/complete codes. */
    VERIFICATION_CODE_SECRET: secret('VERIFICATION_CODE_SECRET'),
    /** 32-byte key, base64, for encrypting TOTP secrets and bank account numbers. */
    DATA_ENCRYPTION_KEY: z
      .string()
      .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded'),

    /** Where OTP codes are sent. `console`/`test` never reach a real phone. */
    OTP_PROVIDER: z.enum(['console', 'test', 'msg91']),
    MSG91_AUTH_KEY: z.string().optional(),
    MSG91_TEMPLATE_ID: z.string().optional(),

    PAYMENT_PROVIDER: z.enum(['sandbox', 'razorpay']),
    SANDBOX_WEBHOOK_SECRET: z.string().optional(),
    RAZORPAY_KEY_ID: z.string().optional(),
    RAZORPAY_KEY_SECRET: z.string().optional(),
    RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

    /** Notification channel providers; `log` records the message without sending it. */
    PUSH_PROVIDER: z.enum(['log']).default('log'),
    SMS_PROVIDER: z.enum(['log']).default('log'),
    WHATSAPP_PROVIDER: z.enum(['log']).default('log'),
    EMAIL_PROVIDER: z.enum(['log']).default('log'),

    /** Comma-separated origins allowed to call the API from browsers (admin panel). */
    CORS_ORIGINS: z.string().default(''),
  })
  .superRefine((env, ctx) => {
    const fail = (message: string): void => {
      ctx.addIssue({ code: 'custom', message });
    };

    if (env.APP_ENV === 'production') {
      if (env.OTP_PROVIDER !== 'msg91') fail('production must use a real OTP provider');
      if (env.PAYMENT_PROVIDER !== 'razorpay') fail('production must use a real payment provider');
      if (env.RAZORPAY_KEY_ID && !env.RAZORPAY_KEY_ID.startsWith('rzp_live_')) {
        fail('production must use live Razorpay keys');
      }
    } else if (env.RAZORPAY_KEY_ID?.startsWith('rzp_live_')) {
      // Live money must never move from a non-production environment.
      fail(`${env.APP_ENV} must not use live Razorpay keys`);
    }

    if (env.OTP_PROVIDER === 'test' && env.APP_ENV !== 'test') {
      fail('the test OTP provider is only allowed when APP_ENV=test');
    }
    if (env.OTP_PROVIDER === 'console' && !['local', 'test'].includes(env.APP_ENV)) {
      fail('the console OTP provider is only allowed locally');
    }
    if (env.OTP_PROVIDER === 'msg91' && (!env.MSG91_AUTH_KEY || !env.MSG91_TEMPLATE_ID)) {
      fail('MSG91_AUTH_KEY and MSG91_TEMPLATE_ID are required for the msg91 OTP provider');
    }

    if (env.PAYMENT_PROVIDER === 'sandbox') {
      if (env.APP_ENV === 'production')
        fail('the sandbox payment provider is not allowed in production');
      if (!env.SANDBOX_WEBHOOK_SECRET || env.SANDBOX_WEBHOOK_SECRET.length < 32) {
        fail(
          'SANDBOX_WEBHOOK_SECRET (32+ characters) is required for the sandbox payment provider',
        );
      }
    }
    if (
      env.PAYMENT_PROVIDER === 'razorpay' &&
      (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET || !env.RAZORPAY_WEBHOOK_SECRET)
    ) {
      fail('RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET are required');
    }

    const secrets = [
      env.AUTH_TOKEN_SECRET,
      env.OTP_HASH_SECRET,
      env.VERIFICATION_CODE_SECRET,
      env.DATA_ENCRYPTION_KEY,
    ];
    if (new Set(secrets).size !== secrets.length) fail('each secret must be different');
  });

export type Env = z.infer<typeof EnvSchema>;

/** Parses and validates the environment once at start-up; fails fast on bad config. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function isNonProduction(env: Env): boolean {
  return env.APP_ENV !== 'production';
}
