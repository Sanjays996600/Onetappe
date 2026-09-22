import { sql, type Kysely, type Transaction } from 'kysely';
import type { ActionContext } from './action-context.js';
import type { DB } from './db.generated.js';
import { translateDatabaseError } from './database-errors.js';

export type Tx = Transaction<DB>;
/** Anything that can run queries: the pool or an open transaction. */
export type Queryable = Kysely<DB>;

/**
 * Runs `work` in one database transaction with the action context installed as
 * transaction-local settings (read by the triggers in migrations 0001/0007).
 * Database errors are translated into application errors.
 */
export async function inTransaction<T>(
  db: Kysely<DB>,
  context: ActionContext,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  try {
    return await db.transaction().execute(async (tx) => {
      await sql`
        SELECT set_config('app.actor_user_id', ${context.actorUserId ?? ''}, true),
               set_config('app.actor_role', ${context.actorRole ?? ''}, true),
               set_config('app.source', ${context.source}, true),
               set_config('app.request_id', ${context.requestId}, true),
               set_config('app.event', '', true),
               set_config('app.reason', ${context.reason?.trim() ?? ''}, true)
      `.execute(tx);
      return work(tx);
    });
  } catch (error) {
    throw translateDatabaseError(error);
  }
}

/**
 * Sets the booking event and reason for the statements that follow in this transaction.
 * The booking trigger validates the event against the allowed transitions. Pass the
 * context's own reason (or null) to restore it afterwards.
 */
export async function setEvent(
  tx: Tx,
  event: string,
  reason: string | null | undefined,
): Promise<void> {
  await sql`
    SELECT set_config('app.event', ${event}, true),
           set_config('app.reason', ${reason ?? ''}, true)
  `.execute(tx);
}

/**
 * Runs `work` inside a savepoint so a failed attempt (e.g. a reservation that lost a
 * race) can be undone without aborting the whole transaction.
 * Returns the error instead of throwing when the attempt fails.
 */
export async function attempt<T>(
  tx: Tx,
  name: string,
  work: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  const savepoint = sql.id(name);
  await sql`SAVEPOINT ${savepoint}`.execute(tx);
  try {
    const value = await work();
    await sql`RELEASE SAVEPOINT ${savepoint}`.execute(tx);
    return { ok: true, value };
  } catch (error) {
    await sql`ROLLBACK TO SAVEPOINT ${savepoint}`.execute(tx);
    return { ok: false, error };
  }
}

/**
 * Runs `work` as a consequence performed by the system on behalf of the current actor
 * (e.g. unassigning the worker because the customer rescheduled). History rows record
 * source SYSTEM while keeping the actor who caused it.
 */
export async function asSystem<T>(
  tx: Tx,
  context: ActionContext,
  work: (systemContext: ActionContext) => Promise<T>,
): Promise<T> {
  const systemContext: ActionContext = { ...context, source: 'SYSTEM', actorRole: 'SYSTEM' };
  await sql`
    SELECT set_config('app.source', 'SYSTEM', true),
           set_config('app.actor_role', 'SYSTEM', true)
  `.execute(tx);
  try {
    return await work(systemContext);
  } finally {
    await sql`
      SELECT set_config('app.source', ${context.source}, true),
             set_config('app.actor_role', ${context.actorRole ?? ''}, true)
    `.execute(tx);
  }
}
