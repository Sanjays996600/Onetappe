import { BOOKING_STATUSES } from '@onetappe/domain';
import { z } from 'zod';

export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}T/, 'ISO date-time');
export const Uuid = z.string().regex(/^[0-9a-f-]{36}$/i, 'uuid');
export const Paise = z.number().int();
export const BookingStatusSchema = z.enum(BOOKING_STATUSES);

export const TokensSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: IsoDate,
  refreshToken: z.string(),
  sessionExpiresAt: IsoDate,
});
export type IssuedTokens = z.infer<typeof TokensSchema>;

/** 204 responses. */
export const NoContent = z.unknown();
