import { z } from 'zod';
import {
  ZohoCrmSettingsSchema,
  ZohoDeskSettingsSchema,
} from '../integrations/zoho/zoho-settings.js';

/**
 * Every business setting the platform reads, with its shape. Settings not listed here
 * cannot be written, so a typo can never create a key that nothing reads, and a value
 * that the code could not use is refused at the door rather than failing later.
 */
export const SETTING_SCHEMAS = {
  'invoice.issuer': z
    .object({
      legalName: z.string().trim().min(3).max(200),
      gstin: z
        .string()
        .regex(/^[0-9]{2}[A-Z0-9]{13}$/, 'GSTIN has 15 characters')
        .nullable(),
      address: z.string().trim().min(10).max(500),
      series: z.string().regex(/^[A-Z0-9-]{2,16}$/),
    })
    .strict(),
  'zoho.desk': ZohoDeskSettingsSchema,
  'zoho.crm': ZohoCrmSettingsSchema,
  'documents.retention': z
    .object({ daysAfterOffboarding: z.number().int().min(0).max(3650) })
    .strict(),
} as const satisfies Record<string, z.ZodType>;

export type SettingKey = keyof typeof SETTING_SCHEMAS;

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTING_SCHEMAS, key);
}
