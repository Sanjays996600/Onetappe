import { z } from 'zod';
import { IsoDate, Uuid } from './common.js';

export const LegalDocumentSchema = z.object({
  id: Uuid,
  code: z.string(),
  version: z.string(),
  locale: z.string(),
  title: z.string(),
  url: z.string(),
  contentSha256: z.string(),
  effectiveFrom: IsoDate,
});
export type LegalDocument = z.infer<typeof LegalDocumentSchema>;

export const ConsentStatusSchema = z.object({
  allAccepted: z.boolean(),
  required: z.array(LegalDocumentSchema.extend({ accepted: z.boolean() })),
  optional: z.array(z.object({ purpose: z.string(), granted: z.boolean() })),
});
export type ConsentStatus = z.infer<typeof ConsentStatusSchema>;
