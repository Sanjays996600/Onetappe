import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { SupportModule } from '../support/support.module.js';
import { WorkerModule } from '../worker/worker.module.js';
import { AdminBookingController } from './admin-booking.controller.js';
import { AdminBookingService } from './admin-booking.service.js';
import { AdminOperationsController } from './admin-operations.controller.js';
import { AdminPeopleController } from './admin-people.controller.js';
import { AdminPeopleService } from './admin-people.service.js';

@Module({
  imports: [BookingModule, PaymentsModule, SupportModule, WorkerModule],
  controllers: [AdminBookingController, AdminPeopleController, AdminOperationsController],
  providers: [AdminBookingService, AdminPeopleService],
})
export class AdminModule {}
