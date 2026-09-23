import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { deployedSecrets } from './support/deployed-env.js';

/** The published key from .env.example. */
const EXAMPLE_KEY = 'bG9jYWwtb25seS1rZXktMzItYnl0ZXMtbG9uZyEhISE='; // gitleaks:allow

/** A staging environment that is valid apart from whatever a test overrides. */
function staging(overrides: Record<string, string> = {}) {
  return {
    ...process.env,
    ...deployedSecrets(),
    APP_ENV: 'staging',
    OTP_PROVIDER: 'msg91',
    MSG91_AUTH_KEY: 'k',
    MSG91_TEMPLATE_ID: 't',
    PUSH_PROVIDER: 'none',
    SMS_PROVIDER: 'none',
    EMAIL_PROVIDER: 'none',
    WHATSAPP_PROVIDER: 'none',
    STORAGE_PROVIDER: 's3',
    S3_BUCKET: 'onetappe-staging-documents',
    MALWARE_SCANNER: 'clamav',
    ...overrides,
  };
}

describe('deployed environments refuse known or weak secrets', () => {
  it('accepts freshly generated secrets', () => {
    expect(() => loadEnv(staging())).not.toThrow();
  });

  it.each([
    ['AUTH_TOKEN_SECRET', 'local-auth-token-secret-change-me-0123456789'],
    ['OTP_HASH_SECRET', 'test-otp-hash-secret-0123456789-abcdefgh'],
    ['VERIFICATION_CODE_SECRET', 'example-verification-secret-0123456789-xyz'],
    ['METRICS_TOKEN', 'your-metrics-token-goes-here-placeholder-123'],
  ])('refuses a placeholder %s', (name, value) => {
    expect(() => loadEnv(staging({ [name]: value }))).toThrow(
      new RegExp(`${name} looks like a development placeholder`),
    );
  });

  it('refuses the example or a patterned encryption key', () => {
    for (const key of [
      EXAMPLE_KEY,
      Buffer.alloc(32, 1).toString('base64'), // test fixture
    ]) {
      expect(() => loadEnv(staging({ DATA_ENCRYPTION_KEY: key }))).toThrow(/DATA_ENCRYPTION_KEY/);
    }
  });

  it.each([
    ['no TLS', 'postgres://u:p@db.internal:5432/onetappe'],
    ['TLS without certificate checks', 'postgres://u:p@db.internal:5432/onetappe?sslmode=require'],
    ['TLS switched off', 'postgres://u:p@db.internal:5432/onetappe?sslmode=disable'],
  ])('refuses a database connection with %s', (_label, url) => {
    expect(() => loadEnv(staging({ DATABASE_URL: url }))).toThrow(/sslmode=verify-full/);
  });

  it('local development may keep using the example values', () => {
    expect(() =>
      loadEnv({
        ...process.env,
        APP_ENV: 'local',
        AUTH_TOKEN_SECRET: 'local-auth-token-secret-change-me-0123456789',
        DATA_ENCRYPTION_KEY: EXAMPLE_KEY,
        OTP_PROVIDER: 'console',
      }),
    ).not.toThrow();
  });
});
