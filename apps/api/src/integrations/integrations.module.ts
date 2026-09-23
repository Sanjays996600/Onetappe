import { Module } from '@nestjs/common';
import { SupportModule } from '../support/support.module.js';
import { IntegrationDispatcher } from './integration-dispatcher.service.js';
import { IntegrationMonitor } from './integration-monitor.service.js';
import {
  IntegrationsAdminController,
  ZohoDeskWebhookController,
} from './integrations.controller.js';
import { ZohoAuth } from './zoho/zoho-auth.service.js';
import { ZohoCrmClient } from './zoho/zoho-crm.client.js';
import { ZohoDeskClient } from './zoho/zoho-desk.client.js';
import { ZohoDeskWebhookService } from './zoho/zoho-desk-webhook.service.js';
import { ZohoHttp } from './zoho/zoho-http.js';
import { ZohoSettings } from './zoho/zoho-settings.js';
import { ZohoSyncService } from './zoho/zoho-sync.service.js';

/**
 * The integration boundary. Everything that talks to Zoho lives here; the rest of the
 * application only records outbox events (IntegrationOutbox).
 */
@Module({
  imports: [SupportModule],
  controllers: [IntegrationsAdminController, ZohoDeskWebhookController],
  providers: [
    ZohoAuth,
    ZohoHttp,
    ZohoSettings,
    ZohoDeskClient,
    ZohoCrmClient,
    ZohoSyncService,
    ZohoDeskWebhookService,
    IntegrationDispatcher,
    IntegrationMonitor,
  ],
  exports: [IntegrationDispatcher, IntegrationMonitor],
})
export class IntegrationsModule {}
