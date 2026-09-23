import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { SupportModule } from '../support/support.module.js';
import { JobRunner } from './job-runner.service.js';

@Module({
  imports: [BookingModule, PaymentsModule, IntegrationsModule, SupportModule],
  providers: [JobRunner],
  exports: [JobRunner],
})
export class JobsModule {}
