import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { Actor, ForApp, RequirePermissions, RequireRecentMfa } from '../auth/decorators.js';
import { ZodPipe } from '../common/http/zod.pipe.js';
import type { ActionContext } from '../database/action-context.js';
import { StaffAdminService, type Invitation } from './staff-admin.service.js';

const reason = z.string().trim().min(5, 'Give a meaningful reason').max(500);
const Grant = z.object({
  role: z.string().regex(/^[A-Z_]+$/),
  cityId: z.uuid().nullable().default(null),
});
const CreateBody = z
  .object({
    email: z.email().max(200),
    fullName: z.string().trim().min(2).max(120),
    grants: z.array(Grant).min(1).max(10),
    reason,
  })
  .strict();
const GrantBody = Grant.extend({ reason }).strict();
const ReasonBody = z.object({ reason }).strict();
const StatusBody = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']), reason }).strict();

function invitationView(invitation: Invitation) {
  return { token: invitation.token, expiresAt: invitation.expiresAt.toISOString() };
}

/**
 * Staff accounts and access (user.manage). Each change needs a recent authenticator
 * check and a reason. Invitation tokens are returned once and never stored in clear.
 */
@Controller('admin/staff')
@ForApp('ADMIN_WEB')
@RequirePermissions('user.manage')
export class StaffAdminController {
  constructor(private readonly staff: StaffAdminService) {}

  @Get()
  list() {
    return this.staff.list();
  }

  @Post()
  @RequireRecentMfa()
  async create(
    @Actor() actor: ActionContext,
    @Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>,
  ) {
    const created = await this.staff.create(
      { ...actor, reason: body.reason },
      { email: body.email.trim(), fullName: body.fullName, grants: body.grants },
    );
    return { userId: created.userId, invitation: invitationView(created.invitation) };
  }

  @Post(':id/roles')
  @RequireRecentMfa()
  @HttpCode(204)
  async grant(
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(GrantBody)) body: z.infer<typeof GrantBody>,
  ): Promise<void> {
    await this.staff.grant({ ...actor, reason: body.reason }, id, body);
  }

  @Post(':id/roles/revoke')
  @RequireRecentMfa()
  @HttpCode(204)
  async revoke(
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(GrantBody)) body: z.infer<typeof GrantBody>,
  ): Promise<void> {
    await this.staff.revoke({ ...actor, reason: body.reason }, id, body);
  }

  @Post(':id/status')
  @RequireRecentMfa()
  @HttpCode(204)
  async status(
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(StatusBody)) body: z.infer<typeof StatusBody>,
  ): Promise<void> {
    await this.staff.setStatus({ ...actor, reason: body.reason }, id, body.status);
  }

  @Post(':id/reset-mfa')
  @RequireRecentMfa()
  @HttpCode(204)
  async resetMfa(
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>,
  ): Promise<void> {
    await this.staff.resetMfa({ ...actor, reason: body.reason }, id);
  }

  @Post(':id/invitation')
  @RequireRecentMfa()
  async reinvite(
    @Actor() actor: ActionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>,
  ) {
    return invitationView(await this.staff.reinvite({ ...actor, reason: body.reason }, id));
  }
}
