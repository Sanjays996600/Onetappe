import { Module } from '@nestjs/common';
import { BookingModule } from './booking/booking.module.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health/health.controller.js';

@Module({
  imports: [ConfigModule, DatabaseModule, BookingModule],
  controllers: [HealthController],
})
export class AppModule {}
