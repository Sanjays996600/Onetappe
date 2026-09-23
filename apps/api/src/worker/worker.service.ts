import { Inject, Injectable } from '@nestjs/common';
import { selectRule, type BookingStatus, type IsoWeekday } from '@onetappe/domain';
import { sql, type Kysely } from 'kysely';
import {
  BusinessRuleError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../common/errors.js';
import type { ActionContext } from '../database/action-context.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { inTransaction, type Queryable } from '../database/transaction.js';
import { DocumentService } from '../storage/document.service.js';
import { WORKER_UPLOADED_TYPES, WorkerOnboardingService } from './worker-onboarding.service.js';

const WORKING_STATUSES = ['ACTIVE', 'RESTRICTED'];
/** Booking statuses in which the assigned worker may see the customer's contact number. */
const CONTACT_VISIBLE: readonly BookingStatus[] = [
  'ASSIGNED',
  'EN_ROUTE',
  'ARRIVED',
  'IN_PROGRESS',
];

export interface WorkerProfileInput {
  readonly fullName?: string;
  readonly dateOfBirth?: string;
  readonly gender?: 'FEMALE' | 'MALE' | 'OTHER' | 'UNDISCLOSED';
  readonly languages?: readonly string[];
  readonly emergencyContactName?: string;
  readonly emergencyContactPhone?: string;
  readonly homeAddress?: {
    readonly houseNumber: string;
    readonly street: string | null;
    readonly landmark: string | null;
    readonly pincode: string;
    readonly cityName: string;
    readonly lat: number;
    readonly lng: number;
  };
}

/**
 * The worker app's view of the world. Signing in never implies permission to work:
 * going online and receiving jobs require an ACTIVE (or RESTRICTED) status, and every job
 * action is validated again by the booking engine and the database.
 */
@Injectable()
export class WorkerService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly documents: DocumentService,
    private readonly onboarding: WorkerOnboardingService,
  ) {}

  // ---- Profile & onboarding ----

  async profile(workerId: string) {
    const row = await this.db
      .selectFrom('worker_profile as w')
      .innerJoin('app_user as u', 'u.id', 'w.user_id')
      .leftJoin('address as a', 'a.id', 'w.home_address_id')
      .select([
        'w.user_id',
        'w.worker_code',
        'w.status',
        'w.status_reason',
        'w.date_of_birth',
        'w.gender',
        'w.languages',
        'w.emergency_contact_name',
        'w.emergency_contact_phone',
        'u.full_name',
        'u.phone_e164',
        'u.preferred_locale',
        'a.house_number',
        'a.street',
        'a.landmark',
        'a.pincode',
        'a.city_name',
      ])
      .where('w.user_id', '=', workerId)
      .executeTakeFirst();
    if (!row) throw new NotFoundError('Worker', workerId);
    const onboarding = await this.db
      .transaction()
      .execute((tx) => this.onboarding.state(tx, workerId));
    return {
      id: row.user_id,
      workerCode: row.worker_code,
      status: row.status,
      statusReason: row.status_reason,
      canWork: WORKING_STATUSES.includes(row.status),
      fullName: row.full_name,
      phone: row.phone_e164,
      preferredLocale: row.preferred_locale,
      dateOfBirth: row.date_of_birth,
      gender: row.gender,
      languages: row.languages,
      emergencyContact: row.emergency_contact_name
        ? { name: row.emergency_contact_name, phone: row.emergency_contact_phone }
        : null,
      homeAddress: row.house_number
        ? {
            houseNumber: row.house_number,
            street: row.street,
            landmark: row.landmark,
            pincode: row.pincode,
            cityName: row.city_name,
          }
        : null,
      onboarding,
    };
  }

  async updateProfile(context: ActionContext, input: WorkerProfileInput) {
    const workerId = requireActor(context);
    if (input.dateOfBirth && !isAdult(input.dateOfBirth)) {
      throw new ValidationError('WORKER_MUST_BE_ADULT', 'Workers must be at least 18 years old');
    }
    await inTransaction(this.db, context, async (tx) => {
      const current = await tx
        .selectFrom('worker_profile')
        .select(['status', 'home_address_id'])
        .where('user_id', '=', workerId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (
        ![
          'REGISTERED',
          'PROFILE_PENDING',
          'DOCUMENTS_PENDING',
          'VERIFICATION_PENDING',
          'TRAINING_PENDING',
        ].includes(current.status) &&
        (input.dateOfBirth || input.fullName)
      ) {
        throw new BusinessRuleError(
          'PROFILE_LOCKED',
          'Contact worker operations to change verified details',
        );
      }
      if (input.fullName)
        await tx
          .updateTable('app_user')
          .set({ full_name: input.fullName.trim() })
          .where('id', '=', workerId)
          .execute();

      let homeAddressId = current.home_address_id;
      if (input.homeAddress) {
        const user = await tx
          .selectFrom('app_user')
          .select(['full_name', 'phone_e164'])
          .where('id', '=', workerId)
          .executeTakeFirstOrThrow();
        const address = await tx
          .insertInto('address')
          .values({
            user_id: workerId,
            label: 'Home',
            contact_name: user.full_name ?? 'Worker',
            contact_phone_e164: user.phone_e164 ?? '+910000000000',
            house_number: input.homeAddress.houseNumber,
            street: input.homeAddress.street,
            landmark: input.homeAddress.landmark,
            pincode: input.homeAddress.pincode,
            city_name: input.homeAddress.cityName,
            lat: String(input.homeAddress.lat),
            lng: String(input.homeAddress.lng),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        if (homeAddressId)
          await tx
            .updateTable('address')
            .set({ archived_at: new Date() })
            .where('id', '=', homeAddressId)
            .execute();
        homeAddressId = address.id;
      }

      await tx
        .updateTable('worker_profile')
        .set({
          ...(input.dateOfBirth ? { date_of_birth: input.dateOfBirth } : {}),
          ...(input.gender ? { gender: input.gender } : {}),
          ...(input.languages ? { languages: [...input.languages] } : {}),
          ...(input.emergencyContactName
            ? { emergency_contact_name: input.emergencyContactName }
            : {}),
          ...(input.emergencyContactPhone
            ? { emergency_contact_phone: input.emergencyContactPhone }
            : {}),
          home_address_id: homeAddressId,
        })
        .where('user_id', '=', workerId)
        .execute();
      await this.onboarding.advance(tx, workerId, context);
    });
    return this.profile(workerId);
  }

  /** Step 1 of a document upload: a private, short-lived upload target for one file. */
  async documentUploadTarget(
    context: ActionContext,
    verificationType: string,
    contentType: string,
  ) {
    const workerId = requireActor(context);
    if (!(WORKER_UPLOADED_TYPES as readonly string[]).includes(verificationType)) {
      throw new ValidationError(
        'DOCUMENT_TYPE_INVALID',
        'This check is recorded by One Tappe staff, not uploaded',
      );
    }
    const { documentId, upload } = await this.documents.createUpload(
      context,
      workerId,
      'WORKER_VERIFICATION',
      `workers/${workerId}/${verificationType.toLowerCase()}`,
      contentType,
    );
    return { documentId, upload: { ...upload, expiresAt: upload.expiresAt.toISOString() } };
  }

  /** Step 2: submit the uploaded file for verification (checked, then malware-scanned). */
  async submitVerification(
    context: ActionContext,
    input: { verificationType: string; documentId: string; referenceLast4: string | null },
  ) {
    const workerId = requireActor(context);
    if (!(WORKER_UPLOADED_TYPES as readonly string[]).includes(input.verificationType)) {
      throw new ValidationError('DOCUMENT_TYPE_INVALID', 'Unknown verification type');
    }
    const { objectKey } = await this.documents.confirmUpload(
      context,
      input.documentId,
      workerId,
      'WORKER_VERIFICATION',
    );
    if (!objectKey.startsWith(`workers/${workerId}/${input.verificationType.toLowerCase()}/`)) {
      throw new ForbiddenError(
        'DOCUMENT_NOT_FOR_THIS_CHECK',
        'This file was uploaded for another check',
      );
    }
    await inTransaction(this.db, context, async (tx) => {
      await tx
        .insertInto('worker_verification')
        .values({
          worker_id: workerId,
          verification_type: input.verificationType,
          status: 'SUBMITTED',
          method: 'DOCUMENT_UPLOAD',
          reference_masked: input.referenceLast4,
          document_object_key: objectKey,
          document_id: input.documentId,
          submitted_at: new Date(),
        })
        .execute();
      await this.onboarding.advance(tx, workerId, context);
    });
    return this.verifications(workerId);
  }

  async verifications(workerId: string) {
    const rows = await this.db
      .selectFrom('worker_verification')
      .select([
        'id',
        'verification_type',
        'status',
        'submitted_at',
        'decided_at',
        'expires_at',
        'rejection_reason',
        'created_at',
      ])
      .where('worker_id', '=', workerId)
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      type: r.verification_type,
      status: r.status,
      submittedAt: r.submitted_at?.toISOString() ?? null,
      decidedAt: r.decided_at?.toISOString() ?? null,
      expiresAt: r.expires_at?.toISOString() ?? null,
      rejectionReason: r.rejection_reason,
    }));
  }

  async training(workerId: string) {
    const rows = await this.db
      .selectFrom('training_module as m')
      .leftJoin('worker_training as t', (j) =>
        j.onRef('t.module_code', '=', 'm.code').on('t.worker_id', '=', workerId),
      )
      .select(['m.code', 'm.name', 't.status', 't.score', 't.assessed_at', 't.expires_at'])
      .where('m.is_active', '=', true)
      .orderBy('m.code')
      .execute();
    return rows.map((r) => ({
      module: r.code,
      name: r.name,
      status: r.status ?? 'NOT_STARTED',
      score: r.score,
      assessedAt: r.assessed_at?.toISOString() ?? null,
      expiresAt: r.expires_at?.toISOString() ?? null,
    }));
  }

  // ---- Availability ----

  async setPresence(
    context: ActionContext,
    input: { online: boolean; lat: number | null; lng: number | null },
  ) {
    const workerId = requireActor(context);
    await inTransaction(this.db, context, async (tx) => {
      const worker = await tx
        .selectFrom('worker_profile')
        .select('status')
        .where('user_id', '=', workerId)
        .executeTakeFirstOrThrow();
      if (input.online && !WORKING_STATUSES.includes(worker.status)) {
        throw new ForbiddenError(
          'WORKER_NOT_ACTIVE',
          'You can go online once your account is active',
        );
      }
      await tx
        .insertInto('worker_presence')
        .values({
          worker_id: workerId,
          is_online: input.online,
          changed_at: new Date(),
          last_lat: input.lat === null ? null : String(input.lat),
          last_lng: input.lng === null ? null : String(input.lng),
          last_location_at: input.lat === null ? null : new Date(),
        })
        .onConflict((oc) =>
          oc.column('worker_id').doUpdateSet({
            is_online: input.online,
            changed_at: new Date(),
            ...(input.lat === null
              ? {}
              : {
                  last_lat: String(input.lat),
                  last_lng: String(input.lng),
                  last_location_at: new Date(),
                }),
          }),
        )
        .execute();
    });
    return { online: input.online };
  }

  async shifts(workerId: string) {
    const rows = await this.db
      .selectFrom('worker_shift as s')
      .innerJoin('zone as z', 'z.id', 's.zone_id')
      .select([
        sql<Date>`lower(s.period)`.as('start'),
        sql<Date>`upper(s.period)`.as('end'),
        'z.name as zone',
      ])
      .where('s.worker_id', '=', workerId)
      .where('s.status', '=', 'PLANNED')
      .where(sql<boolean>`upper(s.period) > now()`)
      .orderBy(sql`lower(s.period)`)
      .limit(60)
      .execute();
    return rows.map((r) => ({
      start: new Date(r.start).toISOString(),
      end: new Date(r.end).toISOString(),
      zone: r.zone,
    }));
  }

  // ---- Jobs ----

  /** Open offers with only what is needed to decide — no address or customer details yet. */
  async offers(workerId: string) {
    const rows = await this.db
      .selectFrom('booking_assignment as a')
      .innerJoin('booking as b', 'b.id', 'a.booking_id')
      .innerJoin('service as s', 's.id', 'b.service_id')
      .innerJoin('locality as l', 'l.id', 'b.locality_id')
      .select([
        'a.id',
        'a.offer_expires_at',
        'b.id as booking_id',
        'b.scheduled_start',
        'b.scheduled_end',
        'b.service_id',
        'b.service_option_id',
        'b.city_id',
        'b.zone_id',
        's.name as service_name',
        'l.name as locality',
        'l.pincode',
      ])
      .where('a.worker_id', '=', workerId)
      .where('a.status', '=', 'OFFERED')
      .where('a.offer_expires_at', '>', sql<Date>`now()`)
      .orderBy('b.scheduled_start')
      .execute();
    return Promise.all(
      rows.map(async (r) => ({
        offerId: r.id,
        bookingId: r.booking_id,
        service: r.service_name,
        locality: r.locality,
        pincode: r.pincode,
        start: r.scheduled_start.toISOString(),
        end: r.scheduled_end.toISOString(),
        expiresAt: r.offer_expires_at.toISOString(),
        estimatedPayoutPaise: await this.estimatedPayout(this.db, r),
      })),
    );
  }

  /** Full job details — only for the worker who accepted it. */
  async job(workerId: string, bookingId: string) {
    const assignment = await this.db
      .selectFrom('booking_assignment')
      .select(['id', 'status'])
      .where('booking_id', '=', bookingId)
      .where('worker_id', '=', workerId)
      .where('status', 'in', ['ACCEPTED', 'COMPLETED'])
      .executeTakeFirst();
    if (!assignment) throw new NotFoundError('Job', bookingId);
    const b = await this.db
      .selectFrom('booking as b')
      .innerJoin('service as s', 's.id', 'b.service_id')
      .innerJoin('app_user as c', 'c.id', 'b.customer_user_id')
      .select([
        'b.id',
        'b.booking_code',
        'b.status',
        'b.scheduled_start',
        'b.scheduled_end',
        'b.address_snapshot',
        'b.customer_notes',
        's.name as service_name',
        'c.full_name as customer_name',
      ])
      .where('b.id', '=', bookingId)
      .executeTakeFirstOrThrow();
    const tasks = await this.db
      .selectFrom('booking_task')
      .select(['name', 'priority', 'status'])
      .where('booking_id', '=', bookingId)
      .orderBy('priority')
      .execute();
    const status = b.status as BookingStatus;
    const address = b.address_snapshot as Record<string, unknown>;
    const contactVisible = CONTACT_VISIBLE.includes(status) && assignment.status === 'ACCEPTED';
    return {
      bookingId: b.id,
      bookingCode: b.booking_code,
      status,
      service: b.service_name,
      start: b.scheduled_start.toISOString(),
      end: b.scheduled_end.toISOString(),
      customerFirstName: b.customer_name?.split(/\s+/)[0] ?? null,
      address: {
        houseNumber: address['houseNumber'],
        building: address['building'],
        street: address['street'],
        landmark: address['landmark'],
        pincode: address['pincode'],
        cityName: address['cityName'],
        lat: address['lat'],
        lng: address['lng'],
        accessNotes: address['accessNotes'],
        // The number is shown only while the job is active.
        contactPhone: contactVisible ? address['contactPhone'] : null,
      },
      notes: b.customer_notes,
      tasks,
    };
  }

  async currentJob(workerId: string) {
    const row = await this.db
      .selectFrom('booking_assignment as a')
      .innerJoin('booking as b', 'b.id', 'a.booking_id')
      .select('b.id')
      .where('a.worker_id', '=', workerId)
      .where('a.status', '=', 'ACCEPTED')
      .where('b.status', 'in', ['ASSIGNED', 'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'])
      .orderBy('b.scheduled_start')
      .limit(1)
      .executeTakeFirst();
    return row ? this.job(workerId, row.id) : null;
  }

  async jobHistory(workerId: string, limit: number) {
    const rows = await this.db
      .selectFrom('booking_assignment as a')
      .innerJoin('booking as b', 'b.id', 'a.booking_id')
      .innerJoin('service as s', 's.id', 'b.service_id')
      .innerJoin('locality as l', 'l.id', 'b.locality_id')
      .select([
        'b.id',
        'b.booking_code',
        'b.status',
        'b.scheduled_start',
        'a.status as assignment_status',
        's.name as service_name',
        'l.name as locality',
      ])
      .where('a.worker_id', '=', workerId)
      .where('a.status', 'in', ['ACCEPTED', 'COMPLETED', 'WITHDRAWN'])
      .orderBy('b.scheduled_start', 'desc')
      .limit(limit)
      .execute();
    return rows.map((r) => ({
      bookingId: r.id,
      bookingCode: r.booking_code,
      status: r.status,
      assignment: r.assignment_status,
      service: r.service_name,
      locality: r.locality,
      start: r.scheduled_start.toISOString(),
    }));
  }

  async earnings(workerId: string) {
    const rows = await this.db
      .selectFrom('worker_earning as e')
      .leftJoin('booking as b', 'b.id', 'e.booking_id')
      .select([
        'e.id',
        'e.earning_type',
        'e.amount_paise',
        'e.status',
        'e.description',
        'e.created_at',
        'b.booking_code',
      ])
      .where('e.worker_id', '=', workerId)
      .where('e.status', '<>', 'VOID')
      .orderBy('e.created_at', 'desc')
      .limit(200)
      .execute();
    const totals: Record<string, number> = {};
    for (const r of rows) totals[r.status] = (totals[r.status] ?? 0) + r.amount_paise;
    return {
      totalsPaise: totals,
      items: rows.map((r) => ({
        id: r.id,
        type: r.earning_type,
        amountPaise: r.amount_paise,
        status: r.status,
        description: r.description,
        bookingCode: r.booking_code,
        createdAt: r.created_at.toISOString(),
      })),
    };
  }

  private async estimatedPayout(
    db: Queryable,
    booking: {
      service_id: string;
      service_option_id: string | null;
      city_id: string;
      zone_id: string;
      scheduled_start: Date;
    },
  ): Promise<number | null> {
    const rules = await db
      .selectFrom('payout_rule')
      .selectAll()
      .where('service_id', '=', booking.service_id)
      .where('is_active', '=', true)
      .execute();
    const rule = selectRule(
      rules.map((r) => ({
        id: r.id,
        serviceId: r.service_id,
        serviceOptionId: r.service_option_id,
        cityId: r.city_id,
        zoneId: r.zone_id,
        weekdays: r.weekdays as IsoWeekday[] | null,
        startMinute: r.start_minute,
        endMinute: r.end_minute,
        validFrom: r.valid_from,
        validTo: r.valid_to,
        priority: r.priority,
        isActive: r.is_active,
        row: r,
      })),
      {
        serviceId: booking.service_id,
        serviceOptionId: booking.service_option_id,
        cityId: booking.city_id,
        zoneId: booking.zone_id,
        serviceStart: booking.scheduled_start,
        pricedAt: new Date(),
        timeZone: 'Asia/Kolkata',
      },
    );
    return rule ? rule.row.base_payout_paise + rule.row.travel_allowance_paise : null;
  }
}

function requireActor(context: ActionContext): string {
  if (!context.actorUserId) throw new ForbiddenError('NOT_AUTHENTICATED', 'Sign in required');
  return context.actorUserId;
}

function isAdult(dateOfBirth: string): boolean {
  const dob = new Date(`${dateOfBirth}T00:00:00Z`);
  if (Number.isNaN(dob.getTime())) return false;
  const eighteen = new Date(dob);
  eighteen.setUTCFullYear(dob.getUTCFullYear() + 18);
  return eighteen <= new Date();
}
