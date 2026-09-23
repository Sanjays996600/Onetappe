import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuditService } from '../audit/audit.service.js';
import { Clock } from '../common/clock.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { AppAuthService } from './app-auth.service.js';
import { AuthGuard } from './auth.guard.js';
import {
  CustomerAuthController,
  SessionController,
  WorkerAuthController,
} from './auth.controller.js';
import {
  ConsoleOtpSender,
  Msg91OtpSender,
  OTP_SENDER,
  TestOtpSender,
  type OtpSender,
} from './otp/otp-sender.js';
import { OtpService } from './otp/otp.service.js';
import { SessionService } from './session.service.js';
import { StaffAuthService } from './staff-auth.service.js';

@Global()
@Module({
  controllers: [CustomerAuthController, WorkerAuthController, SessionController],
  providers: [
    Clock,
    AuditService,
    SessionService,
    OtpService,
    AppAuthService,
    StaffAuthService,
    TestOtpSender,
    {
      provide: OTP_SENDER,
      inject: [ENV, TestOtpSender],
      useFactory: (env: Env, testSender: TestOtpSender): OtpSender => {
        switch (env.OTP_PROVIDER) {
          case 'test':
            return testSender;
          case 'console':
            return new ConsoleOtpSender();
          case 'msg91':
            // Presence of both values is enforced by the environment schema.
            return new Msg91OtpSender({
              authKey: env.MSG91_AUTH_KEY ?? '',
              templateId: env.MSG91_TEMPLATE_ID ?? '',
              apiUrl: env.MSG91_API_URL,
            });
        }
      },
    },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [Clock, AuditService, SessionService, StaffAuthService, TestOtpSender, OTP_SENDER],
})
export class AuthModule {}
