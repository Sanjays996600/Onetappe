import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { BookingCancellationService } from './booking-cancellation.service.js';
import { CancellationPolicyService } from './cancellation-policy.service.js';
import { PaymentWebhookController } from './payment-webhook.controller.js';
import { PaymentService } from './payment.service.js';
import { PAYMENT_PROVIDER, type PaymentProvider } from './providers/payment-provider.js';
import { RazorpayProvider } from './providers/razorpay.provider.js';
import { SandboxPaymentProvider } from './providers/sandbox.provider.js';
import { RefundService } from './refund.service.js';
import { SandboxPaymentController } from './sandbox.controller.js';
import { SettlementService } from './settlement.service.js';

@Module({
  imports: [BookingModule],
  controllers: [PaymentWebhookController, SandboxPaymentController],
  providers: [
    {
      provide: PAYMENT_PROVIDER,
      inject: [ENV],
      useFactory: (env: Env): PaymentProvider =>
        env.PAYMENT_PROVIDER === 'razorpay'
          ? new RazorpayProvider({
              // Presence is enforced by the environment schema.
              keyId: env.RAZORPAY_KEY_ID ?? '',
              keySecret: env.RAZORPAY_KEY_SECRET ?? '',
              webhookSecret: env.RAZORPAY_WEBHOOK_SECRET ?? '',
              displayName: 'One Tappe',
            })
          : new SandboxPaymentProvider(env.SANDBOX_WEBHOOK_SECRET ?? ''),
    },
    PaymentService,
    RefundService,
    CancellationPolicyService,
    BookingCancellationService,
    SettlementService,
  ],
  exports: [
    PAYMENT_PROVIDER,
    PaymentService,
    RefundService,
    BookingCancellationService,
    SettlementService,
  ],
})
export class PaymentsModule {}
