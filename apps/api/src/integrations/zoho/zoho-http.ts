import { Inject, Injectable } from '@nestjs/common';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { IntegrationError } from '../integration-error.js';
import { ZohoAuth } from './zoho-auth.service.js';

export interface ZohoRequest {
  readonly method: 'GET' | 'POST' | 'PATCH';
  /** Absolute URL (built from the configured CRM/Desk base URL). */
  readonly url: URL;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

/**
 * The one place that talks HTTP to Zoho APIs: authentication, timeouts, a single token
 * refresh on 401, and translation of every failure into an IntegrationError kind.
 */
@Injectable()
export class ZohoHttp {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly auth: ZohoAuth,
  ) {}

  /** Returns the parsed JSON body, or null for an empty (204) answer. */
  async request<T>(request: ZohoRequest): Promise<T | null> {
    let token = await this.auth.accessToken();
    let response = await this.send(request, token);
    if (response.status === 401) {
      token = await this.auth.accessToken(token);
      response = await this.send(request, token);
      if (response.status === 401) {
        throw new IntegrationError('CREDENTIALS', 'Zoho rejected a freshly issued token', 401);
      }
    }
    if (response.status === 204) return null;
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new IntegrationError(
        'RATE_LIMITED',
        'Zoho API rate limit reached',
        429,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60,
      );
    }
    const text = await response.text();
    if (response.status >= 500) {
      throw new IntegrationError(
        'RETRYABLE',
        `Zoho answered HTTP ${String(response.status)}`,
        response.status,
      );
    }
    if (!response.ok) {
      throw new IntegrationError(
        'PERMANENT',
        `Zoho refused the request (HTTP ${String(response.status)}): ${summarise(text)}`,
        response.status,
      );
    }
    if (!text) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new IntegrationError(
        'RETRYABLE',
        'Zoho answered with an unreadable body',
        response.status,
      );
    }
  }

  private async send(request: ZohoRequest, token: string): Promise<Response> {
    try {
      return await fetch(request.url, {
        method: request.method,
        headers: {
          authorization: `Zoho-oauthtoken ${token}`,
          ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...request.headers,
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: AbortSignal.timeout(this.env.ZOHO_HTTP_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      // A timeout leaves the outcome unknown; creators look the record up before retrying.
      throw new IntegrationError(
        'RETRYABLE',
        timedOut ? 'Zoho did not answer in time' : 'Zoho could not be reached',
      );
    }
  }
}

/** Keeps error text short; Zoho error bodies are JSON with a code and message. */
function summarise(text: string): string {
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const code = body['errorCode'] ?? body['code'];
    const message = body['message'];
    return (
      [code, message]
        .filter((v) => typeof v === 'string')
        .join(': ')
        .slice(0, 300) || 'no detail'
    );
  } catch {
    return text.slice(0, 200) || 'no detail';
  }
}
