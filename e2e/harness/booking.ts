import { randomInt, randomUUID } from 'node:crypto';
import { otpFor } from './otp.js';
import type { StackState } from './state.js';

type Json = Record<string, unknown>;

async function http(
  s: StackState,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
  key?: string,
) {
  const res = await fetch(`${s.apiUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok) throw new Error(`${method} ${path} → ${String(res.status)} ${JSON.stringify(json)}`);
  return json;
}

/** Tomorrow at `hour` India time (the seeded worker's shift day). */
export function tomorrowAt(s: StackState, hour: number): string {
  return new Date(`${s.world.day}T${String(hour).padStart(2, '0')}:00:00+05:30`).toISOString();
}

/**
 * A customer books and pays through the real API, the way the customer app does (OTP from
 * the API log, sandbox gateway). Returns the booking id and code.
 */
export async function paidBooking(s: StackState, hour: number) {
  const phone = `+9198${String(randomInt(10_000_000, 99_999_999))}`;
  const since = Date.now();
  const challenge = await http(s, 'POST', '/customer/auth/otp', { phone });
  const code = await otpFor(s.apiLog, phone, since);
  const session = await http(s, 'POST', '/customer/auth/verify', {
    challengeId: challenge['challengeId'],
    phone,
    code,
  });
  const token = session['accessToken'] as string;
  const consents = await http(s, 'GET', '/me/consents', undefined, token);
  await http(
    s,
    'POST',
    '/me/consents/accept',
    { documentIds: (consents['required'] as Json[]).map((d) => d['id']) },
    token,
  );
  await http(s, 'PATCH', '/customer/me', { fullName: 'Priya Sharma' }, token);
  const address = await http(
    s,
    'POST',
    '/customer/addresses',
    {
      contactName: 'Priya Sharma',
      contactPhone: phone,
      houseNumber: 'C-101',
      pincode: s.world.pincode,
      cityName: 'Noida',
      lat: s.world.center.lat,
      lng: s.world.center.lng,
    },
    token,
    randomUUID(),
  );
  const startAt = tomorrowAt(s, hour);
  const quote = await http(
    s,
    'POST',
    '/customer/quotes',
    { serviceId: s.world.service.id, addressId: address['id'], bookingType: 'SCHEDULED', startAt },
    token,
  );
  const booking = await http(
    s,
    'POST',
    '/customer/bookings',
    {
      serviceId: s.world.service.id,
      addressId: address['id'],
      bookingType: 'SCHEDULED',
      startAt,
      expectedTotalPaise: quote['totalPaise'],
    },
    token,
    randomUUID(),
  );
  const pay = await http(
    s,
    'POST',
    `/customer/bookings/${booking['id'] as string}/payments`,
    undefined,
    token,
  );
  const orderId = (pay['checkout'] as Json)['orderId'] as string;
  await http(s, 'POST', `/sandbox/payments/${orderId}`, { outcome: 'capture' });
  return { id: booking['id'] as string, code: booking['bookingCode'] as string, token };
}
