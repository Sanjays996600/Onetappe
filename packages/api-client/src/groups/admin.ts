import { z } from 'zod';
import type { HttpClient } from '../http.js';
import {
  AdminBookingSchema,
  BookingRowSchema,
  InterventionSchema,
  StaffMeSchema,
  SystemStatusSchema,
  TraceSchema,
} from '../schemas/admin.js';
import type { BookingStatus } from '@onetappe/domain';

/** Every change to a booking says why, and which version the staff member was looking at. */
export interface Change {
  readonly reason: string;
  readonly expectedVersion: number;
}

export function adminApi(http: HttpClient) {
  const act = (id: string, action: string, body: object) =>
    http.request(InterventionSchema, 'POST', `/admin/bookings/${id}/${action}`, { body });
  return {
    me: () => http.request(StaffMeSchema, 'GET', '/admin/me'),
    systemStatus: () => http.request(SystemStatusSchema, 'GET', '/admin/system/status'),
    bookings: {
      search: (
        filter: {
          status?: BookingStatus;
          code?: string;
          from?: string;
          to?: string;
          limit?: number;
        } = {},
      ) => http.request(z.array(BookingRowSchema), 'GET', '/admin/bookings', { query: filter }),
      get: (id: string) => http.request(AdminBookingSchema, 'GET', `/admin/bookings/${id}`),
      trace: (id: string) => http.request(TraceSchema, 'GET', `/admin/bookings/${id}/trace`),
      assign: (id: string, change: Change & { workerId: string }) => act(id, 'assign', change),
      redispatch: (id: string, change: Change) => act(id, 'redispatch', change),
      reschedule: (id: string, change: Change & { startAt: string }) =>
        act(id, 'reschedule', change),
      cancel: (id: string, change: Change & { fault: 'CUSTOMER' | 'COMPANY' | 'NO_WORKER' }) =>
        act(id, 'cancel', change),
      hold: (id: string, change: Change) => act(id, 'hold', change),
      releaseHold: (id: string, change: Change) => act(id, 'release-hold', change),
      workerNoShow: (id: string, change: Change) => act(id, 'worker-no-show', change),
      customerNoShow: (id: string, change: Change) => act(id, 'customer-no-show', change),
    },
  };
}
