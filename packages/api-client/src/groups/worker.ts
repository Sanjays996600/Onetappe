import { z } from 'zod';
import type { HttpClient } from '../http.js';
import { NoContent } from '../schemas/common.js';
import { SosSchema, SupportCaseCreatedSchema } from '../schemas/customer.js';
import {
  EarningsSchema,
  JobHistorySchema,
  JobSchema,
  OfferSchema,
  ShiftSchema,
  WorkerProfileSchema,
} from '../schemas/worker.js';

/**
 * The worker app. Job steps are safe to retry: repeating the step you just did (e.g. after
 * losing signal) succeeds without doing it twice, so the client retries them.
 */
export function workerApi(http: HttpClient) {
  const step = (bookingId: string, name: string, body?: object) =>
    http.request(JobSchema, 'POST', `/worker/jobs/${bookingId}/${name}`, {
      body,
      idempotent: true,
    });
  return {
    me: () => http.request(WorkerProfileSchema, 'GET', '/worker/me'),
    registerDevice: (input: {
      platform: 'ANDROID' | 'IOS' | 'WEB';
      pushToken: string;
      appVersion?: string | null;
    }) => http.request(NoContent, 'POST', '/worker/devices', { body: input, idempotent: true }),
    shifts: () => http.request(z.array(ShiftSchema), 'GET', '/worker/me/shifts'),
    setOnline: (online: boolean, position?: { lat: number; lng: number }) =>
      http.request(z.object({ online: z.boolean() }), 'POST', '/worker/me/presence', {
        body: { online, ...(position ?? {}) },
        idempotent: true,
      }),
    offers: () => http.request(z.array(OfferSchema), 'GET', '/worker/offers'),
    accept: (offerId: string) =>
      http.request(JobSchema, 'POST', `/worker/offers/${offerId}/accept`, { idempotent: true }),
    reject: (offerId: string, reason: string) =>
      http.request(NoContent, 'POST', `/worker/offers/${offerId}/reject`, { body: { reason } }),
    currentJob: () => http.request(JobSchema.nullable(), 'GET', '/worker/jobs/current'),
    job: (bookingId: string) => http.request(JobSchema, 'GET', `/worker/jobs/${bookingId}`),
    jobs: () => http.request(JobHistorySchema, 'GET', '/worker/jobs'),
    onTheWay: (bookingId: string) => step(bookingId, 'en-route'),
    arrived: (bookingId: string) => step(bookingId, 'arrived'),
    /** The customer's start code, entered after checking the worker's ID. */
    start: (bookingId: string, code: string) => step(bookingId, 'start', { code }),
    complete: (bookingId: string) => step(bookingId, 'complete'),
    customerNoShow: (bookingId: string, reason: string) =>
      http.request(JobSchema, 'POST', `/worker/jobs/${bookingId}/customer-no-show`, {
        body: { reason },
      }),
    earnings: () => http.request(EarningsSchema, 'GET', '/worker/earnings'),
    openSupportCase: (
      input: { bookingId?: string | null; category: string; subject: string; description: string },
      idempotencyKey: string,
    ) =>
      http.request(SupportCaseCreatedSchema, 'POST', '/worker/support-cases', {
        body: input,
        idempotencyKey,
      }),
    sos: (
      input: { bookingId?: string | null; note?: string; lat?: number | null; lng?: number | null },
      idempotencyKey: string,
    ) => http.request(SosSchema, 'POST', '/worker/sos', { body: input, idempotencyKey }),
  };
}
