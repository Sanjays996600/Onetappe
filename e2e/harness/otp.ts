import { readFileSync } from 'node:fs';

/**
 * Reads the code the API "sent" to a phone. Locally the OTP provider is `console`: the API
 * writes each code to its log (with the phone masked to its last digits), exactly like an
 * SMS the person reads. Waits for a code newer than `after`.
 */
export async function otpFor(apiLog: string, phone: string, after: number, timeoutMs = 10_000) {
  const last4 = phone.slice(-4);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lines = readFileSync(apiLog, 'utf8').split('\n').slice(-500).reverse();
    for (const line of lines) {
      if (!line.includes('OTP for')) continue;
      let entry: { time?: string; msg?: string };
      try {
        entry = JSON.parse(line) as { time?: string; msg?: string };
      } catch {
        continue;
      }
      const match = /OTP for \S*?(\d{4}): (\d{6})/.exec(entry.msg ?? '');
      if (match?.[1] === last4 && Date.parse(entry.time ?? '') >= after - 1000)
        return match[2] as string;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`No OTP for …${last4} in ${apiLog}`);
}
