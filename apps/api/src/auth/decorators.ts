import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { ActionContext } from '../database/action-context.js';
import { ForbiddenError } from '../common/errors.js';
import { roleLabel, sourceForApp, type ClientApp, type Principal } from './principal.js';
import type { AuthenticatedRequest } from './auth.guard.js';

export const IS_PUBLIC = 'auth:public';
export const CLIENT_APPS_KEY = 'auth:apps';
export const PERMISSIONS_KEY = 'auth:permissions';
export const RECENT_MFA_KEY = 'auth:recent-mfa';
export const INACTIVE_WORKER_KEY = 'auth:inactive-worker';

/** The route needs no access token (OTP request, webhooks, health). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Only tokens issued to these apps may call the route. */
export const ForApp = (...apps: ClientApp[]) => SetMetadata(CLIENT_APPS_KEY, apps);

/**
 * Worker routes are for working (active or restricted) workers only. This marks the few a
 * suspended, not-yet-approved or departed worker may still use: their own status and
 * onboarding, their earnings, support, SOS and consents — never offers, jobs or anything
 * about customers.
 */
export const AllowInactiveWorker = () => SetMetadata(INACTIVE_WORKER_KEY, true);

/** The staff member needs every listed permission. */
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/** Sensitive action: the staff member must have confirmed their authenticator recently. */
export const RequireRecentMfa = (maxAgeMinutes = 10) => SetMetadata(RECENT_MFA_KEY, maxAgeMinutes);

export const CurrentPrincipal = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): Principal => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.principal) throw new ForbiddenError('NOT_AUTHENTICATED', 'Sign in required');
    return request.principal;
  },
);

/** The action context (actor, role, channel, request id) for services and the database. */
export const Actor = createParamDecorator((_: unknown, ctx: ExecutionContext): ActionContext => {
  const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  const principal = request.principal;
  if (!principal) throw new ForbiddenError('NOT_AUTHENTICATED', 'Sign in required');
  return {
    actorUserId: principal.userId,
    actorRole: roleLabel(principal),
    source: sourceForApp(principal.app),
    requestId: request.requestId,
  };
});

export const RequestMeta = createParamDecorator(
  (
    _: unknown,
    ctx: ExecutionContext,
  ): { requestId: string; ip: string | null; userAgent: string | null } => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest & { clientIp?: string }>();
    const agent = request.headers['user-agent'];
    return {
      requestId: request.requestId,
      ip: request.clientIp || request.ip || null,
      userAgent: typeof agent === 'string' ? agent : null,
    };
  },
);
