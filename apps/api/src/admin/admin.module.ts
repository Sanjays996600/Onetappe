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
import { BookingTraceService } from './booking-trace.service.js';
import { SystemStatusService } from './system-status.service.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { JobsModule } from '../jobs/jobs.module.js';

import { StaffAdminController } from './staff-admin.controller.js';
import { StaffAdminService } from './staff-admin.service.js';
@Module({
  imports: [
    BookingModule,
    PaymentsModule,
    SupportModule,
    WorkerModule,
    JobsModule,
    IntegrationsModule,
  ],
  controllers: [
    AdminBookingController,
    AdminPeopleController,
    AdminOperationsController,
    StaffAdminController,
  ],
  providers: [
    AdminBookingService,
    AdminPeopleService,
    BookingTraceService,
    StaffAdminService,
    SystemStatusService,
  ],
})
export class AdminModule {}
