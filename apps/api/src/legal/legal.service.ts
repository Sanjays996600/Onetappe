import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import type { ClientApp } from '../auth/principal.js';
import { ForbiddenError, ValidationError } from '../common/errors.js';
import type { ActionContext } from '../database/action-context.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { inTransaction } from '../database/transaction.js';

export const LEGAL_CODES = [
  'CUSTOMER_TERMS',
  'PRIVACY_NOTICE',
  'WORKER_TERMS',
  'CANCELLATION_POLICY',
] as const;
export type LegalCode = (typeof LEGAL_CODES)[number];

/** Documents each app's users must accept (once any version of them is published). */
const REQUIRED: Record<'CUSTOMER_APP' | 'WORKER_APP', readonly LegalCode[]> = {
  CUSTOMER_APP: ['CUSTOMER_TERMS', 'PRIVACY_NOTICE', 'CANCELLATION_POLICY'],
  WORKER_APP: ['WORKER_TERMS', 'PRIVACY_NOTICE'],
};

/** Choices a person can switch on and off at any time. */
export const OPTIONAL_CONSENTS: Record<'CUSTOMER_APP' | 'WORKER_APP', readonly string[]> = {
  CUSTOMER_APP: ['MARKETING', 'WHATSAPP', 'LOCATION'],
  WORKER_APP: ['WHATSAPP', 'LOCATION', 'WORKER_TRACKING'],
};

const purposeOf = (code: LegalCode) => (code === 'PRIVACY_NOTICE' ? 'PRIVACY' : 'TERMS');

type PhoneApp = 'CUSTOMER_APP' | 'WORKER_APP';

function phoneApp(app: ClientApp): PhoneApp {
  if (app !== 'CUSTOMER_APP' && app !== 'WORKER_APP') {
    throw new ForbiddenError('WRONG_APP', 'Consents are recorded in the customer and worker apps');
  }
  return app;
}

/**
 * Legal documents and consent. A person accepts exact document versions (by id; each
 * carries its content hash); acceptance is recorded with time, channel and IP. Once a
 * document is published, customers cannot book and workers cannot go online until they
 * have accepted the current version.
 */
@Injectable()
export class LegalService {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  /** The version in force for each code: the latest whose effective date has passed. */
  async current(codes: readonly LegalCode[], locale?: string) {
    if (codes.length === 0) return [];
    const rows = await this.db
      .selectFrom('legal_document as d')
      .select([
        'd.id',
        'd.code',
        'd.version',
        'd.locale',
        'd.title',
        'd.url',
        'd.content_sha256',
        'd.effective_from',
      ])
      .where('d.code', 'in', codes)
      .where('d.effective_from', '<=', sql<Date>`now()`)
      .where('d.version', '=', (eb) =>
        eb
          .selectFrom('legal_document as l')
          .select('l.version')
          .whereRef('l.code', '=', 'd.code')
          .where('l.effective_from', '<=', sql<Date>`now()`)
          .orderBy('l.effective_from', 'desc')
          .limit(1),
      )
      .orderBy('d.code')
      .orderBy('d.locale')
      .execute();
    // One entry per code: the requested locale when available, else English.
    const byCode = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const chosen = byCode.get(row.code);
      if (!chosen || row.locale === locale || (chosen.locale !== locale && row.locale === 'en'))
        byCode.set(row.code, row);
    }
    return [...byCode.values()].map((d) => ({
      id: d.id,
      code: d.code as LegalCode,
      version: d.version,
      locale: d.locale,
      title: d.title,
      url: d.url,
      contentSha256: d.content_sha256,
      effectiveFrom: d.effective_from.toISOString(),
    }));
  }

  documentsFor(app: ClientApp, locale?: string) {
    return this.current(REQUIRED[phoneApp(app)], locale);
  }

  async status(userId: string, app: ClientApp, locale?: string) {
    const which = phoneApp(app);
    const documents = await this.current(REQUIRED[which], locale);
    const accepted = await this.acceptedVersions(userId);
    const required = documents.map((d) => ({
      ...d,
      accepted: accepted.has(`${d.code}:${d.version}`),
    }));
    const granted = await this.db
      .selectFrom('consent_record')
      .select('purpose')
      .where('user_id', '=', userId)
      .where('legal_document_id', 'is', null)
      .where('withdrawn_at', 'is', null)
      .execute();
    const on = new Set(granted.map((g) => g.purpose));
    return {
      allAccepted: required.every((d) => d.accepted),
      required,
      optional: OPTIONAL_CONSENTS[which].map((purpose) => ({ purpose, granted: on.has(purpose) })),
    };
  }

  /** Records acceptance of the given current document versions. Accepting twice is a no-op. */
  async accept(
    context: ActionContext,
    app: ClientApp,
    documentIds: readonly string[],
    ip: string | null,
  ) {
    const userId = context.actorUserId ?? '';
    const current = await this.current(REQUIRED[phoneApp(app)]);
    const currentKeys = new Set(current.map((d) => `${d.code}:${d.version}`));
    const docs = await this.db
      .selectFrom('legal_document')
      .select(['id', 'code', 'version'])
      .where('id', 'in', documentIds)
      .execute();
    if (
      docs.length !== new Set(documentIds).size ||
      docs.some((d) => !currentKeys.has(`${d.code}:${d.version}`))
    ) {
      throw new ValidationError(
        'LEGAL_DOCUMENT_NOT_CURRENT',
        'Accept the current version of the documents shown in the app',
      );
    }
    await inTransaction(this.db, context, async (tx) => {
      for (const doc of docs) {
        await tx
          .insertInto('consent_record')
          .values({
            user_id: userId,
            purpose: purposeOf(doc.code as LegalCode),
            legal_document_id: doc.id,
            source: context.source,
            ip,
          })
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
    });
  }

  /** Switches an optional consent on or off (withdrawal is recorded, never erased). */
  async setOptional(
    context: ActionContext,
    app: ClientApp,
    purpose: string,
    granted: boolean,
    ip: string | null,
  ): Promise<void> {
    if (!OPTIONAL_CONSENTS[phoneApp(app)].includes(purpose)) {
      throw new ValidationError(
        'CONSENT_PURPOSE_INVALID',
        `${purpose} is not a choice in this app`,
      );
    }
    const userId = context.actorUserId ?? '';
    await inTransaction(this.db, context, async (tx) => {
      if (granted) {
        await tx
          .insertInto('consent_record')
          .values({ user_id: userId, purpose, source: context.source, ip })
          .onConflict((oc) => oc.doNothing())
          .execute();
      } else {
        await tx
          .updateTable('consent_record')
          .set({ withdrawn_at: sql<Date>`now()` })
          .where('user_id', '=', userId)
          .where('purpose', '=', purpose)
          .where('legal_document_id', 'is', null)
          .where('withdrawn_at', 'is', null)
          .execute();
      }
    });
  }

  /** Blocks booking / going online until the current documents are accepted. */
  async assertAccepted(userId: string, app: PhoneApp): Promise<void> {
    const documents = await this.current(REQUIRED[app]);
    if (documents.length === 0) return;
    const accepted = await this.acceptedVersions(userId);
    const missing = documents.filter((d) => !accepted.has(`${d.code}:${d.version}`));
    if (missing.length > 0) {
      throw new ForbiddenError(
        'LEGAL_ACCEPTANCE_REQUIRED',
        'Please review and accept the updated terms to continue',
        { documents: missing.map((d) => ({ id: d.id, code: d.code, version: d.version })) },
      );
    }
  }

  private async acceptedVersions(userId: string): Promise<Set<string>> {
    const rows = await this.db
      .selectFrom('consent_record as c')
      .innerJoin('legal_document as d', 'd.id', 'c.legal_document_id')
      .select(['d.code', 'd.version'])
      .where('c.user_id', '=', userId)
      .where('c.withdrawn_at', 'is', null)
      .execute();
    return new Set(rows.map((r) => `${r.code}:${r.version}`));
  }
}
