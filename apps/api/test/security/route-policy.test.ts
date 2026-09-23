import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../support/world.js';
import { routePolicies, type RoutePolicy } from './route-policy.js';

/**
 * The access policy of every route, read from the running application. A new route fails
 * here until its policy is deliberate: public routes and the few routes a suspended worker
 * may use are explicit lists, reviewed like code.
 */

/** No access token. Each one protects itself (signature, secret, one-time token, or data it returns is public). */
const PUBLIC_ROUTES = [
  'POST /api/v1/auth/refresh', // refresh token (rotated, reuse revokes the session)
  'POST /api/v1/auth/staff/invitation/accept', // one-time invitation token
  'POST /api/v1/auth/staff/login', // password, then an authenticator code
  'POST /api/v1/auth/staff/mfa', // short-lived challenge token + authenticator code
  'POST /api/v1/customer/auth/otp', // rate-limited per phone and network
  'POST /api/v1/customer/auth/verify', // one-time code, 5 attempts
  'POST /api/v1/worker/auth/otp',
  'POST /api/v1/worker/auth/verify',
  'GET /api/v1/health/live', // no data
  'GET /api/v1/health/ready', // no data
  'GET /api/v1/metrics', // bearer METRICS_TOKEN outside local/test
  'GET /api/v1/legal/documents', // published documents
  'POST /api/v1/integrations/zoho-desk/webhook', // shared-secret signature
  'POST /api/v1/payments/webhooks/:provider', // gateway signature
  'POST /api/v1/sandbox/payments/:orderId', // 404 unless the sandbox gateway (never production)
  'PUT /api/v1/uploads', // signed, expiring upload token; local storage only
];

/** Worker routes a suspended or not-yet-approved worker may still use (the guard blocks all others). */
const INACTIVE_WORKER_ROUTES = [
  'POST /api/v1/auth/logout',
  'POST /api/v1/auth/logout-all',
  'GET /api/v1/me/consents',
  'POST /api/v1/me/consents/:purpose',
  'POST /api/v1/me/consents/accept',
  'GET /api/v1/worker/me',
  'PATCH /api/v1/worker/me',
  'POST /api/v1/worker/devices',
  'GET /api/v1/worker/me/verifications',
  'POST /api/v1/worker/me/verifications',
  'POST /api/v1/worker/me/documents',
  'GET /api/v1/worker/me/training',
  'GET /api/v1/worker/earnings',
  'POST /api/v1/worker/support-cases',
  'POST /api/v1/worker/sos',
];

/** Staff routes every signed-in staff member may call (their own identity and sign-out). */
const STAFF_WITHOUT_PERMISSION = ['GET /api/v1/admin/me', 'POST /api/v1/auth/staff/step-up'];

let app: TestApp;
let routes: RoutePolicy[];
const key = (r: RoutePolicy) => `${r.method} ${r.path}`;

beforeAll(async () => {
  app = await createTestApp();
  routes = routePolicies(app.http);
});

afterAll(async () => {
  await app.close();
});

describe('every route has a deliberate access policy', () => {
  it('finds the whole API', () => {
    expect(routes.length).toBeGreaterThan(150);
  });

  it('public routes are exactly the reviewed list', () => {
    expect(
      routes
        .filter((r) => r.isPublic)
        .map(key)
        .sort(),
    ).toEqual([...PUBLIC_ROUTES].sort());
  });

  it('every other route names the app(s) whose tokens it accepts', () => {
    const open = routes
      .filter((r) => !r.isPublic && r.apps.length === 0)
      .map(key)
      .filter((k) => !['POST /api/v1/auth/logout', 'POST /api/v1/auth/logout-all'].includes(k));
    expect(open).toEqual([]);
  });

  it('staff routes require a permission, and never accept phone-app tokens', () => {
    const staff = routes.filter(
      (r) => r.path.startsWith('/api/v1/admin/') || r.apps.includes('ADMIN_WEB'),
    );
    for (const r of staff) {
      expect({ route: key(r), apps: r.apps }).toEqual({ route: key(r), apps: ['ADMIN_WEB'] });
      if (!STAFF_WITHOUT_PERMISSION.includes(key(r)))
        expect({ route: key(r), permissions: r.permissions.length > 0 }).toEqual({
          route: key(r),
          permissions: true,
        });
    }
  });

  it('customer and worker routes are separate', () => {
    for (const r of routes.filter((x) => x.path.startsWith('/api/v1/customer/') && !x.isPublic))
      expect({ route: key(r), apps: r.apps }).toEqual({ route: key(r), apps: ['CUSTOMER_APP'] });
    for (const r of routes.filter((x) => x.path.startsWith('/api/v1/worker/') && !x.isPublic))
      expect({ route: key(r), apps: r.apps }).toEqual({ route: key(r), apps: ['WORKER_APP'] });
  });

  it('money, people and platform changes need a fresh authenticator check', () => {
    const needsMfa = [
      'POST /api/v1/admin/refunds/:id/approve',
      'POST /api/v1/admin/bookings/:id/start-override',
      'POST /api/v1/admin/bookings/:id/confirm-without-prepayment',
      'POST /api/v1/admin/staff',
      'POST /api/v1/admin/staff/:id/roles',
      'POST /api/v1/admin/staff/:id/status',
      'POST /api/v1/admin/staff/:id/reset-mfa',
      'PUT /api/v1/admin/settings/:key',
      'POST /api/v1/admin/config/price-rules',
      'POST /api/v1/admin/config/payout-rules',
      'POST /api/v1/admin/safety/on-call',
      'POST /api/v1/admin/customers/:id/sessions/revoke',
      'POST /api/v1/admin/workers/:id/sessions/revoke',
    ];
    for (const route of needsMfa)
      expect({ route, mfa: routes.find((r) => key(r) === route)?.recentMfaMinutes }).toEqual({
        route,
        mfa: 10,
      });
  });

  it('only the reviewed routes stay open to suspended or unapproved workers', () => {
    expect(
      routes
        .filter((r) => r.allowsInactiveWorker)
        .map(key)
        .sort(),
    ).toEqual([...INACTIVE_WORKER_ROUTES].sort());
  });
});
