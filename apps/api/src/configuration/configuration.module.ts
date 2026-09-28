import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module.js';
import { CatalogConfigController } from './catalog-config.controller.js';
import { NotificationConfigController } from './notification-config.controller.js';
import { PricingConfigController } from './pricing-config.controller.js';
import { PromotionConfigController } from './promotion-config.controller.js';
import { ServiceAreaConfigController } from './service-area-config.controller.js';
import { WorkerRequirementConfigController } from './worker-requirement-config.controller.js';
import { WorkerRequirementService } from './worker-requirement.service.js';

/**
 * Admin configuration of business data: areas and hours, catalogue, prices/taxes/payouts/
 * cancellation rules, promotions, notifications and worker requirements. Operations never edit PostgreSQL by
 * hand; every change goes through these endpoints with a permission, a reason and an
 * audit record, and the database refuses rewrites of money history.
 */
@Module({
  imports: [BookingModule],
  controllers: [
    ServiceAreaConfigController,
    CatalogConfigController,
    PricingConfigController,
    PromotionConfigController,
    NotificationConfigController,
    WorkerRequirementConfigController,
  ],
  providers: [WorkerRequirementService],
})
export class ConfigurationModule {}
