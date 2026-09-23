import { z } from 'zod';
import { BookingStatusSchema, IsoDate, Paise, Uuid } from './common.js';

export const CustomerProfileSchema = z.object({
  id: Uuid,
  fullName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string(),
  preferredLocale: z.string(),
  marketingOptIn: z.boolean(),
  profileComplete: z.boolean(),
  addressCount: z.number().int(),
});
export type CustomerProfile = z.infer<typeof CustomerProfileSchema>;

export const ServiceabilitySchema = z.object({
  serviceable: z.boolean(),
  cityId: Uuid.nullable().optional(),
  zoneId: Uuid.nullable().optional(),
});
export type Serviceability = z.infer<typeof ServiceabilitySchema>;

export const AddressSchema = z.object({
  id: Uuid,
  label: z.string(),
  contactName: z.string(),
  contactPhone: z.string(),
  houseNumber: z.string(),
  building: z.string().nullable(),
  street: z.string().nullable(),
  landmark: z.string().nullable(),
  pincode: z.string(),
  cityName: z.string(),
  lat: z.number(),
  lng: z.number(),
  accessNotes: z.string().nullable(),
  isDefault: z.boolean(),
  serviceable: z.boolean(),
});
export type Address = z.infer<typeof AddressSchema>;

export interface NewAddress {
  label?: string;
  contactName: string;
  contactPhone: string;
  houseNumber: string;
  building?: string | null;
  street?: string | null;
  landmark?: string | null;
  pincode: string;
  cityName: string;
  lat: number;
  lng: number;
  accessNotes?: string | null;
}

export const CatalogServiceSchema = z.object({
  id: Uuid,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  durationMinutes: z.number().int(),
  supportsInstant: z.boolean(),
  supportsScheduled: z.boolean(),
  fromPricePaise: Paise.nullable(),
});
export const CatalogSchema = z.object({
  serviceable: z.boolean(),
  categories: z.array(
    z.object({ id: Uuid, name: z.string(), services: z.array(CatalogServiceSchema) }),
  ),
});
export type Catalog = z.infer<typeof CatalogSchema>;
export type CatalogService = z.infer<typeof CatalogServiceSchema>;

export const ServiceDetailSchema = CatalogServiceSchema.omit({ fromPricePaise: true }).extend({
  minLeadTimeMinutes: z.number().int(),
  maxAdvanceDays: z.number().int(),
  options: z.array(z.object({ id: Uuid, name: z.string() }).loose()),
  tasks: z.array(
    z.object({
      id: Uuid,
      code: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      selectedByDefault: z.boolean(),
    }),
  ),
});
export type ServiceDetail = z.infer<typeof ServiceDetailSchema>;

export const AvailabilitySchema = z.object({ date: z.string(), slots: z.array(IsoDate) });

const PriceLine = z.object({
  type: z.string(),
  code: z.string(),
  label: z.string(),
  amountPaise: Paise,
});

export const QuoteSchema = z.object({
  startAt: IsoDate,
  currency: z.literal('INR'),
  lines: z.array(PriceLine),
  subtotalPaise: Paise,
  discountPaise: Paise,
  taxPaise: Paise,
  totalPaise: Paise,
});
export type Quote = z.infer<typeof QuoteSchema>;

const Period = z.object({ start: IsoDate, end: IsoDate });

export const CustomerBookingSchema = z.object({
  id: Uuid,
  bookingCode: z.string(),
  status: BookingStatusSchema,
  bookingType: z.enum(['INSTANT', 'SCHEDULED']),
  service: z.object({ id: Uuid, name: z.string() }),
  schedule: z.object({ original: Period, current: Period, rescheduleCount: z.number().int() }),
  address: z
    .object({
      houseNumber: z.string(),
      building: z.string().nullable(),
      street: z.string().nullable(),
      landmark: z.string().nullable(),
      pincode: z.string(),
      cityName: z.string(),
      lat: z.number(),
      lng: z.number(),
    })
    .loose(),
  price: z.object({
    currency: z.string(),
    lines: z.array(PriceLine),
    subtotalPaise: Paise,
    discountPaise: Paise,
    taxPaise: Paise,
    totalPaise: Paise,
  }),
  payment: z.object({ mode: z.string(), status: z.string(), payBy: IsoDate.nullable() }),
  worker: z.object({ firstName: z.string().nullable(), workerCode: z.string() }).nullable(),
  tasks: z.array(z.object({ name: z.string(), priority: z.number().int(), status: z.string() })),
  rating: z.object({ score: z.number().int(), comment: z.string().nullable() }).nullable(),
  actions: z.object({
    canPay: z.boolean(),
    canCancel: z.boolean(),
    canReschedule: z.boolean(),
    canViewStartCode: z.boolean(),
    canRate: z.boolean(),
  }),
  createdAt: IsoDate,
});
export type CustomerBooking = z.infer<typeof CustomerBookingSchema>;

export const CreatedBookingSchema = CustomerBookingSchema.extend({ replayed: z.boolean() });

export const BookingListSchema = z.object({
  items: z.array(
    z.object({
      id: Uuid,
      bookingCode: z.string(),
      status: BookingStatusSchema,
      serviceName: z.string(),
      scheduledStart: IsoDate,
      scheduledEnd: IsoDate,
      totalPaise: Paise,
    }),
  ),
  nextBefore: IsoDate.nullable(),
});
export type BookingList = z.infer<typeof BookingListSchema>;

export const PaymentStartSchema = z.object({
  paymentId: Uuid,
  provider: z.string(),
  amountPaise: Paise,
  payBy: IsoDate,
  /** Provider-specific checkout parameters (Razorpay order id and key, or the sandbox order). */
  checkout: z.object({ provider: z.string(), orderId: z.string() }).loose(),
});
export type PaymentStart = z.infer<typeof PaymentStartSchema>;

export const PaymentRefreshSchema = z.object({
  paymentStatus: z.string(),
  booking: CustomerBookingSchema,
});

export const StartCodeSchema = z.object({ code: z.string(), guidance: z.string() });

export const InvoiceSchema = z.object({
  invoiceNumber: z.string(),
  issuedAt: IsoDate,
  issuer: z.object({ legalName: z.string(), gstin: z.string().nullable(), address: z.string() }),
  billedTo: z.object({ name: z.string().nullable(), address: z.string() }),
  lines: z.array(PriceLine),
  subtotalPaise: Paise,
  discountPaise: Paise,
  taxPaise: Paise,
  totalPaise: Paise,
  currency: z.string(),
});
export type Invoice = z.infer<typeof InvoiceSchema>;

export const TimelineSchema = z.object({
  statuses: z.array(
    z.object({ from: z.string().nullable(), to: z.string(), event: z.string(), at: IsoDate }),
  ),
  scheduleChanges: z.array(z.object({ at: IsoDate }).loose()),
});

export const CancelResultSchema = z.object({ booking: CustomerBookingSchema }).loose();

export const SupportCaseCreatedSchema = z.object({
  id: Uuid,
  caseCode: z.string(),
  status: z.string(),
  nextUpdateDueAt: IsoDate.nullable(),
  replayed: z.boolean(),
});
export const SupportCaseSchema = z.object({
  id: Uuid,
  caseCode: z.string(),
  bookingId: Uuid.nullable(),
  category: z.string(),
  subject: z.string(),
  status: z.string(),
  openedAt: IsoDate,
  resolution: z.string().nullable(),
});
export type SupportCase = z.infer<typeof SupportCaseSchema>;

export const SosSchema = z.object({
  id: Uuid,
  incidentCode: z.string(),
  severity: z.string(),
  status: z.string(),
  replayed: z.boolean(),
});

export const InboxItemSchema = z.object({
  id: Uuid,
  event: z.string(),
  bookingId: Uuid.nullable(),
  title: z.string().nullable(),
  body: z.string(),
  createdAt: IsoDate,
  read: z.boolean(),
});
export type InboxItem = z.infer<typeof InboxItemSchema>;
