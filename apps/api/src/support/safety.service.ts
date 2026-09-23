import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { Clock } from '../common/clock.js';
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../common/errors.js';
import { maskPhone } from '../common/pii.js';
import { systemContext, type ActionContext } from '../database/action-context.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { inTransaction, type Tx } from '../database/transaction.js';
import { keyReusedError, type IdempotentRequest } from '../common/http/idempotency.js';
import { IntegrationOutbox } from '../integrations/integration-outbox.service.js';
import { NotificationService } from '../notifications/notification.service.js';

/** Paging timing, overridable in business_setting['safety.paging']. */
export const SAFETY_PAGING_SETTING = 'safety.paging';
const DEFAULT_PAGING = { secondPageAfterSeconds: 120, thenEverySeconds: 180 };
/** Roster levels: each paging round adds the next level, up to the last. */
const TOP_LEVEL = 3;
const REPORTER_LABEL: Record<string, string> = {
  CUSTOMER: 'customer',
  WORKER: 'worker',
  STAFF: 'staff member',
};

export const SAFETY_CATEGORIES = [
  'SOS',
  'INJURY',
  'MEDICAL',
  'HARASSMENT',
  'VIOLENCE',
  'THEFT_ALLEGATION',
  'PROPERTY_DAMAGE',
  'UNSAFE_PREMISES',
  'OUT_OF_SCOPE_REQUEST',
  'DATA_EXPOSURE',
  'OTHER',
] as const;
export type SafetyCategory = (typeof SAFETY_CATEGORIES)[number];
export type SafetySeverity = 'CRITICAL' | 'HIGH' | 'ROUTINE';

export interface NewIncident {
  readonly bookingId: string | null;
  readonly category: SafetyCategory;
  readonly severity: SafetySeverity;
  readonly summary: string;
  readonly lat: number | null;
  readonly lng: number | null;
  readonly locationText: string | null;
}

/**
 * Safety incidents bypass ordinary queues. An SOS is always CRITICAL. Serious incidents
 * are closed only by someone other than the incident commander (enforced by the database).
 */
@Injectable()
export class SafetyService {
  private readonly logger = new Logger('Safety');

  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly clock: Clock,
    private readonly outbox: IntegrationOutbox,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * Records an incident. A retry with the same idempotency key returns the incident the
   * first request created (a repeated SOS press with a new key opens a new incident).
   */
  async raise(
    context: ActionContext,
    reporterRole: 'CUSTOMER' | 'WORKER' | 'STAFF',
    input: NewIncident,
    idempotency: IdempotentRequest,
  ) {
    const reporter = context.actorUserId;
    if (!reporter) throw new ValidationError('ACTOR_REQUIRED', 'Sign in required');
    const incident = await inTransaction(this.db, context, async (tx) => {
      const earlier = await this.findByKey(tx, reporter, idempotency);
      if (earlier) return earlier;
      if (input.bookingId) {
        const involved = await tx
          .selectFrom('booking as b')
          .leftJoin('booking_assignment as a', (j) =>
            j.onRef('a.booking_id', '=', 'b.id').on('a.worker_id', '=', reporter),
          )
          .select(['b.customer_user_id', 'a.id as assignment_id'])
          .where('b.id', '=', input.bookingId)
          .executeTakeFirst();
        const allowed =
          reporterRole === 'STAFF' ||
          involved?.customer_user_id === reporter ||
          Boolean(involved?.assignment_id);
        if (!involved || !allowed) throw new NotFoundError('Booking', input.bookingId);
      }
      const row = await tx
        .insertInto('safety_incident')
        .values({
          booking_id: input.bookingId,
          reported_by_user_id: reporter,
          reporter_role: reporterRole,
          source: context.source,
          severity: input.category === 'SOS' ? 'CRITICAL' : input.severity,
          category: input.category,
          summary: input.summary,
          lat: input.lat === null ? null : String(input.lat),
          lng: input.lng === null ? null : String(input.lng),
          location_text: input.locationText,
          review_due_at: new Date(this.clock.now().getTime() + 24 * 3_600_000),
          idempotency_key: idempotency.key,
          request_hash: idempotency.hash,
        })
        .onConflict((oc) => oc.columns(['reported_by_user_id', 'idempotency_key']).doNothing())
        .returning(['id', 'incident_code', 'severity', 'status'])
        .executeTakeFirst();
      if (!row) {
        const winner = await this.findByKey(tx, reporter, idempotency);
        if (!winner) throw new Error('Idempotent safety incident vanished');
        return winner;
      }
      await tx
        .insertInto('safety_incident_event')
        .values({
          incident_id: row.id,
          event_type: 'NOTE',
          to_status: 'OPEN',
          body: 'Incident reported',
          actor_user_id: reporter,
          source: context.source,
        })
        .execute();
      await this.outbox.enqueue(tx, 'DESK_SAFETY_CREATE', row.id, {
        requestId: context.requestId,
        onceKey: row.id,
      });
      // The first page goes out with the incident itself: if the incident exists, so do
      // the pages (delivered by the notification dispatcher, retried on failure).
      if (row.severity === 'CRITICAL') await this.page(tx, row.id, context, false);
      return { ...row, replayed: false };
    });
    if (incident.severity === 'CRITICAL' && !incident.replayed) {
      this.logger.error(`CRITICAL safety incident ${incident.incident_code} raised`);
    }
    return {
      id: incident.id,
      incidentCode: incident.incident_code,
      severity: incident.severity,
      status: incident.status,
      replayed: incident.replayed,
    };
  }

  private async findByKey(tx: Tx, reporter: string, idempotency: IdempotentRequest) {
    const row = await tx
      .selectFrom('safety_incident')
      .select(['id', 'incident_code', 'severity', 'status', 'request_hash'])
      .where('reported_by_user_id', '=', reporter)
      .where('idempotency_key', '=', idempotency.key)
      .executeTakeFirst();
    if (!row) return null;
    if (row.request_hash !== idempotency.hash) throw keyReusedError();
    return {
      id: row.id,
      incident_code: row.incident_code,
      severity: row.severity,
      status: row.status,
      replayed: true,
    };
  }

  async list(filter: { openOnly: boolean; limit: number }) {
    return this.db
      .selectFrom('safety_incident')
      .select([
        'id',
        'incident_code',
        'booking_id',
        'severity',
        'category',
        'status',
        'commander_user_id',
        'reported_at',
        'review_due_at',
      ])
      .$if(filter.openOnly, (qb) => qb.where('status', '<>', 'CLOSED'))
      .orderBy('severity')
      .orderBy('reported_at')
      .limit(filter.limit)
      .execute();
  }

  async detail(incidentId: string) {
    const row = await this.db
      .selectFrom('safety_incident')
      .selectAll()
      .where('id', '=', incidentId)
      .executeTakeFirst();
    if (!row) throw new NotFoundError('Safety incident', incidentId);
    const events = await this.db
      .selectFrom('safety_incident_event')
      .selectAll()
      .where('incident_id', '=', incidentId)
      .orderBy('id')
      .execute();
    return { ...row, events };
  }

  async act(
    context: ActionContext,
    incidentId: string,
    input: {
      note: string;
      status: 'CONTAINED' | 'UNDER_REVIEW' | 'CLOSED' | null;
      takeCommand: boolean;
    },
  ) {
    await inTransaction(this.db, context, async (tx) => {
      const current = await tx
        .selectFrom('safety_incident')
        .select(['status'])
        .where('id', '=', incidentId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw new NotFoundError('Safety incident', incidentId);
      if (current.status === 'CLOSED')
        throw new BusinessRuleError('INCIDENT_CLOSED', 'This incident is closed');
      // Anyone acting on the incident is on it: paging stops.
      await this.acknowledgeInTx(tx, incidentId, context);
      if (input.takeCommand) {
        await tx
          .updateTable('safety_incident')
          .set({ commander_user_id: context.actorUserId })
          .where('id', '=', incidentId)
          .execute();
        await tx
          .insertInto('safety_incident_event')
          .values({
            incident_id: incidentId,
            event_type: 'COMMANDER_CHANGE',
            body: input.note,
            actor_user_id: context.actorUserId,
            source: context.source,
          })
          .execute();
      }
      if (input.status) {
        const closing = input.status === 'CLOSED';
        await tx
          .updateTable('safety_incident')
          .set({
            status: input.status,
            ...(closing
              ? {
                  closed_by: context.actorUserId,
                  closed_at: this.clock.now(),
                  closure_summary: input.note,
                }
              : {}),
          })
          .where('id', '=', incidentId)
          .execute();
        await tx
          .insertInto('safety_incident_event')
          .values({
            incident_id: incidentId,
            event_type: 'STATUS_CHANGE',
            from_status: current.status,
            to_status: input.status,
            body: input.note,
            actor_user_id: context.actorUserId,
            source: context.source,
          })
          .execute();
      } else if (!input.takeCommand) {
        await tx
          .insertInto('safety_incident_event')
          .values({
            incident_id: incidentId,
            event_type: 'ACTION_TAKEN',
            body: input.note,
            actor_user_id: context.actorUserId,
            source: context.source,
          })
          .execute();
      }
    });
    return this.detail(incidentId);
  }

  // ---- Paging and escalation ----

  /**
   * Sends the next paging round for a critical incident that nobody has acknowledged:
   * round n pages roster levels 1..min(n, 3) by SMS and email, then schedules the next
   * round. Delivery problems do not stop escalation; only an acknowledgement does.
   */
  private async page(tx: Tx, incidentId: string, context: ActionContext, onlyIfDue: boolean) {
    const now = this.clock.now();
    const incident = await tx
      .selectFrom('safety_incident')
      .select([
        'incident_code',
        'category',
        'reporter_role',
        'reported_at',
        'status',
        'acknowledged_at',
        'pages_sent',
        'next_page_at',
      ])
      .where('id', '=', incidentId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (incident.acknowledged_at || incident.status === 'CLOSED') return;
    if (onlyIfDue && (!incident.next_page_at || incident.next_page_at > now)) return;

    const round = incident.pages_sent + 1;
    const level = Math.min(round, TOP_LEVEL);
    const people = await tx
      .selectFrom('safety_on_call as o')
      .innerJoin('app_user as u', 'u.id', 'o.user_id')
      .select('o.user_id')
      .distinct()
      .where('o.removed_at', 'is', null)
      .where('o.level', '<=', level)
      .where('u.status', '=', 'ACTIVE')
      .execute();
    for (const person of people) {
      await this.notifications.enqueue(tx, {
        event: 'SAFETY_ALERT',
        userId: person.user_id,
        variables: {
          category: incident.category,
          incidentCode: incident.incident_code,
          reporter: REPORTER_LABEL[incident.reporter_role] ?? 'user',
          raisedAt: incident.reported_at,
          page: String(round),
        },
        dedupeKey: `SAFETY_ALERT:${incidentId}:${String(round)}:${person.user_id}`,
      });
    }
    const timing = await this.pagingTiming(tx);
    const waitSeconds = round === 1 ? timing.secondPageAfterSeconds : timing.thenEverySeconds;
    await tx
      .updateTable('safety_incident')
      .set({ pages_sent: round, next_page_at: new Date(now.getTime() + waitSeconds * 1000) })
      .where('id', '=', incidentId)
      .execute();
    await tx
      .insertInto('safety_incident_event')
      .values({
        incident_id: incidentId,
        event_type: people.length > 0 ? 'PAGED' : 'NO_ONE_ON_CALL',
        body:
          people.length > 0
            ? `Page ${String(round)}: ${String(people.length)} on-call staff (levels 1-${String(level)}) alerted by SMS and email`
            : `Page ${String(round)}: nobody is on the on-call roster up to level ${String(level)}`,
        actor_user_id: null,
        source: context.source,
      })
      .execute();
    if (people.length === 0) {
      this.logger.error(`Safety incident ${incident.incident_code}: nobody on call to page`);
    }
  }

  /** The paging job: next round for every unacknowledged critical incident that is due. */
  async pageDue(requestId: string): Promise<number> {
    const due = await this.db
      .selectFrom('safety_incident')
      .select('id')
      .where('next_page_at', '<=', this.clock.now())
      .where('acknowledged_at', 'is', null)
      .where('status', '<>', 'CLOSED')
      .orderBy('next_page_at')
      .limit(50)
      .execute();
    const context = systemContext(requestId);
    for (const { id } of due) {
      await inTransaction(this.db, context, (tx) => this.page(tx, id, context, true));
    }
    return due.length;
  }

  /** A person has the incident: paging stops. Repeating it changes nothing. */
  async acknowledge(context: ActionContext, incidentId: string) {
    await inTransaction(this.db, context, async (tx) => {
      const found = await tx
        .selectFrom('safety_incident')
        .select('id')
        .where('id', '=', incidentId)
        .forUpdate()
        .executeTakeFirst();
      if (!found) throw new NotFoundError('Safety incident', incidentId);
      await this.acknowledgeInTx(tx, incidentId, context);
    });
    return this.detail(incidentId);
  }

  private async acknowledgeInTx(tx: Tx, incidentId: string, context: ActionContext) {
    const acknowledged = await tx
      .updateTable('safety_incident')
      .set({
        acknowledged_at: this.clock.now(),
        acknowledged_by: context.actorUserId,
        next_page_at: null,
      })
      .where('id', '=', incidentId)
      .where('acknowledged_at', 'is', null)
      .returning('id')
      .executeTakeFirst();
    if (!acknowledged) return;
    await tx
      .insertInto('safety_incident_event')
      .values({
        incident_id: incidentId,
        event_type: 'ACKNOWLEDGED',
        body: 'Acknowledged: paging stopped',
        actor_user_id: context.actorUserId,
        source: context.source,
      })
      .execute();
  }

  private async pagingTiming(tx: Tx) {
    const row = await tx
      .selectFrom('business_setting')
      .select('value')
      .where('key', '=', SAFETY_PAGING_SETTING)
      .executeTakeFirst();
    const value = (row?.value ?? {}) as Partial<typeof DEFAULT_PAGING>;
    const seconds = (v: unknown, fallback: number) =>
      typeof v === 'number' && v >= 30 && v <= 900 ? v : fallback;
    return {
      secondPageAfterSeconds: seconds(
        value.secondPageAfterSeconds,
        DEFAULT_PAGING.secondPageAfterSeconds,
      ),
      thenEverySeconds: seconds(value.thenEverySeconds, DEFAULT_PAGING.thenEverySeconds),
    };
  }

  // ---- On-call roster ----

  async onCall() {
    const rows = await this.db
      .selectFrom('safety_on_call as o')
      .innerJoin('app_user as u', 'u.id', 'o.user_id')
      .select([
        'o.id',
        'o.level',
        'o.user_id',
        'o.added_at',
        'u.full_name',
        'u.phone_e164',
        'u.email',
      ])
      .where('o.removed_at', 'is', null)
      .orderBy('o.level')
      .orderBy('o.added_at')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      level: r.level,
      userId: r.user_id,
      name: r.full_name,
      phone: maskPhone(r.phone_e164),
      hasEmail: r.email !== null,
      since: r.added_at,
    }));
  }

  /**
   * Puts a safety staff member on the roster. They must hold the safety permissions (so a
   * page leads somewhere they can act) and a phone number for SMS pages.
   */
  async addOnCall(
    context: ActionContext,
    input: { userId: string; level: number; phone: string | null; reason: string },
  ) {
    await inTransaction(this.db, { ...context, reason: input.reason }, async (tx) => {
      const grant = await tx
        .selectFrom('user_role as ur')
        .innerJoin('role_permission as rp', 'rp.role_code', 'ur.role_code')
        .select('ur.user_id')
        .where('ur.user_id', '=', input.userId)
        .where('ur.revoked_at', 'is', null)
        .where('rp.permission_code', '=', 'safety.manage')
        .executeTakeFirst();
      if (!grant)
        throw new BusinessRuleError(
          'NOT_SAFETY_STAFF',
          'Only staff who can manage safety incidents can be on call',
        );
      if (input.phone) {
        const taken = await tx
          .selectFrom('app_user')
          .select('id')
          .where('phone_e164', '=', input.phone)
          .where('id', '<>', input.userId)
          .executeTakeFirst();
        if (taken)
          throw new ConflictError('PHONE_IN_USE', 'This number belongs to another account');
        await tx
          .updateTable('app_user')
          .set({ phone_e164: input.phone })
          .where('id', '=', input.userId)
          .execute();
      }
      const contact = await tx
        .selectFrom('app_user')
        .select('phone_e164')
        .where('id', '=', input.userId)
        .executeTakeFirstOrThrow();
      if (!contact.phone_e164)
        throw new BusinessRuleError('PHONE_REQUIRED', 'On-call staff need a mobile number');
      await tx
        .insertInto('safety_on_call')
        .values({
          level: input.level,
          user_id: input.userId,
          reason: input.reason,
          added_by: context.actorUserId ?? '',
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
    });
    return this.onCall();
  }

  async removeOnCall(context: ActionContext, id: string, reason: string) {
    await inTransaction(this.db, { ...context, reason }, async (tx) => {
      const removed = await tx
        .updateTable('safety_on_call')
        .set({ removed_at: this.clock.now(), removed_by: context.actorUserId })
        .where('id', '=', id)
        .where('removed_at', 'is', null)
        .returning('id')
        .executeTakeFirst();
      if (!removed) throw new NotFoundError('On-call entry', id);
    });
    return this.onCall();
  }
}
