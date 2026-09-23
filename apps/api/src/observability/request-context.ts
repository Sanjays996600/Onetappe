import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Correlation data for whatever is running now (an HTTP request or a background job).
 * Every log line carries it, so one request id (or booking id) finds everything that
 * happened, across the API, the worker and the database history rows.
 */
export interface RequestContextData {
  requestId: string;
  actorUserId?: string | null;
  bookingId?: string;
  job?: string;
}

const storage = new AsyncLocalStorage<RequestContextData>();

export const RequestContext = {
  run<T>(data: RequestContextData, fn: () => T): T {
    return storage.run(data, fn);
  },

  current(): RequestContextData | undefined {
    return storage.getStore();
  },

  /** Adds identifiers learned while handling the request (e.g. the booking being changed). */
  annotate(values: Partial<Omit<RequestContextData, 'requestId'>>): void {
    const store = storage.getStore();
    if (store) Object.assign(store, values);
  },
};
