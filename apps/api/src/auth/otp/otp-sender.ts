import { Injectable, Logger } from '@nestjs/common';

/**
 * Delivers an OTP to a phone. Authentication depends only on this interface, so the SMS
 * provider can be replaced without touching the login flow.
 */
export interface OtpSender {
  readonly name: string;
  send(phoneE164: string, code: string, locale: string): Promise<void>;
}

export const OTP_SENDER = Symbol('OTP_SENDER');

/** Local development: prints the code to the API log. Refused outside local/test. */
@Injectable()
export class ConsoleOtpSender implements OtpSender {
  readonly name = 'console';
  private readonly logger = new Logger('OTP');

  send(phoneE164: string, code: string): Promise<void> {
    this.logger.warn(`OTP for ${phoneE164}: ${code} (console provider, local only)`);
    return Promise.resolve();
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

  send(phoneE164: string, code: string): Promise<void> {
    this.outbox.push({ phone: phoneE164, code, at: new Date() });
    return Promise.resolve();
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

/**
 * MSG91 OTP API (v5). Requires a DLT-registered template containing the OTP variable.
 * Not yet exercised against a live MSG91 account; verify on staging before launch.
 */
export class Msg91OtpSender implements OtpSender {
  readonly name = 'msg91';

  constructor(
    private readonly authKey: string,
    private readonly templateId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(phoneE164: string, code: string): Promise<void> {
    const url = new URL('https://control.msg91.com/api/v5/otp');
    url.searchParams.set('template_id', this.templateId);
    url.searchParams.set('mobile', phoneE164.replace(/^\+/, ''));
    url.searchParams.set('otp', code);
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: { authkey: this.authKey, 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`MSG91 rejected the OTP request with HTTP ${response.status}`);
    }
  }
}
