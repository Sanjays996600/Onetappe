import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module.js';
import { AvailabilityService } from '../catalog/availability.service.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { TranslationService } from '../i18n/translation.service.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { SupportModule } from '../support/support.module.js';
import { CustomerController } from './customer.controller.js';
import { CustomerService } from './customer.service.js';
import { DeviceService } from './device.service.js';

@Module({
  imports: [BookingModule, PaymentsModule, SupportModule],
  controllers: [CustomerController],
  providers: [
    CustomerService,
    DeviceService,
    CatalogService,
    AvailabilityService,
    TranslationService,
  ],
  exports: [DeviceService],
})
export class CustomerModule {}
