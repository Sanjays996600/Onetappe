import 'server-only';
import { cache } from 'react';
import { call } from './api';

/** The signed-in staff member, fetched once per request. */
export const getMe = cache(() => call((api) => api.admin.me()));
