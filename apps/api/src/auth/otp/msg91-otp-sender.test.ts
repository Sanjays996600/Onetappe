import { describe, expect, it } from 'vitest';
import { Msg91OtpSender, OtpDeliveryError } from './otp-sender.js';

const config = { authKey: 'test-auth-key', templateId: 'tmpl-1', timeoutMs: 200 };

function replying(status: number, body: unknown): typeof fetch {
  return () => Promise.resolve(new Response(JSON.stringify(body), { status }));
}

async function failureOf(sender: Msg91OtpSender): Promise<OtpDeliveryError> {
  const error = await sender.send('+919876543210', '123456').catch((e: unknown) => e);
  expect(error).toBeInstanceOf(OtpDeliveryError);
  return error as OtpDeliveryError;
}

describe('MSG91 OTP sender', () => {
  it('sends the code with the template and authkey, and returns the request id', async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null;
    const fetchImpl: typeof fetch = (input, init) => {
      seen = { url: (input as URL).toString(), headers: init?.headers as Record<string, string> };
      return Promise.resolve(
        new Response(JSON.stringify({ type: 'success', request_id: 'req-1' }), { status: 200 }),
      );
    };
    const delivery = await new Msg91OtpSender(config, fetchImpl).send('+919876543210', '123456');

    expect(delivery).toEqual({ reference: 'req-1' });
    const url = new URL(seen!.url);
    expect(url.origin + url.pathname).toBe('https://control.msg91.com/api/v5/otp');
    expect(url.searchParams.get('template_id')).toBe('tmpl-1');
    expect(url.searchParams.get('mobile')).toBe('919876543210');
    expect(url.searchParams.get('otp')).toBe('123456');
    expect(seen!.headers['authkey']).toBe('test-auth-key');
  });

  it('treats HTTP 200 with type "error" as a failure', async () => {
    const error = await failureOf(
      new Msg91OtpSender(config, replying(200, { type: 'error', message: 'Invalid template' })),
    );
    expect(error.outcomeUnknown).toBe(false);
  });

  it('treats an HTTP error or an unreadable body as a failure', async () => {
    await failureOf(new Msg91OtpSender(config, replying(401, { type: 'error' })));
    const html: typeof fetch = () =>
      Promise.resolve(new Response('<html>Bad gateway</html>', { status: 200 }));
    await failureOf(new Msg91OtpSender(config, html));
  });

  it('reports an unreachable provider as a definite failure', async () => {
    const down: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));
    const error = await failureOf(new Msg91OtpSender(config, down));
    expect(error.outcomeUnknown).toBe(false);
  });

  it('gives up after the timeout and marks the outcome unknown', async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason as Error);
        });
      });
    const started = Date.now();
    const error = await failureOf(new Msg91OtpSender(config, hanging));
    expect(error.outcomeUnknown).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
