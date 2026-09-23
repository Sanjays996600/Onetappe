import { Injectable, Logger } from '@nestjs/common';
import { maskPhone } from '../../common/pii.js';

/** What the provider told us about an accepted message. */
export interface OtpDelivery {
  /** Provider's id for the message (for support queries), when it returns one. */
  readonly reference: string | null;
}

/** The provider did not accept the message (rejected, unreachable or timed out). */
export class OtpDeliveryError extends Error {
  constructor(
    message: string,
    /** True when the provider may have accepted it anyway (timeout, lost response). */
    readonly outcomeUnknown: boolean,
  ) {
    super(message);
    this.name = 'OtpDeliveryError';
  }
}

/**
 * Delivers an OTP to a phone. Authentication depends only on this interface, so the SMS
 * provider can be replaced without touching the login flow. Implementations throw
 * OtpDeliveryError when the provider does not confirm acceptance.
 */
export interface OtpSender {
  readonly name: string;
  send(phoneE164: string, code: string, locale: string): Promise<OtpDelivery>;
}

export const OTP_SENDER = Symbol('OTP_SENDER');

/** Local development: prints the code to the API log. Refused outside local/test. */
@Injectable()
export class ConsoleOtpSender implements OtpSender {
  readonly name = 'console';
  private readonly logger = new Logger('OTP');

  send(phoneE164: string, code: string): Promise<OtpDelivery> {
    this.logger.warn(`OTP for ${phoneE164}: ${code} (console provider, local only)`);
    return Promise.resolve({ reference: null });
  }
}

/**
 * Automated tests: keeps sent codes in memory so a test can read the code exactly like a
 * user reading an SMS. Nothing is exposed over HTTP. Refused unless APP_ENV=test.
 */
@Injectable()
export class TestOtpSender implements OtpSender {
  readonly name = 'test';
  private readonly outbox: Array<{ phone: string; code: string; at: Date }> = [];
  private readonly failures: OtpDeliveryError[] = [];

  send(phoneE164: string, code: string): Promise<OtpDelivery> {
    const failure = this.failures.shift();
    if (failure) return Promise.reject(failure);
    this.outbox.push({ phone: phoneE164, code, at: new Date() });
    return Promise.resolve({ reference: `test-${String(this.outbox.length)}` });
  }

  /** Makes the next send fail as a provider outage would. */
  failNextSend(outcomeUnknown = false): void {
    this.failures.push(new OtpDeliveryError('Simulated provider failure', outcomeUnknown));
  }

  latestCodeFor(phoneE164: string): string | null {
    for (let i = this.outbox.length - 1; i >= 0; i -= 1) {
      const message = this.outbox[i];
      if (message?.phone === phoneE164) return message.code;
    }
    return null;
  }

  sentCount(phoneE164: string): number {
    return this.outbox.filter((m) => m.phone === phoneE164).length;
  }
}

export interface Msg91Config {
  readonly authKey: string;
  /** DLT-registered OTP template id from the MSG91 panel. */
  readonly templateId: string;
  readonly timeoutMs?: number;
}

/**
 * MSG91 OTP API (v5): POST https://control.msg91.com/api/v5/otp with the `authkey` header.
 * MSG91 can answer HTTP 200 with `{"type":"error"}`, so success is only accepted when the
 * body says `"type":"success"`. Not yet exercised against a live MSG91 account.
 */
export class Msg91OtpSender implements OtpSender {
  readonly name = 'msg91';
  private readonly logger = new Logger('OTP');

  constructor(
    private readonly config: Msg91Config,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(phoneE164: string, code: string): Promise<OtpDelivery> {
    const url = new URL('https://control.msg91.com/api/v5/otp');
    url.searchParams.set('template_id', this.config.templateId);
    url.searchParams.set('mobile', phoneE164.replace(/^\+/, ''));
    url.searchParams.set('otp', code);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { authkey: this.config.authKey, 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000),
      });
    } catch (error) {
      // A timeout may hide an accepted message; either way the user gets a fresh code next.
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new OtpDeliveryError(
        timedOut ? 'MSG91 did not answer in time' : 'MSG91 could not be reached',
        timedOut,
      );
    }

    const body = (await response.json().catch(() => null)) as {
      type?: unknown;
      message?: unknown;
      request_id?: unknown;
    } | null;
    if (!response.ok || body?.type !== 'success') {
      // Never log the code or the full number.
      const reason = typeof body?.message === 'string' ? body.message.slice(0, 200) : 'no detail';
      this.logger.warn(
        `MSG91 refused OTP to ${maskPhone(phoneE164)} (HTTP ${String(response.status)}): ${reason}`,
      );
      throw new OtpDeliveryError(
        `MSG91 refused the message (HTTP ${String(response.status)})`,
        false,
      );
    }
    return { reference: typeof body.request_id === 'string' ? body.request_id : null };
  }
}
