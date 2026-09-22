import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { ActionContext } from '../database/action-context.js';
import { asSystem, type Tx } from '../database/transaction.js';

/** Verification types the worker uploads themselves; others are recorded by staff. */
export const WORKER_UPLOADED_TYPES = [
  'IDENTITY',
  'ADDRESS',
  'PHOTO',
  'FITNESS',
  'BANK_ACCOUNT',
] as const;

const ONBOARDING = [
  'REGISTERED',
  'PROFILE_PENDING',
  'DOCUMENTS_PENDING',
  'VERIFICATION_PENDING',
  'TRAINING_PENDING',
] as const;
type OnboardingStatus = (typeof ONBOARDING)[number];

export interface OnboardingState {
  readonly status: string;
  readonly profileComplete: boolean;
  /** Required for the active services; the worker uploads these. */
  readonly documentsRequired: readonly string[];
  readonly documentsSubmitted: readonly string[];
  /** All required verifications (including staff-recorded checks such as police). */
  readonly verificationsRequired: readonly string[];
  readonly verificationsVerified: readonly string[];
  readonly verificationsRejected: readonly string[];
  readonly trainingRequired: readonly string[];
  readonly trainingPassed: readonly string[];
  /** Approval and activation are staff decisions; the app shows "awaiting approval". */
  readonly awaitingStaffDecision: boolean;
}

/**
 * Works out where a worker is in onboarding from their data and moves the status forward
 * (or back, e.g. after a rejected document) through the database-enforced lifecycle.
 * Requirements come from configuration: the verifications and training that active
 * services require.
 */
@Injectable()
export class WorkerOnboardingService {
  async state(tx: Tx, workerId: string): Promise<OnboardingState> {
    const worker = await tx
      .selectFrom('worker_profile as w')
      .innerJoin('app_user as u', 'u.id', 'w.user_id')
      .select([
        'w.status',
        'u.full_name',
        'w.date_of_birth',
        'w.emergency_contact_name',
        'w.emergency_contact_phone',
        'w.home_address_id',
      ])
      .where('w.user_id', '=', workerId)
      .executeTakeFirstOrThrow();

    const required = await tx
      .selectFrom('service_verification_requirement as r')
      .innerJoin('service as s', 's.id', 'r.service_id')
      .select('r.verification_type')
      .distinct()
      .where('s.is_active', '=', true)
      .execute();
    const verificationsRequired = required.map((r) => r.verification_type).sort();

    const latest = await tx
      .selectFrom('worker_verification')
      .select(['verification_type', 'status', 'expires_at'])
      .distinctOn('verification_type')
      .where('worker_id', '=', workerId)
      .orderBy('verification_type')
      .orderBy('created_at', 'desc')
      .execute();
    const latestByType = new Map(latest.map((v) => [v.verification_type, v]));
    const now = new Date();

    const training = await tx
      .selectFrom('service_training_requirement as r')
      .innerJoin('service as s', 's.id', 'r.service_id')
      .select('r.module_code')
      .distinct()
      .where('s.is_active', '=', true)
      .execute();
    const passed = await tx
      .selectFrom('worker_training')
      .select('module_code')
      .where('worker_id', '=', workerId)
      .where('status', '=', 'PASSED')
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`now()`)]))
      .execute();
    const passedSet = new Set(passed.map((p) => p.module_code));

    const documentsRequired = verificationsRequired.filter((t) =>
      (WORKER_UPLOADED_TYPES as readonly string[]).includes(t),
    );
    const submittedStatuses = ['SUBMITTED', 'IN_REVIEW', 'VERIFIED'];
    return {
      status: worker.status,
      profileComplete: Boolean(
        worker.full_name &&
        worker.date_of_birth &&
        worker.emergency_contact_name &&
        worker.emergency_contact_phone &&
        worker.home_address_id,
      ),
      documentsRequired,
      documentsSubmitted: documentsRequired.filter((t) =>
        submittedStatuses.includes(latestByType.get(t)?.status ?? ''),
      ),
      verificationsRequired,
      verificationsVerified: verificationsRequired.filter((t) => {
        const v = latestByType.get(t);
        return v?.status === 'VERIFIED' && (!v.expires_at || v.expires_at > now);
      }),
      verificationsRejected: verificationsRequired.filter(
        (t) => latestByType.get(t)?.status === 'REJECTED',
      ),
      trainingRequired: training.map((t) => t.module_code).sort(),
      trainingPassed: training.map((t) => t.module_code).filter((m) => passedSet.has(m)),
      awaitingStaffDecision: worker.status === 'TRAINING_PENDING' || worker.status === 'APPROVED',
    };
  }

  /** Moves the worker as far forward as their data allows. Returns the new status. */
  async advance(tx: Tx, workerId: string, context: ActionContext): Promise<string> {
    for (let guard = 0; guard <= ONBOARDING.length; guard += 1) {
      const state = await this.state(tx, workerId);
      const next = this.nextStatus(state);
      if (!next) return state.status;
      const move = (): Promise<unknown> =>
        tx
          .updateTable('worker_profile')
          .set({ status: next })
          .where('user_id', '=', workerId)
          .execute();
      if (
        context.source === 'ADMIN' ||
        (context.source === 'WORKER_APP' && isWorkerStep(state.status as OnboardingStatus, next))
      ) {
        await move();
      } else {
        // A consequence the system derives (e.g. all checks verified), not the actor's own step.
        await asSystem(tx, context, move);
      }
    }
    return (await this.state(tx, workerId)).status;
  }

  private nextStatus(state: OnboardingState): string | null {
    const all = (have: readonly string[], need: readonly string[]) =>
      need.every((n) => have.includes(n));
    switch (state.status) {
      case 'REGISTERED':
        return 'PROFILE_PENDING';
      case 'PROFILE_PENDING':
        return state.profileComplete ? 'DOCUMENTS_PENDING' : null;
      case 'DOCUMENTS_PENDING':
        return all(state.documentsSubmitted, state.documentsRequired)
          ? 'VERIFICATION_PENDING'
          : null;
      case 'VERIFICATION_PENDING':
        if (state.verificationsRejected.length > 0) return 'DOCUMENTS_PENDING';
        return all(state.verificationsVerified, state.verificationsRequired)
          ? 'TRAINING_PENDING'
          : null;
      case 'TRAINING_PENDING':
        // Approval is a staff decision; only move back if a verification lapsed.
        return all(state.verificationsVerified, state.verificationsRequired)
          ? null
          : 'VERIFICATION_PENDING';
      default:
        return null;
    }
  }
}

/** Steps a worker's own actions may cause (the rest are system or staff moves). */
function isWorkerStep(from: OnboardingStatus, to: string): boolean {
  return (
    (from === 'REGISTERED' && to === 'PROFILE_PENDING') ||
    (from === 'PROFILE_PENDING' && to === 'DOCUMENTS_PENDING') ||
    (from === 'DOCUMENTS_PENDING' && to === 'VERIFICATION_PENDING')
  );
}
