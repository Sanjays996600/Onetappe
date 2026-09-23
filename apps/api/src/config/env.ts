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

/** "true"/"false" environment flag (anything else is a configuration error). */
const booleanFlag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const EnvSchema = z
  .object({
    APP_ENV: z.enum(APP_ENVS),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    DATABASE_URL: z.url(),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(5_000),
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(15_000),

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

    /**
     * Zoho (CRM and Desk). Off unless enabled. Endpoints default to the India data centre;
     * the refresh token and client secret come from the secret manager only.
     */
    ZOHO_CRM_ENABLED: booleanFlag,
    ZOHO_DESK_ENABLED: booleanFlag,
    ZOHO_ACCOUNTS_URL: z.url().default('https://accounts.zoho.in'),
    ZOHO_CRM_API_URL: z.url().default('https://www.zohoapis.in/crm/v8'),
    ZOHO_DESK_API_URL: z.url().default('https://desk.zoho.in/api/v1'),
    ZOHO_CLIENT_ID: z.string().optional(),
    ZOHO_CLIENT_SECRET: z.string().optional(),
    ZOHO_REFRESH_TOKEN: z.string().optional(),
    ZOHO_DESK_ORG_ID: z.string().optional(),
    /** Shared secret Zoho Desk must present when calling our webhook. */
    ZOHO_DESK_WEBHOOK_SECRET: z.string().optional(),
    ZOHO_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),

    /**
     * Notification channel providers. `log` records without delivering (local/test only);
     * `none` means the channel is not offered (messages are recorded as SKIPPED).
     */
    PUSH_PROVIDER: z.enum(['log', 'none', 'fcm']).default('log'),
    SMS_PROVIDER: z.enum(['log', 'none', 'msg91']).default('log'),
    WHATSAPP_PROVIDER: z.enum(['log', 'none']).default('log'),
    EMAIL_PROVIDER: z.enum(['log', 'none', 'zeptomail']).default('log'),
    NOTIFICATION_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(10_000),
    FCM_PROJECT_ID: z.string().optional(),
    FCM_CLIENT_EMAIL: z.string().optional(),
    /** Service-account private key (PEM; `\n` escapes are accepted). */
    FCM_PRIVATE_KEY: z.string().optional(),
    FCM_API_URL: z.url().default('https://fcm.googleapis.com'),
    GOOGLE_OAUTH_TOKEN_URL: z.url().default('https://oauth2.googleapis.com/token'),
    MSG91_API_URL: z.url().default('https://control.msg91.com'),
    ZEPTOMAIL_API_URL: z.url().default('https://api.zeptomail.in/v1.1/email'),
    ZEPTOMAIL_TOKEN: z.string().optional(),
    EMAIL_FROM_ADDRESS: z.email().optional(),
    EMAIL_FROM_NAME: z.string().default('One Tappe'),

    /** Worker documents. `local` = encrypted files on this server (not for production). */
    STORAGE_PROVIDER: z.enum(['local']).default('local'),
    STORAGE_DIR: z.string().default('.storage'),
    /** Public base URL of this API, used to build upload links for the local storage provider. */
    PUBLIC_API_URL: z.url().default('http://localhost:3000'),

    LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
    /** Bearer token Prometheus must present to read /metrics (required outside local/test). */
    METRICS_TOKEN: z.string().optional(),
    /** Port of the background worker's metrics/health endpoint. */
    WORKER_METRICS_PORT: z.coerce.number().int().min(1).max(65_535).default(9464),

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

    if (env.APP_ENV === 'production') {
      // Only the local provider exists today; production needs managed object storage
      // (e.g. S3 with presigned uploads) behind the DocumentStorage interface first.
      fail(
        `production needs managed object storage for worker documents (STORAGE_PROVIDER=${env.STORAGE_PROVIDER} is local only)`,
      );
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

    const channelProviders = {
      PUSH_PROVIDER: env.PUSH_PROVIDER,
      SMS_PROVIDER: env.SMS_PROVIDER,
      WHATSAPP_PROVIDER: env.WHATSAPP_PROVIDER,
      EMAIL_PROVIDER: env.EMAIL_PROVIDER,
    };
    if (!['local', 'test'].includes(env.APP_ENV)) {
      // `log` would mark messages as sent without delivering them.
      for (const [name, provider] of Object.entries(channelProviders)) {
        if (provider === 'log')
          fail(`${name}=log is only allowed locally (use a provider or none)`);
      }
    }
    if (
      env.PUSH_PROVIDER === 'fcm' &&
      (!env.FCM_PROJECT_ID || !env.FCM_CLIENT_EMAIL || !env.FCM_PRIVATE_KEY)
    ) {
      fail(
        'FCM_PROJECT_ID, FCM_CLIENT_EMAIL and FCM_PRIVATE_KEY are required for PUSH_PROVIDER=fcm',
      );
    }
    if (env.SMS_PROVIDER === 'msg91' && !env.MSG91_AUTH_KEY) {
      fail('MSG91_AUTH_KEY is required for SMS_PROVIDER=msg91');
    }
    if (env.EMAIL_PROVIDER === 'zeptomail' && (!env.ZEPTOMAIL_TOKEN || !env.EMAIL_FROM_ADDRESS)) {
      fail('ZEPTOMAIL_TOKEN and EMAIL_FROM_ADDRESS are required for EMAIL_PROVIDER=zeptomail');
    }

    const zohoEnabled = env.ZOHO_CRM_ENABLED || env.ZOHO_DESK_ENABLED;
    if (
      zohoEnabled &&
      (!env.ZOHO_CLIENT_ID || !env.ZOHO_CLIENT_SECRET || !env.ZOHO_REFRESH_TOKEN)
    ) {
      fail('ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET and ZOHO_REFRESH_TOKEN are required for Zoho');
    }
    if (env.ZOHO_DESK_ENABLED) {
      if (!env.ZOHO_DESK_ORG_ID) fail('ZOHO_DESK_ORG_ID is required for Zoho Desk');
      if (!env.ZOHO_DESK_WEBHOOK_SECRET || env.ZOHO_DESK_WEBHOOK_SECRET.length < 32) {
        fail('ZOHO_DESK_WEBHOOK_SECRET (32+ characters) is required for Zoho Desk');
      }
    }
    if (!['local', 'test'].includes(env.APP_ENV)) {
      // Every external endpoint uses TLS outside local development and tests.
      const endpoints = {
        ZOHO_ACCOUNTS_URL: env.ZOHO_ACCOUNTS_URL,
        ZOHO_CRM_API_URL: env.ZOHO_CRM_API_URL,
        ZOHO_DESK_API_URL: env.ZOHO_DESK_API_URL,
        FCM_API_URL: env.FCM_API_URL,
        GOOGLE_OAUTH_TOKEN_URL: env.GOOGLE_OAUTH_TOKEN_URL,
        MSG91_API_URL: env.MSG91_API_URL,
        ZEPTOMAIL_API_URL: env.ZEPTOMAIL_API_URL,
      };
      for (const [name, url] of Object.entries(endpoints)) {
        if (!url.startsWith('https://')) fail(`${name} must use HTTPS`);
      }
    }

    if (!['local', 'test'].includes(env.APP_ENV)) {
      if (!env.METRICS_TOKEN || env.METRICS_TOKEN.length < 32) {
        fail('METRICS_TOKEN (32+ characters) is required outside local/test');
      }
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
