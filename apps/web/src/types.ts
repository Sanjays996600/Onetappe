export type Locale = 'en' | 'hi';
export interface Tokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  sessionExpiresAt: string;
}
export interface Profile {
  id: string;
  fullName: string | null;
  phone: string;
  preferredLocale: Locale;
  profileComplete: boolean;
}
export interface Address {
  id: string;
  label: string;
  contactName: string;
  contactPhone: string;
  houseNumber: string;
  building: string | null;
  street: string | null;
  cityName: string;
  pincode: string;
  lat: number;
  lng: number;
}
export interface Service {
  id: string;
  code: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  supportsInstant: boolean;
  supportsScheduled: boolean;
  fromPricePaise: number;
}
export interface ServiceDetail extends Service {
  options: { id: string; name: string; durationMinutes: number; isDefault: boolean }[];
  tasks: { id: string; name: string; description: string | null; selectedByDefault: boolean }[];
}
export interface Catalog {
  serviceable: boolean;
  categories: { id: string; name: string; services: Service[] }[];
}
export interface Quote {
  startAt: string;
  totalPaise: number;
  subtotalPaise: number;
  discountPaise: number;
  taxPaise: number;
  lines: { code: string; label: string; amountPaise: number }[];
}
export interface BookingSummary {
  id: string;
  bookingCode: string;
  status: string;
  serviceName: string;
  scheduledStart: string;
  scheduledEnd: string;
  totalPaise: number;
}
export interface Booking {
  id: string;
  bookingCode: string;
  status: string;
  service: { id: string; name: string };
  schedule: {
    original: { start: string; end: string };
    current: { start: string; end: string };
    rescheduleCount: number;
  };
  price: Quote;
  payment: { status: string; payBy: string | null };
  worker: { firstName: string | null; workerCode: string } | null;
  actions: {
    canPay: boolean;
    canCancel: boolean;
    canReschedule: boolean;
    canViewStartCode: boolean;
    canRate: boolean;
  };
  tasks: { name: string; priority: number; status: string }[];
}
export interface Payment {
  paymentId: string;
  provider: string;
  payBy: string;
  checkout: {
    keyId?: string;
    orderId?: string;
    amount?: number;
    currency?: string;
    name?: string;
    description?: string;
  };
}
export interface Invoice {
  invoiceNumber: string;
  issuedAt: string;
  issuer: { legalName: string; gstin: string | null; address: unknown };
  billedTo: { name: string; address: unknown };
  lines: { type: string; code: string; label: string; amountPaise: number }[];
  subtotalPaise: number;
  discountPaise: number;
  taxPaise: number;
  totalPaise: number;
}
export interface SupportCase {
  id: string;
  caseCode?: string;
  resolution?: string | null;
  subject: string;
  status: string;
}
