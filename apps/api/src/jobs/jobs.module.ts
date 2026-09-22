import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { JobRunner } from './job-runner.service.js';

@Module({
  imports: [BookingModule, PaymentsModule],
  providers: [JobRunner],
  exports: [JobRunner],
})
export class JobsModule {}
