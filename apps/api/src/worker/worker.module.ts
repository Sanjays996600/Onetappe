import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module.js';
import { CustomerModule } from '../customer/customer.module.js';
import { SupportModule } from '../support/support.module.js';
import { WorkerOnboardingService } from './worker-onboarding.service.js';
import { WorkerController } from './worker.controller.js';
import { WorkerService } from './worker.service.js';
import { LegalModule } from '../legal/legal.module.js';

@Module({
  imports: [BookingModule, SupportModule, CustomerModule, LegalModule],
  controllers: [WorkerController],
  providers: [WorkerService, WorkerOnboardingService],
  exports: [WorkerOnboardingService],
})
export class WorkerModule {}
