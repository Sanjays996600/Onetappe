import { Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { Body } from '@nestjs/common';
import { Public, RequestMeta } from '../auth/decorators.js';
import { NotFoundError } from '../common/errors.js';
import { ZodPipe } from '../common/http/zod.pipe.js';
import { PaymentService } from './payment.service.js';
import { PAYMENT_PROVIDER, type PaymentProvider } from './providers/payment-provider.js';
import { SandboxPaymentProvider } from './providers/sandbox.provider.js';

const SimulateBody = z.object({ outcome: z.enum(['capture', 'fail']) });

/**
 * Stand-in for the gateway's hosted checkout while PAYMENT_PROVIDER=sandbox (local, test
 * and demo environments only — the environment schema forbids sandbox in production).
 * It produces a signed webhook and delivers it through the normal webhook path.
 */
@Controller('sandbox/payments')
@Public()
export class SandboxPaymentController {
  constructor(
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly payments: PaymentService,
  ) {}

  @Post(':orderId')
  @HttpCode(200)
  async simulate(
    @Param('orderId') orderId: string,
    @Body(new ZodPipe(SimulateBody)) body: z.infer<typeof SimulateBody>,
    @RequestMeta() meta: { requestId: string },
  ) {
    if (!(this.provider instanceof SandboxPaymentProvider)) {
      throw new NotFoundError('Route', 'sandbox');
    }
    const webhook =
      body.outcome === 'capture' ? this.provider.capture(orderId) : this.provider.fail(orderId);
    return this.payments.handleWebhook(
      'sandbox',
      Buffer.from(webhook.rawBody),
      webhook.headers,
      meta.requestId,
    );
  }
}
