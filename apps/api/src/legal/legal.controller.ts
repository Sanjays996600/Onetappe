import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { Inject } from '@nestjs/common';
import { z } from 'zod';
import {
  Actor,
  CurrentPrincipal,
  ForApp,
  Public,
  RequestMeta,
  RequirePermissions,
  RequireRecentMfa,
} from '../auth/decorators.js';
import type { Principal } from '../auth/principal.js';
import { ZodPipe } from '../common/http/zod.pipe.js';
import type { ActionContext } from '../database/action-context.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { inTransaction } from '../database/transaction.js';
import { LEGAL_CODES, LegalService } from './legal.service.js';

type Meta = { requestId: string; ip: string | null; userAgent: string | null };

const Locale = z.enum(['en', 'hi']).optional();
const DocumentsQuery = z.object({ app: z.enum(['CUSTOMER_APP', 'WORKER_APP']), locale: Locale });
const StatusQuery = z.object({ locale: Locale });
const AcceptBody = z.object({ documentIds: z.array(z.uuid()).min(1).max(10) }).strict();
const ChoiceBody = z.object({ granted: z.boolean() }).strict();
const PublishBody = z
  .object({
    code: z.enum(LEGAL_CODES),
    version: z
      .string()
      .trim()
      .regex(/^[0-9A-Za-z._-]{1,20}$/),
    locale: z.enum(['en', 'hi']),
    title: z.string().trim().min(3).max(200),
    url: z.url().refine((u) => u.startsWith('https://'), 'Must be an https URL'),
    contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
    effectiveFrom: z.iso.datetime({ offset: true }),
    reason: z.string().trim().min(5).max(500),
  })
  .strict();

/** What the apps show before sign-up: the documents in force (no sign-in needed). */
@Controller('legal')
@Public()
export class LegalDocumentsController {
  constructor(private readonly legal: LegalService) {}

  @Get('documents')
  documents(@Query(new ZodPipe(DocumentsQuery)) query: z.infer<typeof DocumentsQuery>) {
    return this.legal.documentsFor(query.app, query.locale);
  }
}

/** The signed-in person's acceptances and choices. */
@Controller('me/consents')
@ForApp('CUSTOMER_APP', 'WORKER_APP')
export class ConsentController {
  constructor(private readonly legal: LegalService) {}

  @Get()
  status(
    @CurrentPrincipal() principal: Principal,
    @Query(new ZodPipe(StatusQuery)) query: z.infer<typeof StatusQuery>,
  ) {
    return this.legal.status(principal.userId, principal.app, query.locale);
  }

  @Post('accept')
  @HttpCode(204)
  async accept(
    @Actor() actor: ActionContext,
    @CurrentPrincipal() principal: Principal,
    @RequestMeta() meta: Meta,
    @Body(new ZodPipe(AcceptBody)) body: z.infer<typeof AcceptBody>,
  ): Promise<void> {
    await this.legal.accept(actor, principal.app, body.documentIds, meta.ip);
  }

  @Post(':purpose')
  @HttpCode(204)
  async choose(
    @Actor() actor: ActionContext,
    @CurrentPrincipal() principal: Principal,
    @RequestMeta() meta: Meta,
    @Param('purpose') purpose: string,
    @Body(new ZodPipe(ChoiceBody)) body: z.infer<typeof ChoiceBody>,
  ): Promise<void> {
    await this.legal.setOptional(actor, principal.app, purpose, body.granted, meta.ip);
  }
}

/** Publishing a document version (settings.manage). Published versions never change. */
@Controller('admin/config/legal-documents')
@ForApp('ADMIN_WEB')
@RequirePermissions('settings.manage')
export class LegalAdminController {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  @Get()
  list() {
    return this.db
      .selectFrom('legal_document')
      .selectAll()
      .orderBy('code')
      .orderBy('effective_from', 'desc')
      .execute();
  }

  @Post()
  @RequireRecentMfa()
  publish(
    @Actor() actor: ActionContext,
    @Body(new ZodPipe(PublishBody)) body: z.infer<typeof PublishBody>,
  ) {
    return inTransaction(this.db, { ...actor, reason: body.reason }, (tx) =>
      tx
        .insertInto('legal_document')
        .values({
          code: body.code,
          version: body.version,
          locale: body.locale,
          title: body.title,
          url: body.url,
          content_sha256: body.contentSha256,
          // Never in the past: acceptances already given must stay for the version in force.
          effective_from: sql<Date>`greatest(${new Date(body.effectiveFrom)}::timestamptz, now())`,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }
}
