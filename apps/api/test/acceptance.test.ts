import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient } from './support/http.js';
import {
  NOIDA_SECTOR_62,
  configureInvoiceIssuer,
  deliverWebhook,
  onboardWorkerViaApi,
  runJob,
  sandbox,
} from './support/journey.js';
import { signInWithOtp } from './support/phone-auth.js';
import { createStaff, signInStaff } from './support/staff.js';
import { createTestApp, createWorld, type TestApp } from './support/world.js';

/**
 * Acceptance milestone: one complete, real HH60 transaction driven only through the
 * public HTTP API, exactly as the customer app, worker app, gateway and operations panel
 * would drive it.
 */

let app: TestApp;
let api: ApiClient;

beforeAll(async () => {
  app = await createTestApp();
  api = new ApiClient(app.http);
});

afterAll(async () => {
  await app.close();
});

type Json = Record<string, unknown>;

describe('HH60 acceptance journey (API only)', () => {
  it('books, pays, dispatches, delivers, settles, invoices, pays the worker and keeps the full history', async () => {
    // ---- Configuration (what operations sets up in the admin panel) ----
    const world = await createWorld(app.db, {
      workers: 0,
      cityName: 'Noida',
      zoneName: 'Sector 62',
      center: NOIDA_SECTOR_62,
    });
    const superAdmin = await createStaff(app, ['SUPER_ADMIN']);
    await configureInvoiceIssuer(api, await signInStaff(api, superAdmin));
    const workerOps = await createStaff(app, ['WORKER_OPERATIONS']);
    const { session: workerSession } = await onboardWorkerViaApi(app, api, workerOps, world);
    const worker = api.as(workerSession.accessToken);

    // ---- 1. Customer registers with OTP ----
    const customerSession = await signInWithOtp(app, api, 'customer');
    expect(customerSession.user).toMatchObject({
      isNew: true,
      profileComplete: false,
      hasAddress: false,
    });
    const customer = api.as(customerSession.accessToken);
    expect(
      (await customer.patch('/customer/me', { fullName: 'Anita Sharma', preferredLocale: 'hi' }))
        .status,
    ).toBe(200);

    // ---- 2. Adds a Noida address ----
    const address = await customer.post<Json>('/customer/addresses', {
      label: 'Home',
      contactName: 'Anita Sharma',
      contactPhone: customerSession.phone,
      houseNumber: 'A-101',
      building: 'Green Residency',
      street: 'Sector 62',
      landmark: 'Near metro station',
      pincode: world.pincode,
      cityName: 'Noida',
      lat: NOIDA_SECTOR_62.lat + 0.004,
      lng: NOIDA_SECTOR_62.lng + 0.003,
    });
    expect(address.status).toBe(201);
    expect(address.body).toMatchObject({ serviceable: true, isDefault: true });
    const addressId = address.body['id'] as string;

    // ---- 3. Views HH60 ----
    const location = `pincode=${world.pincode}&lat=${NOIDA_SECTOR_62.lat + 0.004}&lng=${NOIDA_SECTOR_62.lng + 0.003}`;
    const catalog = await customer.get<Json>(`/customer/catalog?${location}`);
    expect(catalog.body['serviceable']).toBe(true);
    const hh60 = (catalog.body['categories'] as Json[])
      .flatMap((c) => c['services'] as Json[])
      .find((s) => s['id'] === world.serviceId);
    expect(hh60).toMatchObject({ durationMinutes: 60, fromPricePaise: 49_900 });
    const details = await customer.get<Json>(`/customer/services/${world.serviceId}`);
    expect(details.body['tasks']).toHaveLength(3);

    // ---- 4. Availability and quote (computed by the backend, never by the app) ----
    const slots = await customer.get<Json>(
      `/customer/availability?serviceId=${world.serviceId}&addressId=${addressId}&date=${world.day}`,
    );
    expect(slots.body['slots']).toContain(world.at(10).toISOString());
    const quote = await customer.post<Json>('/customer/quotes', {
      serviceId: world.serviceId,
      addressId,
      bookingType: 'SCHEDULED',
      startAt: world.at(10).toISOString(),
    });
    expect(quote.status).toBe(200);
    expect(quote.body).toMatchObject({
      subtotalPaise: 49_900,
      taxPaise: 8_982,
      totalPaise: 58_882,
    });

    // ---- 5. Creates the booking ----
    const created = await customer.post<Json>(
      '/customer/bookings',
      {
        serviceId: world.serviceId,
        addressId,
        bookingType: 'SCHEDULED',
        startAt: world.at(10).toISOString(),
        expectedTotalPaise: 58_882,
        taskIds: world.taskIds.slice(0, 2),
      },
      { 'idempotency-key': randomUUID() },
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      status: 'PENDING_PAYMENT',
      payment: { status: 'UNPAID' },
      actions: { canPay: true },
    });
    const bookingId = created.body['id'] as string;

    // ---- 6. Pays through the sandbox gateway ----
    const pay = await customer.post<Json>(`/customer/bookings/${bookingId}/payments`);
    expect(pay.status).toBe(201);
    const orderId = (pay.body['checkout'] as Json)['orderId'] as string;
    expect(orderId).toMatch(/^sbx_order_/);

    // The app claiming success changes nothing: the gateway still says "pending".
    const refreshed = await customer.post<Json>(
      `/customer/bookings/${bookingId}/payments/${pay.body['paymentId'] as string}/refresh`,
    );
    expect(refreshed.body['paymentStatus']).toBe('CREATED');
    expect((refreshed.body['booking'] as Json)['status']).toBe('PENDING_PAYMENT');

    // ---- 7. Booking becomes CONFIRMED only from the verified gateway event ----
    const webhook = await deliverWebhook(api, sandbox(app).capture(orderId));
    expect(webhook.body).toMatchObject({ status: 'PROCESSED' });
    const confirmed = await customer.get<Json>(`/customer/bookings/${bookingId}`);
    expect(confirmed.body).toMatchObject({ status: 'CONFIRMED', payment: { status: 'PAID' } });

    // ---- 8. The eligible worker receives an offer with limited details ----
    const offers = await worker.get<Json[]>('/worker/offers');
    expect(offers.body).toHaveLength(1);
    const offer = offers.body[0] as Json;
    expect(offer).toMatchObject({
      bookingId,
      service: 'House help — 60 minutes',
      estimatedPayoutPaise: 33_000,
    });
    expect(offer).not.toHaveProperty('address');
    expect(JSON.stringify(offer)).not.toContain('A-101');

    // ---- 9. Worker accepts and now sees the job, address and contact number ----
    const accepted = await worker.post<Json>(`/worker/offers/${offer['offerId'] as string}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({
      bookingId,
      status: 'ASSIGNED',
      customerFirstName: 'Anita',
      address: { houseNumber: 'A-101', contactPhone: customerSession.phone },
    });
    const assigned = await customer.get<Json>(`/customer/bookings/${bookingId}`);
    expect(assigned.body).toMatchObject({
      status: 'ASSIGNED',
      worker: { firstName: 'Sunita' },
      actions: { canViewStartCode: true },
    });

    // ---- 10. En route, arrived ----
    expect((await worker.post<Json>(`/worker/jobs/${bookingId}/en-route`)).body['status']).toBe(
      'EN_ROUTE',
    );
    expect((await worker.post<Json>(`/worker/jobs/${bookingId}/arrived`)).body['status']).toBe(
      'ARRIVED',
    );

    // ---- 11. Customer provides the start code; service starts ----
    const startCode = await customer.get<Json>(`/customer/bookings/${bookingId}/start-code`);
    expect(startCode.body['code']).toMatch(/^\d{4}$/);
    const started = await worker.post<Json>(`/worker/jobs/${bookingId}/start`, {
      code: startCode.body['code'],
    });
    expect(started.body['status']).toBe('IN_PROGRESS');

    // ---- 12. Service completes ----
    const completed = await worker.post<Json>(`/worker/jobs/${bookingId}/complete`);
    expect(completed.body['status']).toBe('COMPLETED');
    expect(completed.body['address']).toMatchObject({ contactPhone: null });

    // ---- 13. Settlement closes the booking, issues the invoice, creates the earning ----
    await runJob(app, 'settle-bookings');
    const closed = await customer.get<Json>(`/customer/bookings/${bookingId}`);
    expect(closed.body['status']).toBe('CLOSED');

    const invoice = await customer.get<Json>(`/customer/bookings/${bookingId}/invoice`);
    expect(invoice.status).toBe(200);
    expect(invoice.body).toMatchObject({
      invoiceNumber: expect.stringMatching(/^OT-TEST-\d{6}$/) as string,
      totalPaise: 58_882,
      taxPaise: 8_982,
      billedTo: { name: 'Anita Sharma' },
    });

    const earnings = await worker.get<Json>('/worker/earnings');
    const jobEarnings = (earnings.body['items'] as Json[]).filter(
      (e) => e['bookingCode'] === created.body['bookingCode'],
    );
    expect(jobEarnings.map((e) => [e['type'], e['amountPaise'], e['status']]).sort()).toEqual([
      ['JOB', 30_000, 'PENDING'],
      ['TRAVEL', 3_000, 'PENDING'],
    ]);

    // ---- 14. Customer rates the service ----
    expect(
      (
        await customer.post(`/customer/bookings/${bookingId}/rating`, {
          score: 5,
          comment: 'Very neat work',
        })
      ).status,
    ).toBe(204);
    expect(
      (await customer.post(`/customer/bookings/${bookingId}/rating`, { score: 1 })).status,
    ).toBe(409);
    const rated = await customer.get<Json>(`/customer/bookings/${bookingId}`);
    expect(rated.body).toMatchObject({ rating: { score: 5 }, actions: { canRate: false } });

    // ---- 15. The complete history remains available ----
    const timeline = await customer.get<Json>(`/customer/bookings/${bookingId}/timeline`);
    expect((timeline.body['statuses'] as Json[]).map((s) => s['to'])).toEqual([
      'PENDING_PAYMENT',
      'CONFIRMED',
      'ASSIGNED',
      'EN_ROUTE',
      'ARRIVED',
      'IN_PROGRESS',
      'COMPLETED',
      'CLOSED',
    ]);

    const auditor = await createStaff(app, ['AUDITOR']);
    const staff = api.as(await signInStaff(api, auditor));
    const ops = await staff.get<Json>(`/admin/bookings/${bookingId}`);
    expect(ops.status).toBe(200);
    expect((ops.body['timeline'] as Json[]).map((t) => [t['to'], t['event'], t['source']])).toEqual(
      [
        ['PENDING_PAYMENT', 'CREATED', 'CUSTOMER_APP'],
        ['CONFIRMED', 'PAYMENT_CAPTURED', 'PAYMENT_GATEWAY'],
        ['ASSIGNED', 'WORKER_ACCEPTED', 'WORKER_APP'],
        ['EN_ROUTE', 'START_TRAVEL', 'WORKER_APP'],
        ['ARRIVED', 'MARK_ARRIVED', 'WORKER_APP'],
        ['IN_PROGRESS', 'START_SERVICE', 'WORKER_APP'],
        ['COMPLETED', 'COMPLETE_SERVICE', 'WORKER_APP'],
        ['CLOSED', 'CLOSE', 'SYSTEM'],
      ],
    );
    // Auditors see records masked, never raw contact details.
    expect(JSON.stringify(ops.body)).not.toContain(customerSession.phone);
    expect((ops.body['customer'] as Json)['phone']).toMatch(/^\*{6}\d{4}$/);

    const audit = await staff.get<Json[]>(`/admin/audit?entityType=booking&entityId=${bookingId}`);
    expect(audit.body.length).toBeGreaterThanOrEqual(8);
    expect(audit.body.every((row) => row['source'] !== null && row['occurred_at'])).toBe(true);

    // ---- 16. Notifications were produced for each step and delivered ----
    await runJob(app, 'dispatch-notifications');
    const inbox = await customer.get<Json[]>('/customer/notifications');
    expect(inbox.body.map((n) => n['event'])).toEqual(
      expect.arrayContaining([
        'BOOKING_CONFIRMED',
        'PAYMENT_SUCCESSFUL',
        'WORKER_ASSIGNED',
        'WORKER_EN_ROUTE',
        'WORKER_ARRIVED',
        'SERVICE_STARTED',
        'SERVICE_COMPLETED',
      ]),
    );
    // The customer chose Hindi; templates are delivered in Hindi.
    expect(inbox.body.find((n) => n['event'] === 'BOOKING_CONFIRMED')?.['title']).toBe(
      'बुकिंग पक्की हो गई',
    );
  });
});
