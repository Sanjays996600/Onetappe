import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { ModulesContainer, Reflector } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  CLIENT_APPS_KEY,
  INACTIVE_WORKER_KEY,
  IS_PUBLIC,
  PERMISSIONS_KEY,
  RECENT_MFA_KEY,
} from '../../src/auth/decorators.js';

/** The access policy of one route, read from the running application. */
export interface RoutePolicy {
  readonly method: string;
  readonly path: string;
  readonly controller: string;
  readonly isPublic: boolean;
  readonly apps: readonly string[];
  readonly permissions: readonly string[];
  readonly recentMfaMinutes: number | null;
  readonly allowsInactiveWorker: boolean;
}

const join = (...parts: (string | undefined)[]) =>
  `/${parts
    .flatMap((p) => (p ?? '').split('/'))
    .filter(Boolean)
    .join('/')}`;

/** Every HTTP route of the application with the decorators the global guard enforces. */
export function routePolicies(app: NestFastifyApplication): RoutePolicy[] {
  const reflector = app.get(Reflector);
  const routes: RoutePolicy[] = [];
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as (new (...args: never[]) => object) | null;
      if (!controller) continue;
      const base = Reflect.getMetadata(PATH_METADATA, controller) as string | undefined;
      const proto = controller.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (path === undefined || method === undefined) continue;
        const targets = [handler, controller];
        routes.push({
          method: RequestMethod[method],
          path: join('api/v1', base, path),
          controller: `${controller.name}.${name}`,
          isPublic: reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, targets) === true,
          apps: reflector.getAllAndOverride<string[] | undefined>(CLIENT_APPS_KEY, targets) ?? [],
          permissions: reflector.getAllAndMerge<string[]>(PERMISSIONS_KEY, targets),
          recentMfaMinutes:
            reflector.getAllAndOverride<number | undefined>(RECENT_MFA_KEY, targets) ?? null,
          allowsInactiveWorker:
            reflector.getAllAndOverride<boolean | undefined>(INACTIVE_WORKER_KEY, targets) === true,
        });
      }
    }
  }
  return routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}
