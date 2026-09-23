import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { BusinessRuleError, NotFoundError, ValidationError } from '../common/errors.js';
import type { ActionContext } from '../database/action-context.js';
import { systemContext } from '../database/action-context.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { inTransaction, type Tx } from '../database/transaction.js';
import { sha256Hex } from '../security/crypto.js';
import {
  ALLOWED_DOCUMENT_TYPES,
  DOCUMENT_STORAGE,
  MAX_DOCUMENT_BYTES,
  detectContentType,
  type DocumentStorage,
  type UploadTarget,
} from './document-storage.js';
import {
  MALWARE_SCANNER,
  ScannerUnavailableError,
  type MalwareScanner,
} from './malware-scanner.js';

export type DocumentPurpose = 'WORKER_VERIFICATION';

/** business_setting['documents.retention']: how long documents are kept after they stop being needed. */
export const DOCUMENT_RETENTION_SETTING = 'documents.retention';

/** How long an unconfirmed upload may wait before its (possible) object is removed. */
const ABANDONED_UPLOAD_HOURS = 24;

/**
 * The lifecycle of a restricted document:
 *   AWAITING_UPLOAD → (owner confirms; bytes checked) → PENDING_SCAN → (malware scan)
 *   → CLEAN, or REJECTED (object deleted); later DELETED under the retention policy.
 * Staff can open only CLEAN documents, and every opening is audited by the caller.
 */
@Injectable()
export class DocumentService {
  private readonly logger = new Logger('Documents');

  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
  ) {}

  /** Step 1: a place to upload one file of the declared type. */
  async createUpload(
    context: ActionContext,
    ownerId: string,
    purpose: DocumentPurpose,
    keyPrefix: string,
    contentType: string,
  ): Promise<{ documentId: string; upload: UploadTarget }> {
    if (!(ALLOWED_DOCUMENT_TYPES as readonly string[]).includes(contentType)) {
      throw new ValidationError('FILE_TYPE_INVALID', 'Upload a JPEG, PNG or PDF');
    }
    const key = `${keyPrefix}/${randomUUID()}`;
    const document = await inTransaction(this.db, context, (tx) =>
      tx
        .insertInto('stored_document')
        .values({
          owner_user_id: ownerId,
          purpose,
          object_key: key,
          declared_content_type: contentType,
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    const upload = await this.storage.createUploadTarget(key, contentType, MAX_DOCUMENT_BYTES);
    return { documentId: document.id, upload };
  }

  /**
   * Step 2: the owner says the upload is done. The file is checked (exists, size, real type
   * from its bytes, hash) and queued for scanning. A file that fails is deleted at once.
   * Returns the object key for the record that references it.
   */
  async confirmUpload(
    context: ActionContext,
    documentId: string,
    ownerId: string,
    purpose: DocumentPurpose,
  ): Promise<{ objectKey: string }> {
    const doc = await this.db
      .selectFrom('stored_document')
      .select(['id', 'object_key', 'status', 'declared_content_type', 'owner_user_id', 'purpose'])
      .where('id', '=', documentId)
      .executeTakeFirst();
    if (!doc || doc.owner_user_id !== ownerId || doc.purpose !== purpose) {
      throw new NotFoundError('Document', documentId);
    }
    if (doc.status === 'PENDING_SCAN' || doc.status === 'CLEAN')
      return { objectKey: doc.object_key };
    if (doc.status !== 'AWAITING_UPLOAD') {
      throw new BusinessRuleError(
        'DOCUMENT_UNUSABLE',
        'This upload cannot be used; upload the file again',
      );
    }

    const info = await this.storage.head(doc.object_key);
    if (!info) {
      throw new ValidationError('DOCUMENT_NOT_UPLOADED', 'Upload the file before submitting it');
    }
    const reject = async (reason: 'EMPTY' | 'TOO_LARGE' | 'TYPE_MISMATCH', message: string) => {
      await this.storage.delete(doc.object_key);
      await inTransaction(this.db, context, (tx) =>
        tx
          .updateTable('stored_document')
          .set({ status: 'REJECTED', rejection_reason: reason })
          .where('id', '=', doc.id)
          .execute(),
      );
      return new ValidationError(`DOCUMENT_${reason}`, message);
    };
    if (info.size === 0) throw await reject('EMPTY', 'The file is empty');
    if (info.size > MAX_DOCUMENT_BYTES)
      throw await reject('TOO_LARGE', 'The file is too large (max 5 MB)');

    const bytes = await this.storage.read(doc.object_key);
    const detected = detectContentType(bytes);
    if (detected !== doc.declared_content_type) {
      throw await reject(
        'TYPE_MISMATCH',
        'The file is not a valid JPEG, PNG or PDF of the type declared',
      );
    }
    await inTransaction(this.db, context, (tx) =>
      tx
        .updateTable('stored_document')
        .set({
          status: 'PENDING_SCAN',
          detected_content_type: detected,
          size_bytes: bytes.length,
          sha256: sha256Hex(bytes),
          upload_confirmed_at: sql<Date>`now()`,
        })
        .where('id', '=', doc.id)
        .where('status', '=', 'AWAITING_UPLOAD')
        .execute(),
    );
    return { objectKey: doc.object_key };
  }

  /** Background job: scans waiting files. A scanner outage leaves them waiting (visible). */
  async scanPending(requestId: string, limit = 20): Promise<number> {
    const due = await this.db
      .selectFrom('stored_document')
      .select(['id', 'object_key', 'sha256'])
      .where('status', '=', 'PENDING_SCAN')
      .orderBy('upload_confirmed_at')
      .limit(limit)
      .execute();
    let scanned = 0;
    for (const doc of due) {
      const bytes = await this.storage.read(doc.object_key);
      if (sha256Hex(bytes) !== doc.sha256) {
        // The object changed after it was checked: never trust it.
        await this.rejectMalware(doc, requestId, 'CONTENT_CHANGED_AFTER_UPLOAD');
        scanned += 1;
        continue;
      }
      let result;
      try {
        result = await this.scanner.scan(bytes);
      } catch (error) {
        if (error instanceof ScannerUnavailableError) {
          this.logger.warn(`Document scanning paused: ${error.message}`);
          return scanned;
        }
        throw error;
      }
      if (result.infected) {
        await this.rejectMalware(doc, requestId, result.signature ?? 'unknown');
      } else {
        await inTransaction(this.db, systemContext(requestId), (tx) =>
          tx
            .updateTable('stored_document')
            .set({
              status: 'CLEAN',
              scan_engine: this.scanner.engine,
              scanned_at: sql<Date>`now()`,
            })
            .where('id', '=', doc.id)
            .where('status', '=', 'PENDING_SCAN')
            .execute(),
        );
      }
      scanned += 1;
    }
    return scanned;
  }

  private async rejectMalware(
    doc: { id: string; object_key: string },
    requestId: string,
    signature: string,
  ): Promise<void> {
    await this.storage.delete(doc.object_key);
    await inTransaction(this.db, systemContext(requestId), async (tx) => {
      await tx
        .updateTable('stored_document')
        .set({
          status: 'REJECTED',
          rejection_reason: 'MALWARE',
          scan_engine: this.scanner.engine,
          scan_signature: signature.slice(0, 200),
          scanned_at: sql<Date>`now()`,
        })
        .where('id', '=', doc.id)
        .execute();
      // A verification waiting on this file cannot be verified any more.
      // (Withdrawn, not rejected: no person decided it; the worker must upload again.)
      await tx
        .updateTable('worker_verification')
        .set({
          status: 'WITHDRAWN',
          rejection_reason: 'MALWARE_DETECTED',
          notes: 'The uploaded file failed the malware scan and was deleted; upload again',
        })
        .where('document_id', '=', doc.id)
        .where('status', '=', 'SUBMITTED')
        .execute();
    });
    this.logger.error(`Malware detected in uploaded document ${doc.id}: ${signature}`);
  }

  /** The file for audited staff viewing; only once it has passed scanning. */
  async openClean(documentId: string): Promise<{ bytes: Buffer; contentType: string }> {
    const doc = await this.db
      .selectFrom('stored_document')
      .select(['object_key', 'status', 'detected_content_type', 'sha256'])
      .where('id', '=', documentId)
      .executeTakeFirst();
    if (!doc) throw new NotFoundError('Document', documentId);
    if (doc.status !== 'CLEAN') {
      throw new BusinessRuleError(
        doc.status === 'PENDING_SCAN' ? 'DOCUMENT_NOT_SCANNED' : 'DOCUMENT_UNAVAILABLE',
        doc.status === 'PENDING_SCAN'
          ? 'The document is still being checked for malware'
          : 'The document is not available',
      );
    }
    const bytes = await this.storage.read(doc.object_key);
    // An upload link is valid for a few minutes: the stored object must still be exactly
    // the file that was checked and scanned.
    if (sha256Hex(bytes) !== doc.sha256) {
      this.logger.error(`Document ${documentId} changed after scanning; refusing to serve it`);
      throw new BusinessRuleError('DOCUMENT_TAMPERED', 'The document failed an integrity check');
    }
    return { bytes, contentType: doc.detected_content_type ?? 'application/octet-stream' };
  }

  async status(documentId: string): Promise<string | null> {
    const doc = await this.db
      .selectFrom('stored_document')
      .select('status')
      .where('id', '=', documentId)
      .executeTakeFirst();
    return doc?.status ?? null;
  }

  /**
   * Marks an owner's documents for deletion after the configured retention period (e.g.
   * when a worker leaves). Without a configured period nothing is scheduled: documents are
   * kept until the business sets a policy, and monitoring shows that it is missing.
   */
  async scheduleRetention(tx: Tx, ownerId: string): Promise<boolean> {
    const setting = await tx
      .selectFrom('business_setting')
      .select('value')
      .where('key', '=', DOCUMENT_RETENTION_SETTING)
      .executeTakeFirst();
    const days = (setting?.value as { daysAfterOffboarding?: unknown } | undefined)
      ?.daysAfterOffboarding;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 0) return false;
    await tx
      .updateTable('stored_document')
      .set({ retain_until: sql<Date>`now() + make_interval(days => ${days})` })
      .where('owner_user_id', '=', ownerId)
      .where('status', '<>', 'DELETED')
      .where('retain_until', 'is', null)
      .execute();
    return true;
  }

  /** The owner is active again: their documents are no longer due for deletion. */
  async cancelRetention(tx: Tx, ownerId: string): Promise<void> {
    await tx
      .updateTable('stored_document')
      .set({ retain_until: null })
      .where('owner_user_id', '=', ownerId)
      .where('status', '<>', 'DELETED')
      .where('retain_until', 'is not', null)
      .execute();
  }

  /** Background job: removes abandoned uploads and documents past their retention date. */
  async purge(requestId: string, limit = 100): Promise<number> {
    const due = await this.db
      .selectFrom('stored_document')
      .select(['id', 'object_key', 'status'])
      .where('status', '<>', 'DELETED')
      .where((eb) =>
        eb.or([
          eb('retain_until', '<', sql<Date>`now()`),
          eb.and([
            eb('status', '=', 'AWAITING_UPLOAD'),
            eb(
              'created_at',
              '<',
              sql<Date>`now() - make_interval(hours => ${ABANDONED_UPLOAD_HOURS})`,
            ),
          ]),
        ]),
      )
      .limit(limit)
      .execute();
    for (const doc of due) {
      await this.storage.delete(doc.object_key);
      await inTransaction(this.db, systemContext(requestId), (tx) =>
        tx
          .updateTable('stored_document')
          .set({
            status: 'DELETED',
            deleted_at: sql<Date>`now()`,
            deleted_reason:
              doc.status === 'AWAITING_UPLOAD' ? 'ABANDONED_UPLOAD' : 'RETENTION_EXPIRED',
          })
          .where('id', '=', doc.id)
          .execute(),
      );
    }
    return due.length;
  }
}
