import { randomBytes } from 'node:crypto';

/**
 * Freshly generated secrets and a TLS database URL, as a staging or production deployment
 * must have. The test
 * fixtures in env.ts are deliberately refused outside APP_ENV=local/test.
 */
export function deployedSecrets(): Record<string, string> {
  const random = () => randomBytes(32).toString('base64url');
  return {
    AUTH_TOKEN_SECRET: random(),
    OTP_HASH_SECRET: random(),
    VERIFICATION_CODE_SECRET: random(),
    DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    SANDBOX_WEBHOOK_SECRET: random(),
    METRICS_TOKEN: random(),
    // Deployed databases are reached over verified TLS (never connected to by these tests).
    DATABASE_URL: 'postgres://onetappe_api:unused@db.internal:5432/onetappe?sslmode=verify-full',
  };
}
