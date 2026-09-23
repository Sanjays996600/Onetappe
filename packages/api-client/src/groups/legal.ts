import { z } from 'zod';
import type { HttpClient } from '../http.js';
import { NoContent } from '../schemas/common.js';
import { ConsentStatusSchema, LegalDocumentSchema } from '../schemas/legal.js';

/** Terms, privacy notice and consent choices (customer and worker apps). */
export function legalApi(http: HttpClient) {
  return {
    /** The documents in force, shown before sign-up. */
    documents: (app: 'CUSTOMER_APP' | 'WORKER_APP', locale?: 'en' | 'hi') =>
      http.request(z.array(LegalDocumentSchema), 'GET', '/legal/documents', {
        query: { app, locale },
        anonymous: true,
      }),
    status: (locale?: 'en' | 'hi') =>
      http.request(ConsentStatusSchema, 'GET', '/me/consents', { query: { locale } }),
    accept: (documentIds: string[]) =>
      http.request(NoContent, 'POST', '/me/consents/accept', {
        body: { documentIds },
        idempotent: true,
      }),
    choose: (purpose: string, granted: boolean) =>
      http.request(NoContent, 'POST', `/me/consents/${purpose}`, {
        body: { granted },
        idempotent: true,
      }),
  };
}
