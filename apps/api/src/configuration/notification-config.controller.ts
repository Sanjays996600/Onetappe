import { Body, Controller, Get, Inject, Post, Put } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { Actor, RequirePermissions } from '../auth/decorators.js';
import { ZodPipe } from '../common/http/zod.pipe.js';
import type { ActionContext } from '../database/action-context.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { inTransaction } from '../database/transaction.js';
import { NOTIFICATION_CHANNELS, NOTIFICATION_EVENTS } from '../notifications/events.js';

const Reason = z.string().trim().min(5).max(500);

const TemplateBody = z
  .object({
    event: z.enum(NOTIFICATION_EVENTS),
    channel: z.enum(NOTIFICATION_CHANNELS),
    locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
    title: z.string().trim().max(120).nullable().default(null),
    body: z.string().trim().min(3).max(1000),
    /** DLT template id (SMS) or provider template name (WhatsApp). */
    providerTemplateId: z.string().trim().max(80).nullable().default(null),
    reason: Reason,
  })
  .strict();
const RouteBody = z
  .object({
    event: z.enum(NOTIFICATION_EVENTS),
    channel: z.enum(NOTIFICATION_CHANNELS),
    isEnabled: z.boolean(),
    reason: Reason,
  })
  .strict();

/**
 * Notification wording and routing. Templates are versioned: publishing a new version
 * retires the previous one atomically (earlier messages keep pointing at the wording they
 * were sent with). Routes decide which channels an event goes out on.
 */
@Controller('admin/config/notifications')
@RequirePermissions('notification.manage')
export class NotificationConfigController {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  @Get('templates')
  templates() {
    return this.db
      .selectFrom('notification_template')
      .selectAll()
      .orderBy('code')
      .orderBy('channel')
      .orderBy('locale')
      .orderBy('version', 'desc')
      .execute();
  }

  @Post('templates')
  publish(
    @Actor() actor: ActionContext,
    @Body(new ZodPipe(TemplateBody)) body: z.infer<typeof TemplateBody>,
  ) {
    return inTransaction(this.db, { ...actor, reason: body.reason }, async (tx) => {
      const current = await tx
        .selectFrom('notification_template')
        .select(['id', 'version'])
        .where('code', '=', body.event)
        .where('channel', '=', body.channel)
        .where('locale', '=', body.locale)
        .orderBy('version', 'desc')
        .forUpdate()
        .execute();
      await tx
        .updateTable('notification_template')
        .set({ is_active: false })
        .where('code', '=', body.event)
        .where('channel', '=', body.channel)
        .where('locale', '=', body.locale)
        .where('is_active', '=', true)
        .execute();
      return tx
        .insertInto('notification_template')
        .values({
          code: body.event,
          channel: body.channel,
          locale: body.locale,
          version: (current[0]?.version ?? 0) + 1,
          title: body.title,
          body: body.body,
          provider_template_id: body.providerTemplateId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  @Get('routes')
  routes() {
    return this.db
      .selectFrom('notification_route')
      .selectAll()
      .orderBy('event_code')
      .orderBy('channel')
      .execute();
  }

  @Put('routes')
  setRoute(
    @Actor() actor: ActionContext,
    @Body(new ZodPipe(RouteBody)) body: z.infer<typeof RouteBody>,
  ) {
    return inTransaction(this.db, { ...actor, reason: body.reason }, (tx) =>
      tx
        .insertInto('notification_route')
        .values({
          event_code: body.event,
          channel: body.channel,
          is_enabled: body.isEnabled,
          updated_by: actor.actorUserId,
        })
        .onConflict((oc) =>
          oc.columns(['event_code', 'channel']).doUpdateSet({
            is_enabled: body.isEnabled,
            updated_by: actor.actorUserId,
          }),
        )
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }
}
