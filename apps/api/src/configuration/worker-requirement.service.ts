import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '../common/errors.js';
import type { ActionContext } from '../database/action-context.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { inTransaction, type Tx } from '../database/transaction.js';

export const VERIFICATION_TYPES = [
  'IDENTITY',
  'ADDRESS',
  'POLICE',
  'REFERENCE',
  'FITNESS',
  'SKILL_ASSESSMENT',
  'CONTRACT',
  'PHOTO',
  'BANK_ACCOUNT',
] as const;
export type VerificationType = (typeof VERIFICATION_TYPES)[number];

/** One requirement of a service: a verification type or a training module. */
export type Requirement =
  | { readonly kind: 'VERIFICATION'; readonly verificationType: VerificationType }
  | { readonly kind: 'TRAINING'; readonly moduleCode: string };

/** Who the change touches today: permitted workers who would not meet the requirement. */
export interface RequirementImpact {
  readonly permittedWorkers: number;
  readonly workersNotMeetingIt: number;
}

/**
 * Training modules and the verifications and training a service requires. These decide who
 * may be booked (the database checks them at every allocation), so:
 *  - adding is an audited change that takes effect for the next allocation;
 *  - removing is never done by one person: it is requested, then approved by someone else,
 *    and the database refuses a removal without that approval;
 *  - a required module cannot be switched off, and nothing is edited in place.
 */
@Injectable()
export class WorkerRequirementService {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async overview() {
    const [modules, services, verifications, trainings, pending] = await Promise.all([
      this.db.selectFrom('training_module').selectAll().orderBy('code').execute(),
      this.db
        .selectFrom('service')
        .select(['id', 'code', 'name', 'is_active'])
        .orderBy('sort_order')
        .execute(),
      this.db.selectFrom('service_verification_requirement').selectAll().execute(),
      this.db.selectFrom('service_training_requirement').selectAll().execute(),
      this.relaxations('PENDING'),
    ]);
    return {
      trainingModules: modules,
      services: services.map((s) => ({
        ...s,
        verificationTypes: verifications
          .filter((v) => v.service_id === s.id)
          .map((v) => v.verification_type)
          .sort(),
        trainingModules: trainings
          .filter((t) => t.service_id === s.id)
          .map((t) => t.module_code)
          .sort(),
        pendingRelaxations: pending.filter((r) => r.service_id === s.id),
      })),
    };
  }

  relaxations(status?: 'PENDING' | 'APPLIED' | 'REJECTED' | 'WITHDRAWN') {
    return this.db
      .selectFrom('worker_requirement_relaxation')
      .selectAll()
      .$if(status !== undefined, (qb) => qb.where('status', '=', status ?? 'PENDING'))
      .orderBy('requested_at', 'desc')
      .limit(200)
      .execute();
  }

  // ---- Training modules ----

  createModule(
    actor: ActionContext,
    input: { code: string; name: string; description: string | null; reason: string },
  ) {
    return inTransaction(this.db, { ...actor, reason: input.reason }, (tx) =>
      tx
        .insertInto('training_module')
        .values({ code: input.code, name: input.name, description: input.description })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  updateModule(
    actor: ActionContext,
    code: string,
    input: { name?: string; description?: string | null; isActive?: boolean; reason: string },
  ) {
    return inTransaction(this.db, { ...actor, reason: input.reason }, async (tx) => {
      const module = await tx
        .selectFrom('training_module')
        .select('code')
        .where('code', '=', code)
        .forUpdate()
        .executeTakeFirst();
      if (!module) throw new NotFoundError('Training module', code);
      if (input.isActive === false && (await this.isRequired(tx, code))) {
        throw new BusinessRuleError(
          'TRAINING_MODULE_REQUIRED',
          `Training module ${code} is required by a service; remove the requirement first`,
        );
      }
      const changes = {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.isActive === undefined ? {} : { is_active: input.isActive }),
      };
      if (Object.keys(changes).length === 0) {
        return tx
          .selectFrom('training_module')
          .selectAll()
          .where('code', '=', code)
          .executeTakeFirstOrThrow();
      }
      return tx
        .updateTable('training_module')
        .set(changes)
        .where('code', '=', code)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  // ---- Strengthening: immediate, audited ----

  addRequirement(
    actor: ActionContext,
    serviceId: string,
    requirement: Requirement,
    reason: string,
  ): Promise<{ serviceId: string; requirement: Requirement; impact: RequirementImpact }> {
    return inTransaction(this.db, { ...actor, reason }, async (tx) => {
      await this.lockService(tx, serviceId);
      if (await this.exists(tx, serviceId, requirement)) {
        throw new BusinessRuleError('REQUIREMENT_EXISTS', 'The service already requires this');
      }
      if (requirement.kind === 'VERIFICATION') {
        await tx
          .insertInto('service_verification_requirement')
          .values({ service_id: serviceId, verification_type: requirement.verificationType })
          .execute();
      } else {
        const module = await tx
          .selectFrom('training_module')
          .select('is_active')
          .where('code', '=', requirement.moduleCode)
          .executeTakeFirst();
        if (!module) throw new NotFoundError('Training module', requirement.moduleCode);
        if (!module.is_active) {
          throw new BusinessRuleError(
            'TRAINING_MODULE_INACTIVE',
            `Training module ${requirement.moduleCode} is not active`,
          );
        }
        await tx
          .insertInto('service_training_requirement')
          .values({ service_id: serviceId, module_code: requirement.moduleCode })
          .execute();
      }
      return { serviceId, requirement, impact: await this.impact(tx, serviceId, requirement) };
    });
  }

  // ---- Weakening: requested by one person, approved by another ----

  requestRelaxation(
    actor: ActionContext,
    serviceId: string,
    requirement: Requirement,
    reason: string,
  ) {
    const requestedBy = this.staffId(actor);
    return inTransaction(this.db, { ...actor, reason }, async (tx) => {
      await this.lockService(tx, serviceId);
      if (!(await this.exists(tx, serviceId, requirement))) {
        throw new NotFoundError('Requirement', describe(requirement));
      }
      const open = await tx
        .selectFrom('worker_requirement_relaxation')
        .select('id')
        .where('service_id', '=', serviceId)
        .where('status', '=', 'PENDING')
        .where('requirement_kind', '=', requirement.kind)
        .where(
          requirement.kind === 'VERIFICATION' ? 'verification_type' : 'module_code',
          '=',
          requirement.kind === 'VERIFICATION'
            ? requirement.verificationType
            : requirement.moduleCode,
        )
        .executeTakeFirst();
      if (open) {
        throw new BusinessRuleError(
          'RELAXATION_ALREADY_REQUESTED',
          'A request to remove this requirement is already waiting for approval',
          { relaxationId: open.id },
        );
      }
      return tx
        .insertInto('worker_requirement_relaxation')
        .values({
          service_id: serviceId,
          requirement_kind: requirement.kind,
          verification_type:
            requirement.kind === 'VERIFICATION' ? requirement.verificationType : null,
          module_code: requirement.kind === 'TRAINING' ? requirement.moduleCode : null,
          reason,
          requested_by: requestedBy,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  /** A second person approves; the requirement is removed in the same transaction. */
  approveRelaxation(actor: ActionContext, relaxationId: string, note: string) {
    const approver = this.staffId(actor);
    return inTransaction(this.db, { ...actor, reason: note }, async (tx) => {
      const relaxation = await this.lockPending(tx, relaxationId);
      if (relaxation.requested_by === approver) {
        throw new ForbiddenError(
          'OWN_REQUEST',
          'A requirement removal must be approved by someone other than the requester',
        );
      }
      const applied = await tx
        .updateTable('worker_requirement_relaxation')
        .set({
          status: 'APPLIED',
          decided_by: approver,
          decided_at: sql<Date>`now()`,
          decision_note: note,
          applied_txid: sql<number>`txid_current()`,
        })
        .where('id', '=', relaxationId)
        .returningAll()
        .executeTakeFirstOrThrow();
      const removed =
        relaxation.requirement_kind === 'VERIFICATION'
          ? await tx
              .deleteFrom('service_verification_requirement')
              .where('service_id', '=', relaxation.service_id)
              .where('verification_type', '=', relaxation.verification_type ?? '')
              .executeTakeFirst()
          : await tx
              .deleteFrom('service_training_requirement')
              .where('service_id', '=', relaxation.service_id)
              .where('module_code', '=', relaxation.module_code ?? '')
              .executeTakeFirst();
      if (Number(removed.numDeletedRows) !== 1) {
        throw new BusinessRuleError(
          'REQUIREMENT_ALREADY_REMOVED',
          'The requirement no longer exists; withdraw or reject this request',
        );
      }
      return applied;
    });
  }

  rejectRelaxation(actor: ActionContext, relaxationId: string, note: string) {
    const decider = this.staffId(actor);
    return inTransaction(this.db, { ...actor, reason: note }, async (tx) => {
      const relaxation = await this.lockPending(tx, relaxationId);
      if (relaxation.requested_by === decider) {
        throw new ForbiddenError(
          'OWN_REQUEST',
          'Withdraw your own request instead of rejecting it',
        );
      }
      return tx
        .updateTable('worker_requirement_relaxation')
        .set({
          status: 'REJECTED',
          decided_by: decider,
          decided_at: sql<Date>`now()`,
          decision_note: note,
        })
        .where('id', '=', relaxationId)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  withdrawRelaxation(actor: ActionContext, relaxationId: string, reason: string) {
    const requester = this.staffId(actor);
    return inTransaction(this.db, { ...actor, reason }, async (tx) => {
      const relaxation = await this.lockPending(tx, relaxationId);
      if (relaxation.requested_by !== requester) {
        throw new ForbiddenError('NOT_REQUESTER', 'Only the requester can withdraw this request');
      }
      return tx
        .updateTable('worker_requirement_relaxation')
        .set({ status: 'WITHDRAWN', decided_at: sql<Date>`now()`, decision_note: reason })
        .where('id', '=', relaxationId)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  // ---- Helpers ----

  private staffId(actor: ActionContext): string {
    if (!actor.actorUserId) throw new ForbiddenError('STAFF_ONLY', 'Staff sign-in required');
    return actor.actorUserId;
  }

  private async lockService(tx: Tx, serviceId: string): Promise<void> {
    // Serialises requirement changes per service (checks and writes see one state).
    const service = await tx
      .selectFrom('service')
      .select('id')
      .where('id', '=', serviceId)
      .forUpdate()
      .executeTakeFirst();
    if (!service) throw new NotFoundError('Service', serviceId);
  }

  private async lockPending(tx: Tx, relaxationId: string) {
    const relaxation = await tx
      .selectFrom('worker_requirement_relaxation')
      .selectAll()
      .where('id', '=', relaxationId)
      .forUpdate()
      .executeTakeFirst();
    if (!relaxation) throw new NotFoundError('Requirement relaxation', relaxationId);
    if (relaxation.status !== 'PENDING') {
      throw new BusinessRuleError(
        'RELAXATION_NOT_PENDING',
        `This request is already ${relaxation.status.toLowerCase()}`,
      );
    }
    await this.lockService(tx, relaxation.service_id);
    return relaxation;
  }

  private async isRequired(tx: Tx, moduleCode: string): Promise<boolean> {
    const row = await tx
      .selectFrom('service_training_requirement')
      .select('service_id')
      .where('module_code', '=', moduleCode)
      .executeTakeFirst();
    return row !== undefined;
  }

  private async exists(tx: Tx, serviceId: string, requirement: Requirement): Promise<boolean> {
    const row =
      requirement.kind === 'VERIFICATION'
        ? await tx
            .selectFrom('service_verification_requirement')
            .select('service_id')
            .where('service_id', '=', serviceId)
            .where('verification_type', '=', requirement.verificationType)
            .executeTakeFirst()
        : await tx
            .selectFrom('service_training_requirement')
            .select('service_id')
            .where('service_id', '=', serviceId)
            .where('module_code', '=', requirement.moduleCode)
            .executeTakeFirst();
    return row !== undefined;
  }

  /** Workers allowed to do the service now, and how many of them lack the requirement. */
  private async impact(
    tx: Tx,
    serviceId: string,
    requirement: Requirement,
  ): Promise<RequirementImpact> {
    const met =
      requirement.kind === 'VERIFICATION'
        ? sql<boolean>`EXISTS (
            SELECT 1 FROM (
              SELECT v.status, v.expires_at FROM worker_verification v
              WHERE v.worker_id = p.worker_id AND v.verification_type = ${requirement.verificationType}
              ORDER BY v.created_at DESC LIMIT 1
            ) latest
            WHERE latest.status = 'VERIFIED' AND (latest.expires_at IS NULL OR latest.expires_at > now())
          )`
        : sql<boolean>`EXISTS (
            SELECT 1 FROM worker_training t
            WHERE t.worker_id = p.worker_id AND t.module_code = ${requirement.moduleCode}
              AND t.status = 'PASSED' AND (t.expires_at IS NULL OR t.expires_at > now())
          )`;
    const { rows } = await sql<{ permitted: string; missing: string }>`
      SELECT count(DISTINCT p.worker_id) AS permitted,
             count(DISTINCT p.worker_id) FILTER (WHERE NOT ${met}) AS missing
      FROM worker_service_permission p
      WHERE p.service_id = ${serviceId}
        AND p.revoked_at IS NULL
        AND (p.valid_until IS NULL OR p.valid_until > now())
    `.execute(tx);
    return {
      permittedWorkers: Number(rows[0]?.permitted ?? 0),
      workersNotMeetingIt: Number(rows[0]?.missing ?? 0),
    };
  }
}

function describe(requirement: Requirement): string {
  return requirement.kind === 'VERIFICATION'
    ? `VERIFICATION:${requirement.verificationType}`
    : `TRAINING:${requirement.moduleCode}`;
}
