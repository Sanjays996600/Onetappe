import 'reflect-metadata';

const url = process.env['TEST_DATABASE_URL'];
if (!url) throw new Error('TEST_DATABASE_URL must be set to run the API tests');

// The application under test always talks to the test database.
process.env['DATABASE_URL'] = url;
process.env['NODE_ENV'] = 'test';
process.env['VERIFICATION_CODE_SECRET'] ??= 'test-secret-0123456789abcdef-0123456789';
