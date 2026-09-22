import { Injectable } from '@nestjs/common';

/** Injectable time source so business rules can be tested at fixed instants. */
@Injectable()
export class Clock {
  now(): Date {
    return new Date();
  }
}
