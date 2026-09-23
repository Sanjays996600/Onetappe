import { randomInt } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { tomorrowAt } from '../harness/booking.js';
import { otpFor } from '../harness/otp.js';
import { stack } from '../harness/state.js';

/**
 * The HH60 journey across both phone apps (their web builds) and the real API: a new
 * customer signs up, accepts the terms, finds their location, books and pays (sandbox
 * gateway, confirmed by the server's webhook), and the professional accepts the offer,
 * travels, is let in with the customer's start code, completes the job; the customer
 * follows it live, rates it, gets the invoice and contacts support.
 */

const s = stack();

async function phoneContext(browser: Browser) {
  const context = await browser.newContext({
    viewport: { width: 400, height: 860 },
    geolocation: { latitude: s.world.center.lat, longitude: s.world.center.lng },
    permissions: ['geolocation'],
  });
  return context.newPage();
}

async function signIn(page: Page, url: string, phone: string) {
  await page.goto(url);
  await page.getByLabel('Mobile number').fill(phone.slice(3));
  const since = Date.now();
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('Code', { exact: true }).fill(await otpFor(s.apiLog, phone, since));
  await page.getByRole('button', { name: 'Verify' }).click();
  // New accounts are asked to accept the current terms before anything else.
  await page.getByTestId('accept-terms').click();
}

/** Formats as the app does, in the browser (so both use the same locale data). */
const label = (page: Page, iso: string, options: Intl.DateTimeFormatOptions) =>
  page.evaluate(
    ([at, opts]) =>
      new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', ...opts }).format(new Date(at)),
    [iso, options] as const,
  );

test('a customer books, pays and follows the visit while the professional does the job', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const customer = await phoneContext(browser);
  const worker = await phoneContext(browser);
  const customerPhone = `+9197${String(randomInt(10_000_000, 99_999_999))}`;
  const workerPhone = s.world.workers[0]?.phone ?? '';

  // Sign up: number, SMS code, terms, name, location and address.
  await signIn(customer, s.customerUrl, customerPhone);
  await customer.getByLabel('Full name').fill('Priya Sharma');
  await customer.getByRole('button', { name: 'Save' }).click();
  await customer.getByRole('button', { name: 'Use my current location' }).click();
  await expect(customer.getByText('Location found')).toBeVisible();
  await customer.getByLabel('Pincode').fill(s.world.pincode);
  await customer.getByLabel('House / flat number').fill('C-101');
  await customer.getByLabel('City').fill('Noida');
  await customer.getByRole('button', { name: 'Save address' }).click();

  // Choose the service, tomorrow at 4 pm, see the full price, book and pay.
  await expect(customer.getByText('What do you need?')).toBeVisible();
  await customer.getByRole('button', { name: s.world.service.name }).click();
  const start = tomorrowAt(s, 16);
  await customer
    .getByRole('radio', {
      name: await label(customer, start, { weekday: 'short', day: 'numeric', month: 'short' }),
    })
    .click();
  await customer
    .getByRole('radio', {
      name: await label(customer, start, { hour: 'numeric', minute: '2-digit' }),
    })
    .click();
  await expect(customer.getByText('Total')).toBeVisible();
  await customer.getByTestId('book').click();
  await customer.getByTestId('pay-now').click();
  await customer.getByTestId('sandbox-pay').click();
  await expect(customer).toHaveURL(/\/booking\//, { timeout: 30_000 });
  const bookingId = /\/booking\/([0-9a-f-]{36})/.exec(customer.url())?.[1] ?? '';
  await expect(customer.getByText('Confirmed — finding your professional')).toBeVisible();

  // The professional signs in, accepts the terms, goes online and accepts the offer.
  await signIn(worker, s.workerUrl, workerPhone);
  const presence = worker.getByTestId('presence');
  await expect(presence).toBeVisible();
  if ((await presence.textContent()) === 'Go online') await presence.click();
  await expect(worker.getByText('You are online — offers will appear here')).toBeVisible();
  await worker.getByTestId(`accept-${bookingId}`).click({ timeout: 20_000 });
  await expect(worker.getByText('Accepted — start when it is time')).toBeVisible();
  await expect(customer.getByText('Professional assigned')).toBeVisible({ timeout: 15_000 });

  // On the way, arrived, and let in with the customer's start code.
  await worker.getByTestId('on-the-way').click();
  await expect(customer.getByText('Professional is on the way')).toBeVisible({ timeout: 15_000 });
  await worker.getByTestId('arrived').click();
  await expect(customer.getByText('Professional has arrived')).toBeVisible({ timeout: 15_000 });
  await expect(customer.getByText('It is not a payment OTP')).toBeVisible();
  await customer.getByTestId('show-start-code').click();
  const code = ((await customer.getByTestId('start-code').textContent()) ?? '').replace(/\s/g, '');
  expect(code).toMatch(/^\d{4}$/);

  // A wrong code is refused; the right one starts the job.
  const wrong = String((Number(code) + 1) % 10_000).padStart(4, '0');
  await worker.getByLabel('Start code from the customer').fill(wrong);
  await worker.getByTestId('start-job').click();
  await expect(worker.getByText('That code is not correct')).toBeVisible();
  await worker.getByLabel('Start code from the customer').fill(code);
  await worker.getByTestId('start-job').click();
  await expect(worker.getByText('In progress', { exact: true })).toBeVisible();
  await expect(customer.getByText('Service in progress')).toBeVisible({ timeout: 15_000 });
  await expect(customer.getByText('Service started')).toBeVisible();

  // Completion, rating and the invoice.
  await worker.getByTestId('complete-job').click();
  await expect(worker.getByText('Job completed. Thank you!')).toBeVisible();
  await expect(customer.getByText('How was it?')).toBeVisible({ timeout: 15_000 });
  await customer.getByTestId('rate-5').click();
  await customer.getByRole('button', { name: 'Submit rating' }).click();
  await expect(customer.getByText('Thank you for your rating.')).toBeVisible();
  // Settlement (earnings, invoice, closing the booking) runs every minute in the background.
  await expect(customer.getByText('Invoice number')).toBeVisible({ timeout: 90_000 });

  // Support: the request is recorded and gets a case code.
  await customer.getByRole('button', { name: 'Report a problem' }).click();
  await customer.getByRole('radio', { name: 'Price or bill' }).click();
  await customer.getByLabel('Subject').fill('Question about my bill');
  await customer
    .getByLabel('Tell us what happened')
    .fill('Please explain the visit charge on my bill.');
  await customer.getByRole('button', { name: 'Send' }).click();
  await expect(customer.getByText(/We have your request: \S+/)).toBeVisible();

  // Earnings show the job for the professional.
  await worker.getByRole('button', { name: 'Home' }).click();
  await worker.getByRole('button', { name: 'Earnings' }).click();
  await expect(worker.getByText(s.world.service.name).first()).toBeVisible();
});
