import { SignJWT, importPKCS8 } from 'jose';
import { ChannelError, postJson, type ChannelSender, type OutboundMessage } from '../channels.js';

export interface FcmConfig {
  readonly projectId: string;
  /** Service account (company-owned Firebase project), from the secret manager. */
  readonly clientEmail: string;
  readonly privateKey: string;
  readonly apiUrl: string;
  readonly tokenUrl: string;
  readonly timeoutMs: number;
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/**
 * Firebase Cloud Messaging HTTP v1 (Android and iOS via APNs). Authenticates with a
 * service-account JWT exchanged for a short-lived OAuth token. Tokens the app no longer
 * owns (UNREGISTERED, invalid) are reported as INVALID_RECIPIENT so the device is retired.
 */
export class FcmPushSender implements ChannelSender {
  readonly channel = 'PUSH' as const;
  readonly provider = 'fcm';
  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: FcmConfig) {}

  async send(message: OutboundMessage): Promise<string> {
    const token = await this.oauthToken();
    const url = `${this.config.apiUrl.replace(/\/$/, '')}/v1/projects/${encodeURIComponent(this.config.projectId)}/messages:send`;
    const response = await postJson(url, {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          token: message.recipient,
          notification: { title: message.title ?? '', body: message.body },
          data: { notificationId: message.notificationId, ...message.data },
          android: { priority: 'high' },
        },
      }),
      timeoutMs: this.config.timeoutMs,
    });
    if (response.status === 200) {
      const name = (response.body as { name?: unknown } | null)?.name;
      return typeof name === 'string' ? name : message.notificationId;
    }
    if (response.status === 401) this.accessToken = null;
    throw classifyFcmError(response.status, response.body);
  }

  private async oauthToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt - Date.now() > 60_000) {
      return this.accessToken.value;
    }
    const key = await importPKCS8(this.config.privateKey, 'RS256');
    const assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(this.config.clientEmail)
      .setSubject(this.config.clientEmail)
      .setAudience(this.config.tokenUrl)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key);
    let response: Response;
    try {
      response = await fetch(this.config.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }).toString(),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch {
      throw new ChannelError('RETRYABLE', 'Google OAuth unreachable');
    }
    const body = (await response.json().catch(() => null)) as {
      access_token?: unknown;
      expires_in?: unknown;
    } | null;
    if (!response.ok || typeof body?.access_token !== 'string') {
      // Wrong service account or key: every send would fail the same way.
      throw new ChannelError(
        response.status >= 500 ? 'RETRYABLE' : 'PERMANENT',
        `FCM credentials rejected (HTTP ${String(response.status)})`,
      );
    }
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    this.accessToken = { value: body.access_token, expiresAt: Date.now() + expiresIn * 1000 };
    return body.access_token;
  }
}

function classifyFcmError(status: number, body: unknown): ChannelError {
  const error = (
    body as { error?: { status?: string; details?: Array<Record<string, unknown>> } } | null
  )?.error;
  const fcmCode = error?.details?.find((d) => typeof d['errorCode'] === 'string')?.['errorCode'];
  const code = typeof fcmCode === 'string' ? fcmCode : (error?.status ?? `HTTP_${String(status)}`);
  if (['UNREGISTERED', 'SENDER_ID_MISMATCH'].includes(code) || status === 404) {
    return new ChannelError('INVALID_RECIPIENT', `FCM: ${code}`);
  }
  // INVALID_ARGUMENT can also mean a malformed message (our bug), so the device is kept.
  if (status === 429 || status >= 500 || code === 'UNAVAILABLE' || code === 'INTERNAL') {
    return new ChannelError('RETRYABLE', `FCM: ${code}`);
  }
  return new ChannelError('PERMANENT', `FCM: ${code}`);
}
