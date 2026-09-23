import { Global, Module } from '@nestjs/common';
import { IntegrationOutbox } from './integration-outbox.service.js';

/** The outbox has no dependencies, so any module can record integration events. */
@Global()
@Module({ providers: [IntegrationOutbox], exports: [IntegrationOutbox] })
export class IntegrationOutboxModule {}
