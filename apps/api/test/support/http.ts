import { randomInt } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

export interface ApiResponse<T = Record<string, unknown>> {
  readonly status: number;
  readonly body: T;
  readonly headers: Record<string, unknown>;
}

/** Calls the API exactly as a mobile app or the admin panel would (JSON over HTTP). */
export class ApiClient {
  constructor(
    private readonly app: NestFastifyApplication,
    private readonly token: string | null = null,
    /** Fixed client IP; by default every request comes from a different device/network. */
    private readonly ip: string | null = null,
  ) {}

  as(token: string): ApiClient {
    return new ApiClient(this.app, token, this.ip);
  }

  fromIp(ip: string): ApiClient {
    return new ApiClient(this.app, this.token, ip);
  }

  get<T = Record<string, unknown>>(path: string, headers: Record<string, string> = {}) {
    return this.send<T>('GET', path, undefined, headers);
  }

  post<T = Record<string, unknown>>(
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    return this.send<T>('POST', path, body, headers);
  }

  patch<T = Record<string, unknown>>(
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    return this.send<T>('PATCH', path, body, headers);
  }

  async send<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<ApiResponse<T>> {
    const response = await this.app.inject({
      method,
      url: `/api/v1${path}`,
      remoteAddress: this.ip ?? `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...headers,
      },
      ...(body === undefined
        ? {}
        : { payload: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const text = response.body;
    return {
      status: response.statusCode,
      body: (text ? JSON.parse(text) : {}) as T,
      headers: response.headers,
    };
  }
}
