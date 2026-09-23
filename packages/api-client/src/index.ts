import { adminApi } from './groups/admin.js';
import { authApi } from './groups/auth.js';
import { customerApi } from './groups/customer.js';
import { legalApi } from './groups/legal.js';
import { workerApi } from './groups/worker.js';
import { HttpClient, type ClientOptions } from './http.js';

export { ApiError, SESSION_ENDED_CODES } from './errors.js';
export {
  newIdempotencyKey,
  type ClientOptions,
  type ContractMismatch,
  type TokenStore,
  type Tokens,
} from './http.js';
export type { Change } from './groups/admin.js';
export type { Locale } from './groups/auth.js';
export type * from './schemas/admin.js';
export type * from './schemas/auth.js';
export type * from './schemas/customer.js';
export type * from './schemas/legal.js';
export type * from './schemas/worker.js';
export type { Location, QuoteRequest } from './groups/customer.js';
export type { IssuedTokens } from './schemas/common.js';

/** The One Tappe API for the customer app, the worker app and the admin panel. */
export function createApiClient(options: ClientOptions) {
  const http = new HttpClient(options);
  return {
    auth: authApi(http),
    admin: adminApi(http),
    customer: customerApi(http),
    worker: workerApi(http),
    legal: legalApi(http),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
