import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobRunner } from '../src/jobs/job-runner.service.js';
import { ApiClient } from './support/http.js';
import { randomMobile, signInWithOtp } from './support/phone-auth.js';
import { FaultyTcpProxy } from './support/tcp-proxy.js';
import { createTestApp, type TestApp } from './support/world.js';

type ErrorBody = { error: { code: string } };

let proxy: FaultyTcpProxy;
let app: TestApp;
let api: ApiClient;

beforeAll(async () => {
  const started = await FaultyTcpProxy.start(process.env['DATABASE_URL']!);
  proxy = started.proxy;
  // The application reaches PostgreSQL only through the proxy.
  app = await createTestApp({
    DATABASE_URL: started.url,
    DATABASE_CONNECTION_TIMEOUT_MS: '1000',
  });
  api = new ApiClient(app.http);
});

afterAll(async () => {
  proxy.restore();
  await app.close();
  await proxy.close();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('database outages', () => {
  it('answers 503 while the database is down and recovers by itself afterwards', async () => {
    expect((await api.get('/health/ready')).status).toBe(200);

    proxy.cut();
    const ready = await api.get<ErrorBody>('/health/ready');
    expect(ready.status).toBe(503);
    const otp = await api.post<ErrorBody>('/customer/auth/otp', { phone: randomMobile() });
    expect(otp.status).toBe(503);
    expect(otp.body.error.code).toBe('TEMPORARILY_UNAVAILABLE');
    expect(otp.headers['retry-after']).toBe('5');
    // Liveness does not depend on the database: the process itself is healthy.
    expect((await api.get('/health/live')).status).toBe(200);

    proxy.restore();
    expect((await api.get('/health/ready')).status).toBe(200);
    const session = await signInWithOtp(app, api, 'customer');
    expect(session.accessToken).toBeTruthy();
  });

  it('survives the database dropping idle connections (restart or failover)', async () => {
    await signInWithOtp(app, api, 'customer'); // leaves idle connections in the pool
    proxy.dropAll();
    await sleep(50);
    // Broken idle connections are discarded; the next request opens fresh ones.
    const session = await signInWithOtp(app, api, 'customer');
    expect(session.accessToken).toBeTruthy();
  });

  it('does not hang when the database stops answering (network partition)', async () => {
    proxy.dropAll();
    proxy.blackhole();
    const started = Date.now();
    const res = await api.get<ErrorBody>('/health/ready');
    expect(res.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(5_000);
    proxy.restore();
    expect((await api.get('/health/ready')).status).toBe(200);
  });

  it('keeps the background worker running through an outage', async () => {
    const runner = app.http.get(JobRunner);
    proxy.cut();
    await expect(runner.runOnce('dispatch-notifications')).rejects.toBeDefined();
    // Scheduled runs during the outage are logged and retried, never crash the process
    // (an unhandled rejection would fail this test run).
    runner.start();
    await sleep(1_500);
    proxy.restore();
    await sleep(50);
    const result = await runner.runOnce('release-expired-holds');
    expect(result.job).toBe('release-expired-holds');
  });
});
