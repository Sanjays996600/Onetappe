import { z } from 'zod';
import { BookingStatusSchema, IsoDate, Paise, Uuid } from './common.js';

export const WorkerProfileSchema = z.object({
  id: Uuid,
  workerCode: z.string(),
  status: z.string(),
  statusReason: z.string().nullable(),
  canWork: z.boolean(),
  /** Receiving offers (the worker's own switch; off after a suspension). */
  online: z.boolean(),
  fullName: z.string().nullable(),
  phone: z.string(),
  preferredLocale: z.string(),
  onboarding: z.object({
    status: z.string(),
    profileComplete: z.boolean(),
    documentsRequired: z.array(z.string()),
    documentsSubmitted: z.array(z.string()),
    verificationsRequired: z.array(z.string()),
    verificationsVerified: z.array(z.string()),
    verificationsRejected: z.array(z.string()),
    trainingRequired: z.array(z.string()),
    trainingPassed: z.array(z.string()),
    awaitingStaffDecision: z.boolean(),
  }),
});
export type WorkerProfile = z.infer<typeof WorkerProfileSchema>;

export const ShiftSchema = z.object({ start: IsoDate, end: IsoDate, zone: z.string() });

export const OfferSchema = z.object({
  offerId: Uuid,
  bookingId: Uuid,
  service: z.string(),
  locality: z.string(),
  pincode: z.string(),
  start: IsoDate,
  end: IsoDate,
  expiresAt: IsoDate,
  estimatedPayoutPaise: Paise,
});
export type Offer = z.infer<typeof OfferSchema>;

export const JobSchema = z.object({
  bookingId: Uuid,
  bookingCode: z.string(),
  status: BookingStatusSchema,
  service: z.string(),
  start: IsoDate,
  end: IsoDate,
  customerFirstName: z.string().nullable(),
  address: z.object({
    houseNumber: z.unknown(),
    building: z.unknown(),
    street: z.unknown(),
    landmark: z.unknown(),
    pincode: z.unknown(),
    cityName: z.unknown(),
    lat: z.number(),
    lng: z.number(),
    accessNotes: z.unknown(),
    /** Only while the job is active. */
    contactPhone: z.string().nullable(),
  }),
  notes: z.string().nullable(),
  tasks: z.array(z.object({ name: z.string(), priority: z.number().int(), status: z.string() })),
});
export type Job = z.infer<typeof JobSchema>;

export const JobHistorySchema = z.array(
  z.object({
    bookingId: Uuid,
    bookingCode: z.string(),
    status: BookingStatusSchema,
    assignment: z.string(),
    service: z.string(),
    locality: z.string(),
    start: IsoDate,
  }),
);

export const EarningsSchema = z.object({
  totalsPaise: z.record(z.string(), Paise),
  items: z.array(
    z.object({
      id: Uuid,
      type: z.string(),
      amountPaise: Paise,
      status: z.string(),
      description: z.string().nullable(),
      bookingCode: z.string().nullable(),
      createdAt: IsoDate,
    }),
  ),
});
export type Earnings = z.infer<typeof EarningsSchema>;
