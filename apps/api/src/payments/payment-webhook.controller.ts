import { Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Public, RequestMeta } from '../auth/decorators.js';
import { PaymentService } from './payment.service.js';

/**
 * Gateway webhooks. Public (the gateway has no user token) but every call is verified by
 * signature over the raw body. Returns 200 for duplicates so the gateway stops retrying,
 * and a non-2xx only when processing failed and should be retried.
 */
@Controller('payments/webhooks')
@Public()
export class PaymentWebhookController {
  constructor(private readonly payments: PaymentService) {}

  @Post(':provider')
  @HttpCode(200)
  async receive(
    @Param('provider') provider: string,
    @Req() request: RawBodyRequest<FastifyRequest>,
    @RequestMeta() meta: { requestId: string },
  ) {
    const headers: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
    }
    return this.payments.handleWebhook(provider, request.rawBody, headers, meta.requestId);
  }
}
