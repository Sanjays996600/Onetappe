import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { Actor, ForApp, Public, RequestMeta, RequirePermissions } from '../auth/decorators.js';
import { ZodPipe } from '../common/http/zod.pipe.js';
import type { ActionContext } from '../database/action-context.js';
import { IntegrationMonitor } from './integration-monitor.service.js';
import { ZohoDeskWebhookService } from './zoho/zoho-desk-webhook.service.js';

const EventsQuery = z.object({
  status: z.enum(['PENDING', 'PROCESSING', 'SUCCEEDED', 'DEAD', 'DISCARDED']).optional(),
  target: z.enum(['ZOHO_CRM', 'ZOHO_DESK']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const NoteBody = z.object({ note: z.string().trim().min(5).max(500) });

/** Integration health and failed-event handling for operations. */
@Controller('admin/integrations')
@ForApp('ADMIN_WEB')
export class IntegrationsAdminController {
  constructor(private readonly monitor: IntegrationMonitor) {}

  @Get()
  @RequirePermissions('integration.read')
  status() {
    return this.monitor.status();
  }

  @Get('events')
  @RequirePermissions('integration.read')
  events(@Query(new ZodPipe(EventsQuery)) query: z.infer<typeof EventsQuery>) {
    return this.monitor.events(query);
  }

  @Post('events/:id/retry')
  @HttpCode(204)
  @RequirePermissions('integration.manage')
  async retry(
    @Actor() actor: ActionContext,
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodPipe(NoteBody)) body: z.infer<typeof NoteBody>,
  ) {
    await this.monitor.retry(id, body.note, actor);
  }

  @Post('events/:id/discard')
  @HttpCode(204)
  @RequirePermissions('integration.manage')
  async discard(
    @Actor() actor: ActionContext,
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodPipe(NoteBody)) body: z.infer<typeof NoteBody>,
  ) {
    await this.monitor.discard(id, body.note, actor);
  }

  @Post(':target/resume')
  @HttpCode(204)
  @RequirePermissions('integration.manage')
  async resume(
    @Actor() actor: ActionContext,
    @Param('target') target: string,
    @Body(new ZodPipe(NoteBody)) body: z.infer<typeof NoteBody>,
  ) {
    await this.monitor.resume(target, body.note, actor);
  }
}

/**
 * Zoho Desk webhook. Public (Zoho has no user token); authenticated by a shared secret
 * in the `x-onetappe-webhook-key` header or `key` query parameter.
 */
@Controller('integrations/zoho-desk')
@Public()
export class ZohoDeskWebhookController {
  constructor(private readonly webhooks: ZohoDeskWebhookService) {}

  @Post('webhook')
  @HttpCode(200)
  receive(
    @Headers('x-onetappe-webhook-key') headerKey: string | undefined,
    @Query('key') queryKey: string | undefined,
    @Body() body: unknown,
    @RequestMeta() meta: { requestId: string },
  ) {
    return this.webhooks.receive(headerKey ?? queryKey, body, meta.requestId);
  }
}
