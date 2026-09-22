import { Module } from '@nestjs/common';
import { Clock } from '../common/clock.js';
import { PricingService } from '../pricing/pricing.service.js';
import { ServiceabilityService } from '../service-area/serviceability.service.js';
import { BookingCreationService } from './booking-creation.service.js';
import { BookingLifecycleService } from './booking-lifecycle.service.js';
import { BookingTransitionService } from './booking-transition.service.js';
import { CapacityService } from './capacity.service.js';
import { DispatchService } from './dispatch.service.js';
import { VerificationCodeService } from './verification-code.service.js';

/** The booking engine: creation, capacity, dispatch and lifecycle. */
@Module({
  providers: [
    Clock,
    ServiceabilityService,
    PricingService,
    BookingTransitionService,
    CapacityService,
    DispatchService,
    VerificationCodeService,
    BookingCreationService,
    BookingLifecycleService,
  ],
  exports: [
    BookingCreationService,
    BookingLifecycleService,
    DispatchService,
    VerificationCodeService,
  ],
})
export class BookingModule {}
