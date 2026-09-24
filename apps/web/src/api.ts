import type { Tokens } from './types.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  constructor(message: string, status: number, code: string, requestId?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

/** Tokens live in memory only. Reloads require OTP; no personal data is persisted by this client. */
export class ApiClient {
  private tokens: Tokens | null = null;
  private refreshing: Promise<void> | null = null;
  private readonly base: string;
  private readonly fetcher: typeof fetch;
  private readonly onExpired: () => void;
  constructor(
    base = '/api/v1',
    fetcher: typeof fetch = fetch,
    onExpired: () => void = () => undefined,
  ) {
    this.base = base;
    this.fetcher = fetcher;
    this.onExpired = onExpired;
  }
  setTokens(tokens: Tokens | null) {
    this.tokens = tokens;
  }
  private async refresh() {
    if (!this.refreshing) {
      const token = this.tokens?.refreshToken;
      if (!token) throw new ApiError('Please sign in again.', 401, 'SESSION_EXPIRED');
      this.refreshing = this.raw<Tokens>('/auth/refresh', 'POST', { refreshToken: token })
        .then((tokens) => {
          this.tokens = tokens;
        })
        .catch((error: unknown) => {
          this.tokens = null;
          this.onExpired();
          throw error;
        })
        .finally(() => {
          this.refreshing = null;
        });
    }
    await this.refreshing;
  }
  private async raw<T>(path: string, method: string, body?: unknown, key?: string): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.base}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(this.tokens ? { Authorization: `Bearer ${this.tokens.accessToken}` } : {}),
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20_000),
        cache: 'no-store',
      });
    } catch {
      throw new ApiError(
        'Unable to reach One Tappe. Check your connection and try again.',
        0,
        'NETWORK_ERROR',
      );
    }
    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as {
        error?: { code?: string; message?: string; requestId?: string };
      } | null;
      throw new ApiError(
        data?.error?.message ?? 'One Tappe is temporarily unavailable. Please try again.',
        response.status,
        data?.error?.code ?? 'HTTP_ERROR',
        data?.error?.requestId,
      );
    }
    if (response.status === 204) return undefined as T;
    try {
      return (await response.json()) as T;
    } catch {
      throw new ApiError(
        'The service returned an unexpected response. Please try again.',
        502,
        'INVALID_RESPONSE',
      );
    }
  }
  async request<T>(path: string, method = 'GET', body?: unknown, key?: string): Promise<T> {
    if (this.tokens && Date.parse(this.tokens.accessTokenExpiresAt) <= Date.now() + 15_000)
      await this.refresh();
    try {
      return await this.raw<T>(path, method, body, key);
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        error.status !== 401 ||
        !this.tokens ||
        path.includes('/auth/')
      )
        throw error;
      await this.refresh();
      return this.raw<T>(path, method, body, key);
    }
  }
}

/** A network-uncertain retry of the same form retains its key. Changed payloads get new keys. */
export class SubmissionKeys {
  private keys = new Map<string, string>();
  for(path: string, body: unknown): string {
    const fingerprint = JSON.stringify([path, body]);
    let key = this.keys.get(fingerprint);
    if (!key) {
      key = crypto.randomUUID();
      this.keys.set(fingerprint, key);
    }
    return key;
  }
  clear() {
    this.keys.clear();
  }
}
export function money(paise: number, locale = 'en'): string {
  return new Intl.NumberFormat(locale === 'hi' ? 'hi-IN' : 'en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(paise / 100);
}
export function dateTime(iso: string, locale = 'en'): string {
  return new Intl.DateTimeFormat(locale === 'hi' ? 'hi-IN' : 'en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso));
}
export function indiaDate(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
