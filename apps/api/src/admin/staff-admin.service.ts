import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { SessionService } from '../auth/session.service.js';
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../common/errors.js';
import type { ActionContext } from '../database/action-context.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { inTransaction, type Tx } from '../database/transaction.js';
import { randomToken, sha256Hex } from '../security/crypto.js';

/** How long an invitation link can be used. */
export const STAFF_INVITATION_TTL_HOURS = 72;

export interface RoleGrant {
  readonly role: string;
  /** Limits the role to one city; null = every city. */
  readonly cityId: string | null;
}

export interface Invitation {
  /** Shown once to the administrator, who passes it to the person out of band. */
  readonly token: string;
  readonly expiresAt: Date;
}

/** Replaces any open invitation for the person with a new single-use one. */
export async function issueStaffInvitation(
  tx: Tx,
  context: ActionContext,
  userId: string,
): Promise<Invitation> {
  await tx
    .updateTable('staff_invitation')
    .set({ revoked_at: sql<Date>`now()` })
    .where('user_id', '=', userId)
    .where('accepted_at', 'is', null)
    .where('revoked_at', 'is', null)
    .execute();
  const token = randomToken();
  const row = await tx
    .insertInto('staff_invitation')
    .values({
      user_id: userId,
      token_hash: sha256Hex(token),
      expires_at: sql<Date>`now() + make_interval(hours => ${STAFF_INVITATION_TTL_HOURS})`,
      created_by: context.actorUserId,
    })
    .returning('expires_at')
    .executeTakeFirstOrThrow();
  return { token, expiresAt: row.expires_at };
}

/**
 * Staff accounts and their access. Every change needs user.manage, a recent
 * authenticator check and a reason (enforced by the controller); every row change is
 * audited by the database. Nobody can change their own access, and the last super
 * administrator cannot be removed.
 */
@Injectable()
export class StaffAdminService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly sessions: SessionService,
  ) {}

  async list() {
    const staff = await this.db
      .selectFrom('app_user as u')
      .leftJoin('staff_credential as c', 'c.user_id', 'u.id')
      .select(['u.id', 'u.email', 'u.full_name', 'u.status', 'c.mfa_enrolled_at'])
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('user_role as r')
            .innerJoin('role', 'role.code', 'r.role_code')
            .select('r.id')
            .whereRef('r.user_id', '=', 'u.id')
            .where('role.is_staff', '=', true),
        ),
      )
      .orderBy('u.email')
      .execute();
    const roles = await this.activeRoles(staff.map((s) => s.id));
    return staff.map((s) => ({
      id: s.id,
      email: s.email,
      fullName: s.full_name,
      status: s.status,
      mfaEnrolled: s.mfa_enrolled_at !== null,
      roles: roles.get(s.id) ?? [],
    }));
  }

  async create(
    context: ActionContext,
    input: { email: string; fullName: string; grants: readonly RoleGrant[] },
  ): Promise<{ userId: string; invitation: Invitation }> {
    return inTransaction(this.db, context, async (tx) => {
      const taken = await tx
        .selectFrom('app_user')
        .select('id')
        .where(sql<boolean>`email = ${input.email}::citext`)
        .executeTakeFirst();
      if (taken) throw new ConflictError('STAFF_EMAIL_TAKEN', 'An account already uses this email');
      const user = await tx
        .insertInto('app_user')
        .values({ email: input.email, full_name: input.fullName })
        .returning('id')
        .executeTakeFirstOrThrow();
      for (const grant of input.grants) await this.insertGrant(tx, context, user.id, grant);
      return { userId: user.id, invitation: await issueStaffInvitation(tx, context, user.id) };
    });
  }

  async grant(context: ActionContext, userId: string, grant: RoleGrant): Promise<void> {
    this.assertNotSelf(context, userId);
    await inTransaction(this.db, context, async (tx) => {
      await this.lockStaff(tx, userId);
      await this.insertGrant(tx, context, userId, grant);
    });
  }

  async revoke(context: ActionContext, userId: string, grant: RoleGrant): Promise<void> {
    this.assertNotSelf(context, userId);
    await inTransaction(this.db, context, async (tx) => {
      await this.lockStaff(tx, userId);
      const row = await tx
        .selectFrom('user_role')
        .select('id')
        .where('user_id', '=', userId)
        .where('role_code', '=', grant.role)
        .where((eb) =>
          grant.cityId === null ? eb('city_id', 'is', null) : eb('city_id', '=', grant.cityId),
        )
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (!row) throw new NotFoundError('Role grant', `${grant.role}@${grant.cityId ?? 'all'}`);
      if (grant.role === 'SUPER_ADMIN') await this.assertAnotherSuperAdmin(tx, userId);
      await tx
        .updateTable('user_role')
        .set({ revoked_at: sql<Date>`now()`, revoked_by: context.actorUserId })
        .where('id', '=', row.id)
        .execute();
    });
  }

  /** Suspends (signs out everywhere) or reactivates a staff account. */
  async setStatus(
    context: ActionContext,
    userId: string,
    status: 'ACTIVE' | 'SUSPENDED',
  ): Promise<void> {
    this.assertNotSelf(context, userId);
    await inTransaction(this.db, context, async (tx) => {
      await this.lockStaff(tx, userId);
      if (status === 'SUSPENDED') {
        await this.assertAnotherSuperAdmin(tx, userId);
        await this.sessions.revokeAllForUser(tx, userId, 'ACCOUNT_SUSPENDED');
      }
      await tx.updateTable('app_user').set({ status }).where('id', '=', userId).execute();
    });
  }

  /** Lost phone: the authenticator is removed and must be enrolled again at next sign-in. */
  async resetMfa(context: ActionContext, userId: string): Promise<void> {
    this.assertNotSelf(context, userId);
    await inTransaction(this.db, context, async (tx) => {
      await this.lockStaff(tx, userId);
      await tx
        .updateTable('staff_credential')
        .set({
          totp_secret_encrypted: null,
          totp_pending_secret_encrypted: null,
          totp_last_used_step: null,
          mfa_enrolled_at: null,
        })
        .where('user_id', '=', userId)
        .execute();
      await this.sessions.revokeAllForUser(tx, userId, 'MFA_RESET');
    });
  }

  /** A fresh invitation (replacing any open one); also how a forgotten password is reset. */
  async reinvite(context: ActionContext, userId: string): Promise<Invitation> {
    this.assertNotSelf(context, userId);
    return inTransaction(this.db, context, async (tx) => {
      await this.lockStaff(tx, userId);
      return issueStaffInvitation(tx, context, userId);
    });
  }

  private async insertGrant(
    tx: Tx,
    context: ActionContext,
    userId: string,
    grant: RoleGrant,
  ): Promise<void> {
    const role = await tx
      .selectFrom('role')
      .select('is_staff')
      .where('code', '=', grant.role)
      .executeTakeFirst();
    if (!role?.is_staff)
      throw new ValidationError('ROLE_INVALID', `${grant.role} is not a staff role`);
    if (grant.cityId !== null) {
      const city = await tx
        .selectFrom('city')
        .select('id')
        .where('id', '=', grant.cityId)
        .executeTakeFirst();
      if (!city) throw new NotFoundError('City', grant.cityId);
    }
    const inserted = await tx
      .insertInto('user_role')
      .values({
        user_id: userId,
        role_code: grant.role,
        city_id: grant.cityId,
        granted_by: context.actorUserId,
      })
      .onConflict((oc) => oc.doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!inserted)
      throw new ConflictError('ROLE_ALREADY_GRANTED', `${grant.role} is already granted`);
  }

  /**
   * Locks a staff account row so concurrent changes to one person apply one at a time.
   * Customer and worker accounts are never staff accounts: they cannot be given staff
   * roles or a password here.
   */
  private async lockStaff(tx: Tx, userId: string): Promise<void> {
    const user = await tx
      .selectFrom('app_user as u')
      .select('u.id')
      .where('u.id', '=', userId)
      .where((eb) =>
        eb.or([
          eb.exists(
            eb
              .selectFrom('user_role as r')
              .innerJoin('role', 'role.code', 'r.role_code')
              .select('r.id')
              .whereRef('r.user_id', '=', 'u.id')
              .where('role.is_staff', '=', true),
          ),
          eb.exists(
            eb
              .selectFrom('staff_credential as c')
              .select('c.user_id')
              .whereRef('c.user_id', '=', 'u.id'),
          ),
        ]),
      )
      .where((eb) =>
        eb.not(
          eb.or([
            eb.exists(
              eb
                .selectFrom('customer_profile as cp')
                .select('cp.user_id')
                .whereRef('cp.user_id', '=', 'u.id'),
            ),
            eb.exists(
              eb
                .selectFrom('worker_profile as wp')
                .select('wp.user_id')
                .whereRef('wp.user_id', '=', 'u.id'),
            ),
          ]),
        ),
      )
      .forUpdate()
      .executeTakeFirst();
    if (!user) throw new NotFoundError('Staff member', userId);
  }

  /** Someone must always be able to administer staff. Serialized on the role rows. */
  private async assertAnotherSuperAdmin(tx: Tx, exceptUserId: string): Promise<void> {
    const others = await tx
      .selectFrom('user_role as r')
      .innerJoin('app_user as u', 'u.id', 'r.user_id')
      .select('r.id')
      .where('r.role_code', '=', 'SUPER_ADMIN')
      .where('r.revoked_at', 'is', null)
      .where('u.status', '=', 'ACTIVE')
      .where('r.user_id', '<>', exceptUserId)
      .forUpdate()
      .execute();
    if (others.length === 0) {
      throw new BusinessRuleError(
        'LAST_SUPER_ADMIN',
        'This is the only active super administrator; appoint another one first',
      );
    }
  }

  private assertNotSelf(context: ActionContext, userId: string): void {
    if (context.actorUserId === userId) {
      throw new ForbiddenError(
        'SELF_CHANGE_FORBIDDEN',
        'Your own access must be changed by another administrator',
      );
    }
  }

  private async activeRoles(userIds: string[]) {
    const out = new Map<string, Array<{ role: string; cityId: string | null }>>();
    if (userIds.length === 0) return out;
    const rows = await this.db
      .selectFrom('user_role')
      .select(['user_id', 'role_code', 'city_id'])
      .where('user_id', 'in', userIds)
      .where('revoked_at', 'is', null)
      .orderBy('role_code')
      .execute();
    for (const r of rows) {
      const list = out.get(r.user_id) ?? [];
      list.push({ role: r.role_code, cityId: r.city_id });
      out.set(r.user_id, list);
    }
    return out;
  }
}
