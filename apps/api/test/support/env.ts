import 'reflect-metadata';

const url = process.env['TEST_DATABASE_URL'];
if (!url) throw new Error('TEST_DATABASE_URL must be set to run the API tests');

// The application connects as the least-privilege runtime role, exactly as in production
// (the login is created by global-setup; migrations and owner-only fixtures use `url`).
const appUrl = new URL(url);
appUrl.username = 'onetappe_app_test';
appUrl.password = 'onetappe_app_test';

// The application under test always talks to the test database with test-only providers.
// These values are fixed test fixtures, not secrets used anywhere else.
Object.assign(process.env, {
  APP_ENV: 'test',
  DATABASE_URL: appUrl.toString(),
  AUTH_TOKEN_SECRET: 'test-auth-token-secret-0123456789-abcdef',
  OTP_HASH_SECRET: 'test-otp-hash-secret-0123456789-abcdefgh',
  VERIFICATION_CODE_SECRET: 'test-verification-secret-0123456789-abcd',
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  OTP_PROVIDER: 'test',
  PAYMENT_PROVIDER: 'sandbox',
  SANDBOX_WEBHOOK_SECRET: 'test-sandbox-webhook-secret-0123456789ab',
  // Suites fire far more requests than a person could; the limits have their own test.
  RATE_LIMIT_PER_SESSION_PER_MINUTE: '1000000',
  RATE_LIMIT_ANONYMOUS_PER_MINUTE: '1000000',
  RATE_LIMIT_SENSITIVE_PER_MINUTE: '1000000',
  // Keep test output readable; the observability test raises the level to capture lines.
  LOG_LEVEL: 'error',
});

process.env['STORAGE_DIR'] ??= `${process.env['TMPDIR'] ?? '/tmp'}/onetappe-test-storage`;
