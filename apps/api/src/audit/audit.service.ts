import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { ActionContext } from '../database/action-context.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import type { Tx } from '../database/transaction.js';

export type AuditAction = 'READ' | 'EXPORT' | 'LOGIN' | 'LOGOUT' | 'ACCESS_DENIED';

export interface AuditEvent {
  readonly action: AuditAction;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly reason?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Application-level audit events. Row changes are audited by database triggers; this
 * records what triggers cannot see: sign-ins, denied access and reads of personal data.
 */
@Injectable()
export class AuditService {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async record(context: ActionContext, event: AuditEvent, tx?: Tx): Promise<void> {
    await (tx ?? this.db)
      .insertInto('audit_log')
      .values({
        actor_user_id: context.actorUserId,
        actor_role: context.actorRole,
        source: context.source,
        request_id: context.requestId,
        action: event.action,
        entity_type: event.entityType,
        entity_id: event.entityId,
        reason: event.reason ?? null,
        metadata: JSON.stringify(event.metadata ?? {}),
      })
      .execute();
  }
}
