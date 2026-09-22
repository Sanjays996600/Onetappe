import { Module } from '@nestjs/common';
import { AdminModule } from './admin/admin.module.js';
import { AuthModule } from './auth/auth.module.js';
import { BookingModule } from './booking/booking.module.js';
import { ConfigModule } from './config/config.module.js';
import { CustomerModule } from './customer/customer.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health/health.controller.js';
import { JobsModule } from './jobs/jobs.module.js';
import { NotificationModule } from './notifications/notification.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { StorageModule } from './storage/storage.module.js';
import { WorkerModule } from './worker/worker.module.js';

@Module({
  imports: [
    // Infrastructure
    ConfigModule,
    DatabaseModule,
    AuthModule,
    NotificationModule,
    StorageModule,
    // Core engine
    BookingModule,
    PaymentsModule,
    JobsModule,
    // Client APIs
    CustomerModule,
    WorkerModule,
    AdminModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
