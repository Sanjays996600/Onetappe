import { ApiError } from '@onetappe/api-client';
import { commonStrings, type Locale } from './strings';

/**
 * What to tell a person when a call fails. Apps pass their own messages for the business
 * codes of their screens; everything else gets a clear generic message. The request id is
 * shown so support can find exactly what happened.
 */
export function describeError(
  error: unknown,
  locale: Locale,
  messages: Readonly<Record<string, string>> = {},
): { message: string; reference: string | null; code: string } {
  const t = commonStrings[locale];
  if (!(error instanceof ApiError)) {
    return { message: t.somethingWrong, reference: null, code: 'UNKNOWN' };
  }
  const known = messages[error.code];
  const message =
    known ??
    (error.code === 'NETWORK_ERROR'
      ? t.noConnection
      : error.code === 'TIMEOUT'
        ? t.timeout
        : error.status === 503 || error.status === 502 || error.status === 504
          ? t.serviceUnavailable
          : error.isSignedOut
            ? t.signedOut
            : error.status >= 500
              ? t.somethingWrong
              : // Business rule messages from the API are written for people (English).
                locale === 'en'
                ? error.message
                : t.somethingWrong);
  return { message, reference: error.requestId, code: error.code };
}
