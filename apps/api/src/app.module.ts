import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { BookingModule } from './booking/booking.module.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health/health.controller.js';
import { NotificationModule } from './notifications/notification.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { PaymentsModule } from './payments/payments.module.js';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    AuthModule,
    NotificationModule,
    BookingModule,
    PaymentsModule,
    JobsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
