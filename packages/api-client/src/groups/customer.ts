import { z } from 'zod';
import type { HttpClient } from '../http.js';
import { NoContent } from '../schemas/common.js';
import {
  AddressSchema,
  AvailabilitySchema,
  BookingListSchema,
  CancelResultSchema,
  CatalogSchema,
  CreatedBookingSchema,
  CustomerBookingSchema,
  CustomerProfileSchema,
  InboxItemSchema,
  InvoiceSchema,
  PaymentRefreshSchema,
  PaymentStartSchema,
  QuoteSchema,
  ServiceDetailSchema,
  ServiceabilitySchema,
  SosSchema,
  StartCodeSchema,
  SupportCaseCreatedSchema,
  SupportCaseSchema,
  TimelineSchema,
  type NewAddress,
} from '../schemas/customer.js';

export interface QuoteRequest {
  serviceId: string;
  serviceOptionId?: string | null;
  addressId: string;
  bookingType: 'INSTANT' | 'SCHEDULED';
  startAt: string | null;
  promoCode?: string | null;
}

export interface Location {
  pincode: string;
  lat: number;
  lng: number;
  locale?: 'en' | 'hi';
}

/**
 * The customer app. Creating calls take an idempotency key: keep the same key while the
 * person retries the same action (a lost response then returns the original result).
 */
export function customerApi(http: HttpClient) {
  return {
    me: () => http.request(CustomerProfileSchema, 'GET', '/customer/me'),
    updateMe: (input: {
      fullName?: string;
      email?: string | null;
      preferredLocale?: 'en' | 'hi';
    }) => http.request(CustomerProfileSchema, 'PATCH', '/customer/me', { body: input }),
    registerDevice: (input: {
      platform: 'ANDROID' | 'IOS' | 'WEB';
      pushToken: string;
      appVersion?: string | null;
    }) => http.request(NoContent, 'POST', '/customer/devices', { body: input, idempotent: true }),
    addresses: () => http.request(z.array(AddressSchema), 'GET', '/customer/addresses'),
    addAddress: (input: NewAddress, idempotencyKey: string) =>
      http.request(AddressSchema, 'POST', '/customer/addresses', { body: input, idempotencyKey }),
    archiveAddress: (id: string) =>
      http.request(NoContent, 'POST', `/customer/addresses/${id}/archive`, { idempotent: true }),
    serviceability: (location: Location) =>
      http.request(ServiceabilitySchema, 'GET', '/customer/serviceability', {
        query: { ...location },
      }),
    catalog: (location: Location) =>
      http.request(CatalogSchema, 'GET', '/customer/catalog', { query: { ...location } }),
    service: (id: string) => http.request(ServiceDetailSchema, 'GET', `/customer/services/${id}`),
    availability: (input: { serviceId: string; addressId: string; date: string }) =>
      http.request(AvailabilitySchema, 'GET', '/customer/availability', { query: { ...input } }),
    quote: (input: QuoteRequest) =>
      http.request(QuoteSchema, 'POST', '/customer/quotes', { body: input, idempotent: true }),
    book: (
      input: QuoteRequest & {
        taskIds?: string[] | null;
        notes?: string | null;
        /** The total the person saw; the booking is refused if the price changed. */
        expectedTotalPaise: number;
      },
      idempotencyKey: string,
    ) =>
      http.request(CreatedBookingSchema, 'POST', '/customer/bookings', {
        body: input,
        idempotencyKey,
      }),
    bookings: (input: { limit?: number; before?: string } = {}) =>
      http.request(BookingListSchema, 'GET', '/customer/bookings', { query: { ...input } }),
    booking: (id: string) => http.request(CustomerBookingSchema, 'GET', `/customer/bookings/${id}`),
    timeline: (id: string) =>
      http.request(TimelineSchema, 'GET', `/customer/bookings/${id}/timeline`),
    /** Starts (or reuses) the gateway order for a booking awaiting payment. */
    startPayment: (id: string) =>
      http.request(PaymentStartSchema, 'POST', `/customer/bookings/${id}/payments`, {
        idempotent: true,
      }),
    /** "I have paid": the server asks the gateway; the app's word is never enough. */
    refreshPayment: (id: string, paymentId: string) =>
      http.request(
        PaymentRefreshSchema,
        'POST',
        `/customer/bookings/${id}/payments/${paymentId}/refresh`,
        {
          idempotent: true,
        },
      ),
    cancel: (id: string, reason: string) =>
      http.request(CancelResultSchema, 'POST', `/customer/bookings/${id}/cancel`, {
        body: { reason },
      }),
    reschedule: (id: string, input: { startAt: string; reason: string }) =>
      http.request(CustomerBookingSchema, 'POST', `/customer/bookings/${id}/reschedule`, {
        body: input,
      }),
    startCode: (id: string) =>
      http.request(StartCodeSchema, 'GET', `/customer/bookings/${id}/start-code`),
    invoice: (id: string) => http.request(InvoiceSchema, 'GET', `/customer/bookings/${id}/invoice`),
    rate: (id: string, input: { score: number; comment?: string | null }) =>
      http.request(NoContent, 'POST', `/customer/bookings/${id}/rating`, { body: input }),
    openSupportCase: (
      input: {
        bookingId?: string | null;
        category: string;
        subject: string;
        description: string;
        desiredResolution?: string | null;
      },
      idempotencyKey: string,
    ) =>
      http.request(SupportCaseCreatedSchema, 'POST', '/customer/support-cases', {
        body: input,
        idempotencyKey,
      }),
    supportCases: () => http.request(z.array(SupportCaseSchema), 'GET', '/customer/support-cases'),
    sos: (
      input: { bookingId?: string | null; note?: string; lat?: number | null; lng?: number | null },
      idempotencyKey: string,
    ) => http.request(SosSchema, 'POST', '/customer/sos', { body: input, idempotencyKey }),
    inbox: () => http.request(z.array(InboxItemSchema), 'GET', '/customer/notifications'),
  };
}
