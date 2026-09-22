import type { ActionSource } from '@onetappe/domain';

export const CLIENT_APPS = ['CUSTOMER_APP', 'WORKER_APP', 'ADMIN_WEB'] as const;
export type ClientApp = (typeof CLIENT_APPS)[number];

/** Permission → the cities it is granted for (`'ALL'` = every city). */
export type PermissionGrants = ReadonlyMap<string, 'ALL' | ReadonlySet<string>>;

/** The authenticated caller, resolved from the access token on every request. */
export interface Principal {
  readonly userId: string;
  readonly sessionId: string;
  readonly app: ClientApp;
  /** Staff roles (empty for customers and workers). */
  readonly roles: readonly string[];
  readonly permissions: PermissionGrants;
  readonly mfaVerifiedAt: Date | null;
}

export function sourceForApp(app: ClientApp): ActionSource {
  return app === 'ADMIN_WEB' ? 'ADMIN' : app;
}

export function roleLabel(principal: Principal): string {
  if (principal.app === 'CUSTOMER_APP') return 'CUSTOMER';
  if (principal.app === 'WORKER_APP') return 'WORKER';
  return principal.roles.join('+') || 'STAFF';
}

export function hasPermission(principal: Principal, permission: string): boolean {
  return principal.permissions.has(permission);
}

/** Cities where `permission` applies; null means all cities. */
export function citiesFor(principal: Principal, permission: string): ReadonlySet<string> | null {
  const grant = principal.permissions.get(permission);
  if (grant === undefined) return new Set();
  return grant === 'ALL' ? null : grant;
}

export function hasPermissionInCity(
  principal: Principal,
  permission: string,
  cityId: string,
): boolean {
  const cities = citiesFor(principal, permission);
  return cities === null || cities.has(cityId);
}
