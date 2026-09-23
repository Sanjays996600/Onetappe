import type { z } from 'zod';
import { ApiError } from './errors.js';

export interface Tokens {
  readonly accessToken: string;
  readonly refreshToken: string;
}

/** Where the app keeps tokens (secure storage on phones, the server session in the admin BFF). */
export interface TokenStore {
  get(): Promise<Tokens | null> | Tokens | null;
  set(tokens: Tokens | null): Promise<void> | void;
}

export interface ContractMismatch {
  readonly method: string;
  readonly path: string;
  readonly issues: string;
}

export interface ClientOptions {
  /** Including the version prefix, e.g. `https://api.onetappe.in/api/v1`. */
  readonly baseUrl: string;
  readonly tokens?: TokenStore;
  readonly fetch?: typeof fetch;
  /** Per attempt. Default 15 s. */
  readonly timeoutMs?: number;
  /** Extra headers on every request (e.g. app version, locale). */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Called when a response does not match the expected shape. The data is still returned
   * (the app keeps working); tests make this throw so API drift fails the build.
   */
  readonly onContractMismatch?: (mismatch: ContractMismatch) => void;
  /** Delay between automatic retries (tests shorten it). */
  readonly retryDelaysMs?: readonly number[];
}

export interface RequestOptions {
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, string | number | boolean | null | undefined>>;
  /** Sent as Idempotency-Key; reuse the same key when the person retries the same action. */
  readonly idempotencyKey?: string;
  /** The server treats a repeat as the same request, so failed attempts may be retried. */
  readonly idempotent?: boolean;
  /** Public endpoints (sign-in, legal documents) are called without a token. */
  readonly anonymous?: boolean;
  readonly signal?: AbortSignal;
}

const DEFAULT_RETRY_DELAYS_MS = [400, 1500] as const;

/** Fresh key for one logical action (keep it until that action succeeds). */
export function newIdempotencyKey(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  // React Native without a crypto polyfill: time + randomness is unique enough for a key.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random()
    .toString(36)
    .slice(2)}`;
}

export class HttpClient {
  private refreshing: Promise<boolean> | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async request<S extends z.ZodType>(
    schema: S,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    options: RequestOptions = {},
  ): Promise<z.infer<S>> {
    const retryable = method === 'GET' || options.idempotent === true || !!options.idempotencyKey;
    const delays = this.options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const raw = await this.withAuth(method, path, options);
        return this.check(schema, method, path, raw);
      } catch (error) {
        const delay = delays[attempt];
        if (!(error instanceof ApiError) || !error.isTransient || !retryable || delay === undefined)
          throw error;
        const wait = Math.min(Math.max(delay, (error.retryAfterSeconds ?? 0) * 1000), 10_000);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }

  /** One call; on an expired access token, refreshes once (shared by concurrent calls). */
  private async withAuth(method: string, path: string, options: RequestOptions): Promise<unknown> {
    const store = this.options.tokens;
    const tokens = options.anonymous || !store ? null : await store.get();
    try {
      return await this.send(method, path, options, tokens?.accessToken ?? null);
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status === 401 &&
        error.code === 'TOKEN_EXPIRED' &&
        tokens &&
        (await this.refresh(tokens))
      ) {
        const fresh = await store?.get();
        return this.send(method, path, options, fresh?.accessToken ?? null);
      }
      if (error instanceof ApiError && error.isSignedOut && tokens) await store?.set(null);
      throw error;
    }
  }

  private refresh(tokens: Tokens): Promise<boolean> {
    this.refreshing ??= (async () => {
      try {
        const next = (await this.send(
          'POST',
          '/auth/refresh',
          {
            body: { refreshToken: tokens.refreshToken },
          },
          null,
        )) as Tokens;
        await this.options.tokens?.set({
          accessToken: next.accessToken,
          refreshToken: next.refreshToken,
        });
        return true;
      } catch {
        return false;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private async send(
    method: string,
    path: string,
    options: RequestOptions,
    accessToken: string | null,
  ): Promise<unknown> {
    const url = new URL(`${this.options.baseUrl.replace(/\/$/, '')}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { accept: 'application/json', ...this.options.headers };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (accessToken) headers['authorization'] = `Bearer ${accessToken}`;
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.options.timeoutMs ?? 15_000);
    options.signal?.addEventListener(
      'abort',
      () => {
        controller.abort();
      },
      { once: true },
    );
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = controller.signal.aborted && !options.signal?.aborted;
      throw new ApiError(
        0,
        aborted ? 'TIMEOUT' : 'NETWORK_ERROR',
        aborted ? 'The server took too long to answer' : 'No connection to the server',
        { cause: error instanceof Error ? error.message : String(error) },
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new ApiError(response.status || 0, 'BAD_RESPONSE', 'Unreadable server response');
      }
    }
    if (!response.ok) {
      const body = (json as { error?: Record<string, unknown> } | null)?.error ?? {};
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new ApiError(
        response.status,
        typeof body['code'] === 'string' ? body['code'] : `HTTP_${String(response.status)}`,
        typeof body['message'] === 'string' ? body['message'] : response.statusText,
        (body['details'] as Record<string, unknown> | undefined) ?? {},
        typeof body['requestId'] === 'string'
          ? body['requestId']
          : response.headers.get('x-request-id'),
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      );
    }
    return json;
  }

  private check<S extends z.ZodType>(schema: S, method: string, path: string, raw: unknown) {
    const parsed = schema.safeParse(raw);
    if (parsed.success) return parsed.data;
    this.options.onContractMismatch?.({ method, path, issues: parsed.error.message });
    return raw as z.infer<S>;
  }
}
