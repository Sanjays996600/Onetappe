import { Body, Controller, HttpCode, Injectable, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodPipe } from '../common/http/zod.pipe.js';
import { AppAuthService } from './app-auth.service.js';
import { CurrentPrincipal, ForApp, Public, RequestMeta } from './decorators.js';
import { normaliseIndianMobile } from './otp/phone.js';
import { OtpService, type OtpClientApp } from './otp/otp.service.js';
import type { Principal } from './principal.js';
import { SessionService, type IssuedTokens } from './session.service.js';
import { StaffAuthService } from './staff-auth.service.js';

type Meta = { requestId: string; ip: string | null; userAgent: string | null };

const OtpRequestBody = z.object({
  phone: z.string().max(20),
  locale: z.enum(['en', 'hi']).default('en'),
});
const OtpVerifyBody = z.object({
  challengeId: z.uuid(),
  phone: z.string().max(20),
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});
const RefreshBody = z.object({ refreshToken: z.string().min(20).max(200) });
const StaffLoginBody = z.object({
  email: z.email().max(200),
  password: z.string().min(1).max(200),
});
const StaffMfaBody = z.object({
  challengeToken: z.string().min(20).max(200),
  code: z.string().regex(/^\d{6}$/),
});
const StepUpBody = z.object({ code: z.string().regex(/^\d{6}$/) });

function tokensView(tokens: IssuedTokens) {
  return {
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
    refreshToken: tokens.refreshToken,
    sessionExpiresAt: tokens.sessionExpiresAt.toISOString(),
  };
}

/** Shared by the customer and worker apps; DI metadata is inherited by subclasses. */
@Injectable()
abstract class PhoneAuthController {
  protected abstract readonly app: OtpClientApp;

  constructor(
    protected readonly otp: OtpService,
    protected readonly appAuth: AppAuthService,
  ) {}

  protected async requestOtp(body: z.infer<typeof OtpRequestBody>, meta: Meta) {
    const phone = normaliseIndianMobile(body.phone);
    const issued = await this.otp.request(phone, this.app, meta.ip, body.locale, meta.requestId);
    return {
      challengeId: issued.challengeId,
      phone,
      expiresAt: issued.expiresAt.toISOString(),
      resendAvailableAt: issued.resendAvailableAt.toISOString(),
    };
  }

  protected async verifyOtp(body: z.infer<typeof OtpVerifyBody>, meta: Meta) {
    const phone = normaliseIndianMobile(body.phone);
    const result = await this.appAuth.signIn(this.app, body.challengeId, phone, body.code, meta);
    return {
      ...tokensView(result.tokens),
      user: {
        id: result.userId,
        isNew: result.isNew,
        profileComplete: result.profileComplete,
        ...(this.app === 'CUSTOMER_APP'
          ? { hasAddress: result.hasAddress }
          : { workerStatus: result.workerStatus }),
      },
    };
  }
}

@Controller('customer/auth')
@Public()
export class CustomerAuthController extends PhoneAuthController {
  protected readonly app = 'CUSTOMER_APP' as const;

  @Post('otp')
  @HttpCode(200)
  request(
    @Body(new ZodPipe(OtpRequestBody)) body: z.infer<typeof OtpRequestBody>,
    @RequestMeta() meta: Meta,
  ) {
    return this.requestOtp(body, meta);
  }

  @Post('verify')
  @HttpCode(200)
  verify(
    @Body(new ZodPipe(OtpVerifyBody)) body: z.infer<typeof OtpVerifyBody>,
    @RequestMeta() meta: Meta,
  ) {
    return this.verifyOtp(body, meta);
  }
}

@Controller('worker/auth')
@Public()
export class WorkerAuthController extends PhoneAuthController {
  protected readonly app = 'WORKER_APP' as const;

  @Post('otp')
  @HttpCode(200)
  request(
    @Body(new ZodPipe(OtpRequestBody)) body: z.infer<typeof OtpRequestBody>,
    @RequestMeta() meta: Meta,
  ) {
    return this.requestOtp(body, meta);
  }

  @Post('verify')
  @HttpCode(200)
  verify(
    @Body(new ZodPipe(OtpVerifyBody)) body: z.infer<typeof OtpVerifyBody>,
    @RequestMeta() meta: Meta,
  ) {
    return this.verifyOtp(body, meta);
  }
}

@Controller('auth')
export class SessionController {
  constructor(
    private readonly sessions: SessionService,
    private readonly staffAuth: StaffAuthService,
  ) {}

  @Post('refresh')
  @Public()
  @HttpCode(200)
  async refresh(
    @Body(new ZodPipe(RefreshBody)) body: z.infer<typeof RefreshBody>,
    @RequestMeta() meta: Meta,
  ) {
    return tokensView(await this.sessions.refresh(body.refreshToken, meta));
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentPrincipal() principal: Principal, @RequestMeta() meta: Meta): Promise<void> {
    await this.sessions.revoke(principal.sessionId, 'LOGOUT', meta.requestId);
  }

  @Post('staff/login')
  @Public()
  @HttpCode(200)
  staffLogin(
    @Body(new ZodPipe(StaffLoginBody)) body: z.infer<typeof StaffLoginBody>,
    @RequestMeta() meta: Meta,
  ) {
    return this.staffAuth.login(body.email, body.password, meta);
  }

  @Post('staff/mfa')
  @Public()
  @HttpCode(200)
  async staffMfa(
    @Body(new ZodPipe(StaffMfaBody)) body: z.infer<typeof StaffMfaBody>,
    @RequestMeta() meta: Meta,
  ) {
    return tokensView(await this.staffAuth.completeMfa(body.challengeToken, body.code, meta));
  }

  @Post('staff/step-up')
  @ForApp('ADMIN_WEB')
  @HttpCode(204)
  async stepUp(
    @Body(new ZodPipe(StepUpBody)) body: z.infer<typeof StepUpBody>,
    @CurrentPrincipal() principal: Principal,
    @RequestMeta() meta: Meta,
  ): Promise<void> {
    await this.staffAuth.stepUp(principal, body.code, meta);
  }
}
