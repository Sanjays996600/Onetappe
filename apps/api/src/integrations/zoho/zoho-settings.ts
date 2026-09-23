import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { DATABASE } from '../../database/database.module.js';
import type { DB } from '../../database/db.generated.js';

const SUPPORT_STATUS = z.enum(['OPEN', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED']);
/** Zoho Desk custom-field API names look like `cf_onetappe_case_code`. */
const DESK_FIELD = z.string().regex(/^cf_[a-z0-9_]{1,60}$/);

/**
 * business_setting['zoho.desk']: how cases become tickets. Set by an administrator in the
 * admin panel after creating the matching department and custom fields in Zoho Desk.
 */
export const ZohoDeskSettingsSchema = z.object({
  departmentId: z.string().regex(/^\d{1,30}$/),
  fields: z.object({
    /** Required: our case code, used to find a ticket again after a lost response. */
    caseCode: DESK_FIELD,
    bookingCode: DESK_FIELD.optional(),
    customerId: DESK_FIELD.optional(),
    category: DESK_FIELD.optional(),
    service: DESK_FIELD.optional(),
    raisedBy: DESK_FIELD.optional(),
  }),
  priorityBySeverity: z
    .object({ LOW: z.string(), MEDIUM: z.string(), HIGH: z.string() })
    .default({ LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High' }),
  /** Desk status name → One Tappe case status. Unlisted names fall back to the status type. */
  statusMap: z.record(z.string(), SUPPORT_STATUS).default({}),
  /** Also open a reference ticket (no narrative) for safety escalations. */
  safetyTickets: z.boolean().default(false),
});
export type ZohoDeskSettings = z.infer<typeof ZohoDeskSettingsSchema>;

const CRM_FIELD = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{1,60}$/);

/** business_setting['zoho.crm']: what is mirrored into Zoho CRM. */
export const ZohoCrmSettingsSchema = z.object({
  /** Unique custom field on Contacts holding our customer id (upsert key). */
  contactIdField: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{1,60}$/),
  /** Custom module for bookings (e.g. "Bookings"); null = bookings are not mirrored. */
  bookingModule: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_]{1,60}$/)
    .nullable()
    .default(null),
  bookingCodeField: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_]{1,60}$/)
    .default('OneTappe_Booking_Code'),
  /** CRM field API names in the booking module; unmapped values are not sent. */
  bookingFields: z
    .object({
      status: CRM_FIELD.optional(),
      scheduledStart: CRM_FIELD.optional(),
      amount: CRM_FIELD.optional(),
      service: CRM_FIELD.optional(),
      city: CRM_FIELD.optional(),
      contactLookup: CRM_FIELD.optional(),
    })
    .default({}),
});
export type ZohoCrmSettings = z.infer<typeof ZohoCrmSettingsSchema>;

export const ZOHO_SETTING_KEYS = { desk: 'zoho.desk', crm: 'zoho.crm' } as const;

/** The integration cannot run until an administrator fixes its configuration. */
export class ZohoConfigurationError extends Error {
  override readonly name = 'ZohoConfigurationError';
}

@Injectable()
export class ZohoSettings {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  desk(): Promise<ZohoDeskSettings> {
    return this.read(ZOHO_SETTING_KEYS.desk, ZohoDeskSettingsSchema);
  }

  crm(): Promise<ZohoCrmSettings> {
    return this.read(ZOHO_SETTING_KEYS.crm, ZohoCrmSettingsSchema);
  }

  private async read<T>(key: string, schema: z.ZodType<T>): Promise<T> {
    const row = await this.db
      .selectFrom('business_setting')
      .select('value')
      .where('key', '=', key)
      .executeTakeFirst();
    if (!row) throw new ZohoConfigurationError(`Setting ${key} is not configured`);
    const parsed = schema.safeParse(row.value);
    if (!parsed.success) {
      throw new ZohoConfigurationError(
        `Setting ${key} is invalid: ${z.prettifyError(parsed.error)}`,
      );
    }
    return parsed.data;
  }
}
