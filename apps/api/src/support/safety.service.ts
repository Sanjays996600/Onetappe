import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { Clock } from '../common/clock.js';
import { BusinessRuleError, NotFoundError, ValidationError } from '../common/errors.js';
import type { ActionContext } from '../database/action-context.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { inTransaction, type Tx } from '../database/transaction.js';
import { keyReusedError, type IdempotentRequest } from '../common/http/idempotency.js';

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
      return { ...row, replayed: false };
    });
    if (incident.severity === 'CRITICAL' && !incident.replayed) {
      // Operations dashboards poll open CRITICAL incidents; paging integrations hook in here.
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
}
