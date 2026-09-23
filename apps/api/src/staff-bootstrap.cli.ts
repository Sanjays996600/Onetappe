/**
 * Creates the first super administrator of a new environment, once.
 *
 *   DATABASE_URL=… node dist/staff-bootstrap.cli.js --email ops.lead@company.in --name "Full Name"
 *
 * Refuses when an active super administrator already exists: from then on accounts are
 * created in the admin panel (audited, with MFA). Prints a single-use invitation token to
 * hand to that person; they choose their own password and enrol their authenticator.
 */
import { parseArgs } from 'node:util';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { issueStaffInvitation } from './admin/staff-admin.service.js';
import type { ActionContext } from './database/action-context.js';
import type { DB } from './database/db.generated.js';
import { inTransaction } from './database/transaction.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { email: { type: 'string' }, name: { type: 'string' } },
  });
  const email = values.email?.trim();
  const name = values.name?.trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !name || name.length < 2) {
    throw new Error('Usage: staff-bootstrap --email <email> --name "<full name>"');
  }
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 1 }) }),
  });
  const context: ActionContext = {
    actorUserId: null,
    actorRole: 'SYSTEM',
    source: 'SYSTEM',
    requestId: `staff-bootstrap:${Date.now()}`,
    reason: 'Initial super administrator (staff-bootstrap)',
  };
  try {
    const invitation = await inTransaction(db, context, async (tx) => {
      // Serialize concurrent bootstraps on the role table.
      await sql`LOCK TABLE user_role IN SHARE ROW EXCLUSIVE MODE`.execute(tx);
      const existing = await tx
        .selectFrom('user_role as r')
        .innerJoin('app_user as u', 'u.id', 'r.user_id')
        .select('r.id')
        .where('r.role_code', '=', 'SUPER_ADMIN')
        .where('r.revoked_at', 'is', null)
        .where('u.status', '=', 'ACTIVE')
        .executeTakeFirst();
      if (existing) {
        throw new Error('A super administrator already exists; create accounts in the admin panel');
      }
      const user = await tx
        .insertInto('app_user')
        .values({ email, full_name: name })
        .returning('id')
        .executeTakeFirstOrThrow();
      await tx
        .insertInto('user_role')
        .values({ user_id: user.id, role_code: 'SUPER_ADMIN', city_id: null })
        .execute();
      return issueStaffInvitation(tx, context, user.id);
    });
    console.log(`Super administrator ${email} created.`);
    console.log(`Invitation token (single use, expires ${invitation.expiresAt.toISOString()}):`);
    console.log(invitation.token);
    console.log('Hand it over in person or through a secure channel; it is not stored in clear.');
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
