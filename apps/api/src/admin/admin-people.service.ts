import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import { BusinessRuleError, NotFoundError, ValidationError } from '../common/errors.js';
import { maskEmail, maskName, maskPhone } from '../common/pii.js';
import type { ActionContext } from '../database/action-context.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { inTransaction } from '../database/transaction.js';
import { DocumentService } from '../storage/document.service.js';
import { WorkerOnboardingService } from '../worker/worker-onboarding.service.js';

export type WorkerDecisionStatus =
  'APPROVED' | 'ACTIVE' | 'SUSPENDED' | 'RESTRICTED' | 'REJECTED' | 'INACTIVE' | 'PROFILE_PENDING';

/**
 * Customer and worker administration. Lists and details are masked; unmasked personal
 * data is only returned by reveal(), which requires its own permission, a reason, and
 * writes an audit event naming the fields seen.
 */
@Injectable()
export class AdminPeopleService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly documents: DocumentService,
    private readonly audit: AuditService,
    private readonly onboarding: WorkerOnboardingService,
  ) {}

  // ---- Customers ----

  async customers(query: { phoneLast4: string | null; limit: number }) {
    const rows = await this.db
      .selectFrom('app_user as u')
      .innerJoin('customer_profile as c', 'c.user_id', 'u.id')
      .select(['u.id', 'u.full_name', 'u.phone_e164', 'u.email', 'u.status', 'u.created_at'])
      .$if(query.phoneLast4 !== null, (qb) =>
        qb.where('u.phone_e164', 'like', `%${query.phoneLast4 ?? ''}`),
      )
      .orderBy('u.created_at', 'desc')
      .limit(query.limit)
      .execute();
    return rows.map((u) => ({
      id: u.id,
      name: maskName(u.full_name),
      phone: maskPhone(u.phone_e164),
      email: maskEmail(u.email),
      status: u.status,
    }));
  }

  async customer(customerId: string) {
    const u = await this.db
      .selectFrom('app_user as u')
      .innerJoin('customer_profile as c', 'c.user_id', 'u.id')
      .select(['u.id', 'u.full_name', 'u.phone_e164', 'u.email', 'u.status', 'u.created_at'])
      .where('u.id', '=', customerId)
      .executeTakeFirst();
    if (!u) throw new NotFoundError('Customer', customerId);
    const addresses = await this.db
      .selectFrom('address as a')
      .leftJoin('locality as l', 'l.id', 'a.locality_id')
      .select(['a.id', 'a.label', 'a.pincode', 'a.city_name', 'l.name as locality'])
      .where('a.user_id', '=', customerId)
      .where('a.archived_at', 'is', null)
      .execute();
    return {
      id: u.id,
      name: maskName(u.full_name),
      phone: maskPhone(u.phone_e164),
      email: maskEmail(u.email),
      status: u.status,
      memberSince: u.created_at.toISOString(),
      addresses: addresses.map((a) => ({
        id: a.id,
        label: a.label,
        locality: a.locality,
        pincode: a.pincode,
        cityName: a.city_name,
      })),
    };
  }

  /** Unmasked customer contact details. Audited with the reason given. */
  async revealCustomer(context: ActionContext, customerId: string, reason: string) {
    const u = await this.db
      .selectFrom('app_user')
      .select(['full_name', 'phone_e164', 'email'])
      .where('id', '=', customerId)
      .executeTakeFirst();
    if (!u) throw new NotFoundError('Customer', customerId);
    const addresses = await this.db
      .selectFrom('address')
      .select([
        'id',
        'label',
        'contact_name',
        'contact_phone_e164',
        'house_number',
        'building',
        'street',
        'landmark',
        'pincode',
        'city_name',
      ])
      .where('user_id', '=', customerId)
      .where('archived_at', 'is', null)
      .execute();
    await this.audit.record(context, {
      action: 'READ',
      entityType: 'customer_pii',
      entityId: customerId,
      reason,
      metadata: { fields: ['full_name', 'phone', 'email', 'addresses'] },
    });
    return { name: u.full_name, phone: u.phone_e164, email: u.email, addresses };
  }

  // ---- Workers ----

  async workers(query: { status: string | null; limit: number }) {
    const rows = await this.db
      .selectFrom('worker_profile as w')
      .innerJoin('app_user as u', 'u.id', 'w.user_id')
      .select([
        'w.user_id',
        'w.worker_code',
        'w.status',
        'w.primary_zone_id',
        'u.full_name',
        'u.phone_e164',
        'w.created_at',
      ])
      .$if(query.status !== null, (qb) => qb.where('w.status', '=', query.status ?? ''))
      .orderBy('w.created_at', 'desc')
      .limit(query.limit)
      .execute();
    return rows.map((w) => ({
      id: w.user_id,
      workerCode: w.worker_code,
      status: w.status,
      name: maskName(w.full_name),
      phone: maskPhone(w.phone_e164),
      zoneId: w.primary_zone_id,
    }));
  }

  async worker(workerId: string) {
    const w = await this.db
      .selectFrom('worker_profile as w')
      .innerJoin('app_user as u', 'u.id', 'w.user_id')
      .select([
        'w.user_id',
        'w.worker_code',
        'w.status',
        'w.status_reason',
        'w.primary_zone_id',
        'w.languages',
        'u.full_name',
        'u.phone_e164',
        'w.approved_at',
      ])
      .where('w.user_id', '=', workerId)
      .executeTakeFirst();
    if (!w) throw new NotFoundError('Worker', workerId);
    const [state, verifications, permissions, restrictions, history] = await Promise.all([
      this.db.transaction().execute((tx) => this.onboarding.state(tx, workerId)),
      this.db
        .selectFrom('worker_verification')
        .select([
          'id',
          'verification_type',
          'status',
          'method',
          'reference_masked',
          'submitted_at',
          'decided_at',
          'expires_at',
          'rejection_reason',
        ])
        .where('worker_id', '=', workerId)
        .orderBy('created_at', 'desc')
        .execute(),
      this.db
        .selectFrom('worker_service_permission')
        .select(['id', 'service_id', 'zone_id', 'granted_at', 'valid_until'])
        .where('worker_id', '=', workerId)
        .where('revoked_at', 'is', null)
        .execute(),
      this.db
        .selectFrom('worker_restriction')
        .select(['id', 'service_id', 'zone_id', 'reason', 'imposed_by', 'imposed_at', 'review_at'])
        .where('worker_id', '=', workerId)
        .where('lifted_at', 'is', null)
        .execute(),
      this.db
        .selectFrom('worker_status_history')
        .select(['from_status', 'to_status', 'source', 'actor_user_id', 'reason', 'occurred_at'])
        .where('worker_id', '=', workerId)
        .orderBy('id')
        .execute(),
    ]);
    return {
      id: w.user_id,
      workerCode: w.worker_code,
      status: w.status,
      statusReason: w.status_reason,
      name: maskName(w.full_name),
      phone: maskPhone(w.phone_e164),
      zoneId: w.primary_zone_id,
      languages: w.languages,
      approvedAt: w.approved_at?.toISOString() ?? null,
      onboarding: state,
      verifications,
      servicePermissions: permissions,
      activeRestrictions: restrictions,
      statusHistory: history,
    };
  }

  async revealWorker(context: ActionContext, workerId: string, reason: string) {
    const w = await this.db
      .selectFrom('worker_profile as w')
      .innerJoin('app_user as u', 'u.id', 'w.user_id')
      .leftJoin('address as a', 'a.id', 'w.home_address_id')
      .select([
        'u.full_name',
        'u.phone_e164',
        'w.date_of_birth',
        'w.emergency_contact_name',
        'w.emergency_contact_phone',
        'a.house_number',
        'a.street',
        'a.landmark',
        'a.pincode',
        'a.city_name',
      ])
      .where('w.user_id', '=', workerId)
      .executeTakeFirst();
    if (!w) throw new NotFoundError('Worker', workerId);
    await this.audit.record(context, {
      action: 'READ',
      entityType: 'worker_pii',
      entityId: workerId,
      reason,
      metadata: {
        fields: ['full_name', 'phone', 'date_of_birth', 'emergency_contact', 'home_address'],
      },
    });
    return {
      name: w.full_name,
      phone: w.phone_e164,
      dateOfBirth: w.date_of_birth,
      emergencyContact: { name: w.emergency_contact_name, phone: w.emergency_contact_phone },
      homeAddress: w.house_number
        ? {
            houseNumber: w.house_number,
            street: w.street,
            landmark: w.landmark,
            pincode: w.pincode,
            cityName: w.city_name,
          }
        : null,
    };
  }

  /**
   * Opens an uploaded document. Requires worker.documents.view and a reason; only files
   * that passed malware scanning and still match their checked hash; always audited.
   */
  async document(context: ActionContext, workerId: string, verificationId: string, reason: string) {
    const v = await this.db
      .selectFrom('worker_verification')
      .select(['document_id', 'verification_type'])
      .where('id', '=', verificationId)
      .where('worker_id', '=', workerId)
      .executeTakeFirst();
    if (!v?.document_id) throw new NotFoundError('Document', verificationId);
    const file = await this.documents.openClean(v.document_id);
    await this.audit.record(context, {
      action: 'READ',
      entityType: 'worker_document',
      entityId: verificationId,
      reason,
      metadata: { workerId, type: v.verification_type },
    });
    return file;
  }

  async decideVerification(
    context: ActionContext,
    workerId: string,
    verificationId: string,
    input: { decision: 'VERIFIED' | 'REJECTED'; reason: string; expiresAt: Date | null },
  ) {
    await inTransaction(this.db, { ...context, reason: input.reason }, async (tx) => {
      const v = await tx
        .selectFrom('worker_verification')
        .select(['status', 'document_id'])
        .where('id', '=', verificationId)
        .where('worker_id', '=', workerId)
        .forUpdate()
        .executeTakeFirst();
      if (!v) throw new NotFoundError('Verification', verificationId);
      if (!['PENDING', 'SUBMITTED', 'IN_REVIEW'].includes(v.status))
        throw new BusinessRuleError('ALREADY_DECIDED', `This check is already ${v.status}`);
      // A document can only be accepted once it has been scanned and found clean.
      if (input.decision === 'VERIFIED' && v.document_id) {
        const status = await this.documents.status(v.document_id);
        if (status !== 'CLEAN') {
          throw new BusinessRuleError(
            'DOCUMENT_NOT_SCANNED',
            'The document has not passed the malware scan yet',
          );
        }
      }
      await tx
        .updateTable('worker_verification')
        .set({
          status: input.decision,
          decided_by: context.actorUserId,
          decided_at: new Date(),
          expires_at: input.expiresAt,
          rejection_reason: input.decision === 'REJECTED' ? input.reason : null,
          notes: input.reason,
        })
        .where('id', '=', verificationId)
        .execute();
      await this.onboarding.advance(tx, workerId, context);
    });
    return this.worker(workerId);
  }

  /** Records a check performed by staff (police verification, references, skills test). */
  async recordVerification(
    context: ActionContext,
    workerId: string,
    input: {
      type: string;
      decision: 'VERIFIED' | 'REJECTED';
      method: string;
      reason: string;
      expiresAt: Date | null;
    },
  ) {
    await inTransaction(this.db, { ...context, reason: input.reason }, async (tx) => {
      await tx
        .insertInto('worker_verification')
        .values({
          worker_id: workerId,
          verification_type: input.type,
          status: input.decision,
          method: input.method,
          decided_by: context.actorUserId,
          decided_at: new Date(),
          expires_at: input.expiresAt,
          rejection_reason: input.decision === 'REJECTED' ? input.reason : null,
          notes: input.reason,
        })
        .execute();
      await this.onboarding.advance(tx, workerId, context);
    });
    return this.worker(workerId);
  }

  async recordTraining(
    context: ActionContext,
    workerId: string,
    input: {
      moduleCode: string;
      status: 'PASSED' | 'FAILED';
      score: number | null;
      expiresAt: Date | null;
      reason: string;
    },
  ) {
    await inTransaction(this.db, { ...context, reason: input.reason }, async (tx) => {
      await tx
        .insertInto('worker_training')
        .values({
          worker_id: workerId,
          module_code: input.moduleCode,
          status: input.status,
          score: input.score,
          assessed_by: context.actorUserId,
          assessed_at: new Date(),
          expires_at: input.expiresAt,
        })
        .execute();
      await this.onboarding.advance(tx, workerId, context);
    });
    return this.worker(workerId);
  }

  /**
   * Approve, activate, suspend, restrict, reject or deactivate. The database checks the
   * move is allowed; approval additionally requires every required check and training.
   */
  async changeStatus(
    context: ActionContext,
    workerId: string,
    to: WorkerDecisionStatus,
    reason: string,
  ) {
    if (!reason.trim()) throw new ValidationError('REASON_REQUIRED', 'Please give a reason');
    await inTransaction(this.db, { ...context, reason }, async (tx) => {
      if (to === 'APPROVED') {
        const state = await this.onboarding.state(tx, workerId);
        const missing = [
          ...state.verificationsRequired.filter((v) => !state.verificationsVerified.includes(v)),
          ...state.trainingRequired.filter((t) => !state.trainingPassed.includes(t)),
        ];
        if (missing.length > 0) {
          throw new BusinessRuleError(
            'WORKER_NOT_READY',
            'Required checks or training are incomplete',
            { missing },
          );
        }
      }
      const result = await tx
        .updateTable('worker_profile')
        .set(
          to === 'APPROVED'
            ? { status: to, approved_by: context.actorUserId, approved_at: new Date() }
            : { status: to },
        )
        .where('user_id', '=', workerId)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0) throw new NotFoundError('Worker', workerId);
      if (['SUSPENDED', 'INACTIVE', 'REJECTED'].includes(to)) {
        await tx
          .updateTable('worker_presence')
          .set({ is_online: false, changed_at: new Date() })
          .where('worker_id', '=', workerId)
          .execute();
      }
      // Leaving One Tappe starts the document retention clock; coming back stops it.
      if (to === 'INACTIVE' || to === 'REJECTED') {
        await this.documents.scheduleRetention(tx, workerId);
      } else {
        await this.documents.cancelRetention(tx, workerId);
      }
    });
    return this.worker(workerId);
  }

  async grantServicePermission(
    context: ActionContext,
    workerId: string,
    input: { serviceId: string; zoneId: string | null; reason: string },
  ) {
    await inTransaction(this.db, { ...context, reason: input.reason }, (tx) =>
      tx
        .insertInto('worker_service_permission')
        .values({
          worker_id: workerId,
          service_id: input.serviceId,
          zone_id: input.zoneId,
          granted_by: context.actorUserId ?? '',
        })
        .execute(),
    );
    return this.worker(workerId);
  }

  async addShift(
    context: ActionContext,
    workerId: string,
    input: { zoneId: string; start: Date; end: Date; reason: string | null },
  ) {
    if (input.end <= input.start)
      throw new ValidationError('SHIFT_INVALID', 'The shift must end after it starts');
    await inTransaction(this.db, { ...context, reason: input.reason }, (tx) =>
      tx
        .insertInto('worker_shift')
        .values({
          worker_id: workerId,
          zone_id: input.zoneId,
          period: sql`tstzrange(${input.start}, ${input.end}, '[)')`,
          created_by: context.actorUserId,
        })
        .execute(),
    );
  }

  async restrict(
    context: ActionContext,
    workerId: string,
    input: { serviceId: string | null; zoneId: string | null; reason: string; reviewAt: Date },
  ) {
    await inTransaction(this.db, { ...context, reason: input.reason }, (tx) =>
      tx
        .insertInto('worker_restriction')
        .values({
          worker_id: workerId,
          service_id: input.serviceId,
          zone_id: input.zoneId,
          reason: input.reason,
          imposed_by: context.actorUserId ?? '',
          review_at: input.reviewAt,
        })
        .execute(),
    );
    return this.worker(workerId);
  }

  async liftRestriction(
    context: ActionContext,
    workerId: string,
    restrictionId: string,
    reason: string,
  ) {
    await inTransaction(this.db, { ...context, reason }, async (tx) => {
      const result = await tx
        .updateTable('worker_restriction')
        .set({ lifted_by: context.actorUserId, lifted_at: new Date(), lift_reason: reason })
        .where('id', '=', restrictionId)
        .where('worker_id', '=', workerId)
        .where('lifted_at', 'is', null)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0)
        throw new NotFoundError('Restriction', restrictionId);
    });
    return this.worker(workerId);
  }
}
