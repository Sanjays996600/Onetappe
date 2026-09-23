import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import { Clock } from '../common/clock.js';
import { ForbiddenError, UnauthorizedError } from '../common/errors.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { CLIENT_APPS_KEY, IS_PUBLIC, PERMISSIONS_KEY, RECENT_MFA_KEY } from './decorators.js';
import {
  roleLabel,
  sourceForApp,
  type ClientApp,
  type PermissionGrants,
  type Principal,
} from './principal.js';
import { SessionService } from './session.service.js';
import { RequestContext } from '../observability/request-context.js';

export interface AuthenticatedRequest extends FastifyRequest {
  requestId: string;
  principal?: Principal;
}

/** Staff activity refreshes the idle timer at most once a minute. */
const TOUCH_INTERVAL_MS = 60_000;

/**
 * Global guard. Every route is private unless marked @Public(). A request is allowed
 * only if the token is valid, its session is live in the database, the account is
 * active, the token was issued to an app the route accepts and — for staff — every
 * required permission is granted (and a recent MFA check for sensitive actions).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    @Inject(DATABASE) private readonly db: Kysely<DB>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedError('NOT_AUTHENTICATED', 'Sign in required');
    }
    const claims = await this.sessions.verifyAccess(header.slice('Bearer '.length).trim());

    const session = await this.db
      .selectFrom('auth_session as s')
      .innerJoin('app_user as u', 'u.id', 's.user_id')
      .select([
        's.id',
        's.client_app',
        's.revoked_at',
        's.expires_at',
        's.last_used_at',
        's.mfa_verified_at',
        'u.status as user_status',
      ])
      .where('s.id', '=', claims.sessionId)
      .where('s.user_id', '=', claims.userId)
      .executeTakeFirst();

    const now = this.clock.now();
    if (
      !session ||
      session.revoked_at ||
      session.expires_at <= now ||
      session.client_app !== claims.app
    ) {
      throw new UnauthorizedError('SESSION_EXPIRED', 'Please sign in again');
    }
    if (this.sessions.isIdle(session, now)) {
      throw new UnauthorizedError('SESSION_IDLE', 'Signed out after inactivity');
    }
    if (session.user_status !== 'ACTIVE') {
      throw new ForbiddenError('ACCOUNT_DISABLED', 'This account is not active');
    }

    const principal: Principal = {
      userId: claims.userId,
      sessionId: claims.sessionId,
      app: claims.app,
      ...(claims.app === 'ADMIN_WEB'
        ? await this.loadStaffGrants(claims.userId)
        : { roles: [], permissions: new Map() }),
      mfaVerifiedAt: session.mfa_verified_at,
    };
    request.principal = principal;
    RequestContext.annotate({ actorUserId: principal.userId });

    const apps = this.reflector.getAllAndOverride<ClientApp[] | undefined>(
      CLIENT_APPS_KEY,
      targets,
    );
    if (apps && !apps.includes(principal.app)) {
      throw new ForbiddenError('WRONG_APP', 'This action is not available in this app');
    }

    const required = this.reflector.getAllAndMerge<string[]>(PERMISSIONS_KEY, targets);
    const missing = required.filter((permission) => !principal.permissions.has(permission));
    if (missing.length > 0) {
      await this.audit.record(
        {
          actorUserId: principal.userId,
          actorRole: roleLabel(principal),
          source: sourceForApp(principal.app),
          requestId: request.requestId,
        },
        {
          action: 'ACCESS_DENIED',
          entityType: 'route',
          entityId: `${request.method} ${request.routeOptions.url ?? request.url}`,
          metadata: { missing },
        },
      );
      throw new ForbiddenError('PERMISSION_DENIED', 'You do not have permission for this action', {
        missing,
      });
    }

    const mfaMaxAge = this.reflector.getAllAndOverride<number | undefined>(RECENT_MFA_KEY, targets);
    if (mfaMaxAge !== undefined) {
      const verifiedAt = principal.mfaVerifiedAt?.getTime() ?? 0;
      if (now.getTime() - verifiedAt > mfaMaxAge * 60_000) {
        throw new ForbiddenError(
          'MFA_REQUIRED',
          'Confirm with your authenticator code to continue',
          {
            stepUp: '/api/v1/auth/staff/step-up',
          },
        );
      }
    }

    if (
      principal.app === 'ADMIN_WEB' &&
      now.getTime() - session.last_used_at.getTime() > TOUCH_INTERVAL_MS
    ) {
      await this.db
        .updateTable('auth_session')
        .set({ last_used_at: now })
        .where('id', '=', session.id)
        .execute();
    }
    return true;
  }

  private async loadStaffGrants(
    userId: string,
  ): Promise<{ roles: string[]; permissions: PermissionGrants }> {
    const rows = await this.db
      .selectFrom('user_role as ur')
      .innerJoin('role as r', 'r.code', 'ur.role_code')
      .leftJoin('role_permission as rp', 'rp.role_code', 'ur.role_code')
      .select(['ur.role_code', 'ur.city_id', 'rp.permission_code'])
      .where('ur.user_id', '=', userId)
      .where('ur.revoked_at', 'is', null)
      .where('r.is_staff', '=', true)
      .execute();

    if (rows.length === 0) {
      throw new ForbiddenError('NOT_STAFF', 'This account has no staff role');
    }

    const roles = [...new Set(rows.map((row) => row.role_code))].sort();
    const permissions = new Map<string, 'ALL' | Set<string>>();
    for (const row of rows) {
      if (!row.permission_code) continue;
      const current = permissions.get(row.permission_code);
      if (current === 'ALL') continue;
      if (row.city_id === null) {
        permissions.set(row.permission_code, 'ALL');
      } else {
        const cities = current ?? new Set<string>();
        cities.add(row.city_id);
        permissions.set(row.permission_code, cities);
      }
    }
    return { roles, permissions };
  }
}
