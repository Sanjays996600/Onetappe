import { Inject, Injectable } from '@nestjs/common';
import { SignJWT, errors as joseErrors, jwtVerify } from 'jose';
import type { Kysely } from 'kysely';
import { Clock } from '../common/clock.js';
import { UnauthorizedError } from '../common/errors.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { systemContext } from '../database/action-context.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { inTransaction, type Tx } from '../database/transaction.js';
import { randomToken, sha256Hex } from '../security/crypto.js';
import { CLIENT_APPS, type ClientApp } from './principal.js';

/** Session lifetimes per app. Staff sessions are short and expire when idle. */
export const SESSION_POLICY: Record<
  ClientApp,
  { accessTtlSeconds: number; absoluteTtlHours: number; idleTimeoutMinutes: number | null }
> = {
  CUSTOMER_APP: { accessTtlSeconds: 15 * 60, absoluteTtlHours: 90 * 24, idleTimeoutMinutes: null },
  WORKER_APP: { accessTtlSeconds: 15 * 60, absoluteTtlHours: 30 * 24, idleTimeoutMinutes: null },
  ADMIN_WEB: { accessTtlSeconds: 10 * 60, absoluteTtlHours: 12, idleTimeoutMinutes: 30 },
};

const ISSUER = 'onetappe-api';

export interface IssuedTokens {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshToken: string;
  readonly sessionExpiresAt: Date;
}

export interface AccessClaims {
  readonly userId: string;
  readonly sessionId: string;
  readonly app: ClientApp;
}

export interface SessionMeta {
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string;
}

@Injectable()
export class SessionService {
  private readonly key: Uint8Array;

  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    @Inject(ENV) env: Env,
    private readonly clock: Clock,
  ) {
    this.key = new TextEncoder().encode(env.AUTH_TOKEN_SECRET);
  }

  /** Starts a session (after OTP or staff MFA) inside the caller's transaction. */
  async create(
    tx: Tx,
    userId: string,
    app: ClientApp,
    meta: SessionMeta,
    options: { mfaVerified?: boolean } = {},
  ): Promise<IssuedTokens> {
    const now = this.clock.now();
    const policy = SESSION_POLICY[app];
    const refreshToken = randomToken();
    const expiresAt = new Date(now.getTime() + policy.absoluteTtlHours * 3_600_000);

    const session = await tx
      .insertInto('auth_session')
      .values({
        user_id: userId,
        client_app: app,
        refresh_token_hash: sha256Hex(refreshToken),
        created_at: now,
        last_used_at: now,
        expires_at: expiresAt,
        ip: meta.ip,
        user_agent: meta.userAgent?.slice(0, 500) ?? null,
        mfa_verified_at: options.mfaVerified ? now : null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const access = await this.signAccess({ userId, sessionId: session.id, app }, now);
    return { ...access, refreshToken, sessionExpiresAt: expiresAt };
  }

  /**
   * Exchanges a refresh token for new tokens and rotates it. Presenting an already
   * rotated token means it was copied: the whole session is revoked.
   */
  async refresh(refreshToken: string, meta: SessionMeta): Promise<IssuedTokens> {
    const hash = sha256Hex(refreshToken);
    type RefreshOutcome =
      | { error: 'SESSION_REVOKED' | 'REFRESH_TOKEN_INVALID' | 'SESSION_EXPIRED' }
      | { tokens: IssuedTokens };
    const outcome = await inTransaction(
      this.db,
      systemContext(meta.requestId),
      async (tx): Promise<RefreshOutcome> => {
        const now = this.clock.now();
        const session = await tx
          .selectFrom('auth_session')
          .selectAll()
          .where('refresh_token_hash', '=', hash)
          .forUpdate()
          .executeTakeFirst();

        if (!session) {
          const reused = await tx
            .updateTable('auth_session')
            .set({ revoked_at: now, revoke_reason: 'REFRESH_TOKEN_REUSED' })
            .where('previous_refresh_token_hash', '=', hash)
            .where('revoked_at', 'is', null)
            .returning('id')
            .executeTakeFirst();
          return { error: reused ? 'SESSION_REVOKED' : 'REFRESH_TOKEN_INVALID' };
        }
        if (session.revoked_at || session.expires_at <= now || this.isIdle(session, now)) {
          return { error: 'SESSION_EXPIRED' };
        }

        const next = randomToken();
        await tx
          .updateTable('auth_session')
          .set({
            previous_refresh_token_hash: hash,
            refresh_token_hash: sha256Hex(next),
            rotated_at: now,
            last_used_at: now,
            ip: meta.ip,
          })
          .where('id', '=', session.id)
          .execute();

        const app = session.client_app as ClientApp;
        const access = await this.signAccess(
          { userId: session.user_id, sessionId: session.id, app },
          now,
        );
        return { tokens: { ...access, refreshToken: next, sessionExpiresAt: session.expires_at } };
      },
    );

    // Revocation must be committed even though the request fails, so it is reported here.
    if ('error' in outcome) {
      throw new UnauthorizedError(outcome.error, 'Please sign in again');
    }
    return outcome.tokens;
  }

  async revoke(sessionId: string, reason: string, requestId: string): Promise<void> {
    await inTransaction(this.db, systemContext(requestId), (tx) =>
      tx
        .updateTable('auth_session')
        .set({ revoked_at: this.clock.now(), revoke_reason: reason })
        .where('id', '=', sessionId)
        .where('revoked_at', 'is', null)
        .execute(),
    );
  }

  async revokeAllForUser(tx: Tx, userId: string, reason: string): Promise<void> {
    await tx
      .updateTable('auth_session')
      .set({ revoked_at: this.clock.now(), revoke_reason: reason })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .execute();
  }

  /** Verifies an access token's signature and expiry (the session is checked separately). */
  async verifyAccess(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        algorithms: ['HS256'],
        currentDate: this.clock.now(),
      });
      const app = payload['app'];
      if (
        typeof payload.sub !== 'string' ||
        typeof payload['sid'] !== 'string' ||
        typeof app !== 'string' ||
        !(CLIENT_APPS as readonly string[]).includes(app)
      ) {
        throw new UnauthorizedError('TOKEN_INVALID', 'Invalid access token');
      }
      return { userId: payload.sub, sessionId: payload['sid'], app: app as ClientApp };
    } catch (error) {
      if (error instanceof UnauthorizedError) throw error;
      if (error instanceof joseErrors.JWTExpired) {
        throw new UnauthorizedError('TOKEN_EXPIRED', 'Access token expired; refresh it');
      }
      throw new UnauthorizedError('TOKEN_INVALID', 'Invalid access token');
    }
  }

  isIdle(session: { client_app: string; last_used_at: Date }, now: Date): boolean {
    const idle = SESSION_POLICY[session.client_app as ClientApp].idleTimeoutMinutes;
    return idle !== null && now.getTime() - session.last_used_at.getTime() > idle * 60_000;
  }

  private async signAccess(
    claims: AccessClaims,
    now: Date,
  ): Promise<{ accessToken: string; accessTokenExpiresAt: Date }> {
    const ttl = SESSION_POLICY[claims.app].accessTtlSeconds;
    const issuedAt = Math.floor(now.getTime() / 1000);
    const accessToken = await new SignJWT({ sid: claims.sessionId, app: claims.app })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.userId)
      .setIssuer(ISSUER)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ttl)
      .sign(this.key);
    return { accessToken, accessTokenExpiresAt: new Date((issuedAt + ttl) * 1000) };
  }
}
