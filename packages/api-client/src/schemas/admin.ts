import { z } from 'zod';
import { BookingStatusSchema, IsoDate, Paise, Uuid } from './common.js';

export const StaffMeSchema = z.object({
  id: Uuid,
  email: z.string().nullable(),
  fullName: z.string().nullable(),
  locale: z.string(),
  roles: z.array(z.string()),
  /** Permission → 'ALL' cities or the list of city ids. */
  permissions: z.record(z.string(), z.union([z.literal('ALL'), z.array(Uuid)])),
  mfaVerifiedAt: IsoDate.nullable(),
});
export type StaffMe = z.infer<typeof StaffMeSchema>;

export const BookingRowSchema = z.object({
  id: Uuid,
  bookingCode: z.string(),
  status: BookingStatusSchema,
  source: z.string(),
  service: z.string(),
  locality: z.string(),
  pincode: z.string(),
  scheduledStart: IsoDate,
  originalStart: IsoDate,
  totalPaise: Paise,
  customer: z.object({ name: z.string().nullable(), phone: z.string().nullable() }),
});
export type BookingRow = z.infer<typeof BookingRowSchema>;

const Period = z.object({ start: IsoDate, end: IsoDate });

export const AdminBookingSchema = z.object({
  id: Uuid,
  bookingCode: z.string(),
  status: BookingStatusSchema,
  version: z.number().int(),
  source: z.string(),
  bookingType: z.enum(['INSTANT', 'SCHEDULED']),
  service: z.string(),
  cityId: Uuid,
  locality: z.string(),
  schedule: z.object({ original: Period, current: Period, rescheduleCount: z.number().int() }),
  customer: z.object({ id: Uuid, name: z.string().nullable(), phone: z.string().nullable() }),
  address: z.object({
    locality: z.string(),
    pincode: z.unknown(),
    cityName: z.unknown(),
  }),
  totalPaise: Paise,
  paymentMode: z.string(),
  timeline: z.array(
    z.object({
      from: z.string().nullable(),
      to: z.string(),
      event: z.string(),
      source: z.string(),
      actor: z
        .object({ id: Uuid, name: z.string().nullable(), role: z.string().nullable() })
        .nullable(),
      reason: z.string().nullable(),
      at: IsoDate,
    }),
  ),
  scheduleChanges: z.array(
    z.object({
      from: Period,
      to: Period,
      source: z.string(),
      actorUserId: Uuid.nullable(),
      reason: z.string().nullable(),
      at: IsoDate,
    }),
  ),
  assignments: z.array(
    z.object({
      id: Uuid,
      worker: z.object({ code: z.string(), name: z.string().nullable() }),
      status: z.string(),
      crewSlot: z.number().int(),
      offeredAt: IsoDate,
      offerExpiresAt: IsoDate,
      respondedAt: IsoDate.nullable(),
      responseReason: z.string().nullable(),
      endedAt: IsoDate.nullable(),
      endReason: z.string().nullable(),
      source: z.string(),
    }),
  ),
  payments: z.array(
    z.object({
      id: Uuid,
      status: z.string(),
      provider: z.string().optional(),
      amountPaise: Paise.optional(),
      isDuplicate: z.boolean().optional(),
      failureReason: z.string().nullable().optional(),
    }),
  ),
  refunds: z
    .array(
      z.object({
        id: Uuid,
        status: z.string(),
        amountPaise: Paise,
        reasonCode: z.string(),
        decisionPolicy: z.string().nullable(),
      }),
    )
    .nullable(),
});
export type AdminBooking = z.infer<typeof AdminBookingSchema>;

export const TraceSchema = z.object({
  booking: z.object({
    id: Uuid,
    bookingCode: z.string(),
    status: BookingStatusSchema,
    source: z.string(),
    customerId: Uuid,
    scheduledStart: IsoDate,
    originalScheduledStart: IsoDate,
    createdAt: IsoDate,
  }),
  entries: z.array(
    z.object({
      at: IsoDate,
      area: z.string(),
      what: z.string(),
      detail: z.record(z.string(), z.unknown()),
      requestId: z.string().nullable(),
    }),
  ),
});
export type BookingTrace = z.infer<typeof TraceSchema>;

export const SystemStatusSchema = z.object({
  checkedAt: IsoDate,
  database: z.object({ ok: z.boolean(), latencyMs: z.number() }),
  jobs: z.array(
    z.object({
      name: z.string(),
      intervalSeconds: z.number(),
      lastStartedAt: IsoDate.nullable(),
      lastSucceededAt: IsoDate.nullable(),
      failuresLastHour: z.number().int(),
      stale: z.boolean(),
    }),
  ),
  backlog: z.array(
    z.object({
      queue: z.string(),
      state: z.string(),
      count: z.number().int(),
      oldestWaitingSeconds: z.number().nullable(),
    }),
  ),
  integrations: z.unknown(),
  alerts: z.array(
    z.object({ severity: z.enum(['critical', 'warning']), code: z.string(), message: z.string() }),
  ),
});
export type SystemStatus = z.infer<typeof SystemStatusSchema>;

/** Most intervention responses: the booking after the change (some wrap it). */
export const InterventionSchema = z.union([
  AdminBookingSchema,
  z.object({ booking: AdminBookingSchema }).loose(),
]);
