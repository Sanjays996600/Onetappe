import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import { ForbiddenError } from '../common/errors.js';
import type { ActionContext } from '../database/action-context.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { inTransaction, type Tx } from '../database/transaction.js';
import { randomToken } from '../security/crypto.js';
import { OtpService, type OtpClientApp } from './otp/otp.service.js';
import { SessionService, type IssuedTokens, type SessionMeta } from './session.service.js';
import { IntegrationOutbox } from '../integrations/integration-outbox.service.js';

export interface AppSignIn {
  readonly tokens: IssuedTokens;
  readonly userId: string;
  /** First sign-in with this phone number for this app. */
  readonly isNew: boolean;
  /** Name captured; the app shows the profile step when false. */
  readonly profileComplete: boolean;
  /** Customers: at least one saved address (else show location → address). */
  readonly hasAddress: boolean | null;
  /** Workers: operational status; signing in never implies permission to work. */
  readonly workerStatus: string | null;
}

/**
 * Phone-OTP sign-in for the customer and worker apps. No passwords. One phone number is
 * one identity: concurrent first sign-ins resolve to the same user.
 */
@Injectable()
export class AppAuthService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly otp: OtpService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly outbox: IntegrationOutbox,
  ) {}

  async signIn(
    app: OtpClientApp,
    challengeId: string,
    phoneE164: string,
    code: string,
    meta: SessionMeta,
  ): Promise<AppSignIn> {
    await this.otp.verify(challengeId, phoneE164, app, code, meta.requestId);

    const context: ActionContext = {
      actorUserId: null,
      actorRole: app === 'CUSTOMER_APP' ? 'CUSTOMER' : 'WORKER',
      source: app,
      requestId: meta.requestId,
    };

    return inTransaction(this.db, context, async (tx) => {
      const user = await this.findOrCreateUser(tx, phoneE164);
      if (user.status !== 'ACTIVE') {
        throw new ForbiddenError(
          'ACCOUNT_DISABLED',
          'This account is not active. Please contact support.',
        );
      }

      let isNew: boolean;
      let hasAddress: boolean | null = null;
      let workerStatus: string | null = null;
      if (app === 'CUSTOMER_APP') {
        const created = await tx
          .insertInto('customer_profile')
          .values({ user_id: user.id })
          .onConflict((oc) => oc.column('user_id').doNothing())
          .returning('user_id')
          .executeTakeFirst();
        isNew = created !== undefined;
        if (isNew) {
          await this.outbox.enqueue(tx, 'CRM_CUSTOMER_SYNC', user.id, {
            requestId: context.requestId,
          });
        }
        const address = await tx
          .selectFrom('address')
          .select('id')
          .where('user_id', '=', user.id)
          .where('archived_at', 'is', null)
          .limit(1)
          .executeTakeFirst();
        hasAddress = address !== undefined;
      } else {
        const existing = await tx
          .selectFrom('worker_profile')
          .select('status')
          .where('user_id', '=', user.id)
          .executeTakeFirst();
        isNew = existing === undefined;
        workerStatus = existing?.status ?? (await this.registerWorker(tx, user.id));
      }

      const tokens = await this.sessions.create(tx, user.id, app, meta);
      await this.audit.record(
        { ...context, actorUserId: user.id },
        { action: 'LOGIN', entityType: 'app_user', entityId: user.id, metadata: { app, isNew } },
        tx,
      );
      return {
        tokens,
        userId: user.id,
        isNew,
        profileComplete: Boolean(user.full_name),
        hasAddress,
        workerStatus,
      };
    });
  }

  private async findOrCreateUser(tx: Tx, phoneE164: string) {
    await tx
      .insertInto('app_user')
      .values({ phone_e164: phoneE164, phone_verified_at: new Date() })
      .onConflict((oc) => oc.column('phone_e164').doNothing())
      .execute();
    const user = await tx
      .selectFrom('app_user')
      .select(['id', 'status', 'full_name', 'phone_verified_at'])
      .where('phone_e164', '=', phoneE164)
      .executeTakeFirstOrThrow();
    if (!user.phone_verified_at) {
      await tx
        .updateTable('app_user')
        .set({ phone_verified_at: new Date() })
        .where('id', '=', user.id)
        .execute();
    }
    return user;
  }

  private async registerWorker(tx: Tx, userId: string): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = `W${randomToken(8)
        .replace(/[^A-Za-z0-9]/g, '')
        .toUpperCase()
        .slice(0, 8)}`;
      if (!/^W[0-9A-Z]{4,12}$/.test(code)) continue;
      const row = await tx
        .insertInto('worker_profile')
        .values({ user_id: userId, worker_code: code })
        .onConflict((oc) => oc.doNothing())
        .returning('status')
        .executeTakeFirst();
      if (row) return row.status;
      const existing = await tx
        .selectFrom('worker_profile')
        .select('status')
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if (existing) return existing.status;
    }
    throw new Error('Could not allocate a unique worker code');
  }
}
