import { expect, test, type Browser, type Cookie, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { paidBooking } from '../harness/booking.js';
import { stack } from '../harness/state.js';

/**
 * The operations panel in a real browser against the real API. The first administrator
 * (created by the bootstrap command) accepts the invitation and enrols an authenticator,
 * invites an operations head, who does the same and then works bookings: a versioned
 * change, a concurrent-edit conflict, the trace, and signing out.
 */

const s = stack();

/** A staff member with their own authenticator app and browser session. */
class Person {
  secret = '';
  private lastStep = 0;
  cookies: Cookie[] = [];
  constructor(
    readonly email: string,
    readonly password: string,
  ) {}

  /** A code from a 30-second step this person has not used yet (the API refuses reuse). */
  async code(): Promise<string> {
    while (Math.floor(Date.now() / 30_000) <= this.lastStep)
      await new Promise((r) => setTimeout(r, 500));
    this.lastStep = Math.floor(Date.now() / 30_000);
    return new OTPAuth.TOTP({
      secret: OTPAuth.Secret.fromBase32(this.secret),
      digits: 6,
      period: 30,
    }).generate();
  }

  async acceptInvitation(page: Page, link: string) {
    await page.goto(link);
    await page.getByLabel('New password').fill(this.password);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.locator('.notice')).toContainText('Password set. Sign in to continue.');
  }

  async signIn(page: Page) {
    await page.goto(`${s.adminUrl}/login`);
    await page.getByLabel('Work email').fill(this.email);
    await page.getByLabel('Password').fill(this.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/login\/mfa/);
    const enrol = page.getByTestId('totp-secret');
    if (await enrol.count()) this.secret = (await enrol.textContent()) ?? '';
    await page.getByLabel('6-digit code').fill(await this.code());
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    this.cookies = await page.context().cookies();
  }

  /** Continues the signed-in session in a fresh page (staff sign in once, not per screen). */
  async page(browser: Browser): Promise<Page> {
    const page = await (await browser.newContext()).newPage();
    await page.context().addCookies(this.cookies);
    return page;
  }
}

const director = new Person(s.superAdmin.email, 'director passphrase 2026 noida');
const opsHead = new Person(
  `ops.head.${Date.now()}@onetappe.test`,
  'ops head passphrase 2026 noida',
);

/** The form of one booking action (each has its own reason field). */
async function holdForm(page: Page, reason: string) {
  const form = page
    .locator('details.action')
    .filter({ has: page.locator('summary', { hasText: 'Put on hold' }) });
  await form.locator('summary').click();
  await form.getByLabel('Reason (recorded with the change)').fill(reason);
  return form.getByRole('button', { name: 'Put on hold' });
}

test.describe.configure({ mode: 'serial' });

test('the first administrator accepts the invitation, chooses a password and enrols an authenticator', async ({
  page,
}) => {
  const link = `${s.adminUrl}/accept-invitation?token=${s.superAdmin.invitationToken}`;
  await director.acceptInvitation(page, link);

  // The same link cannot be used twice.
  await page.goto(link);
  await page.getByLabel('New password').fill(director.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('.notice')).toContainText('invalid or has expired');

  await director.signIn(page);
  expect(director.secret).toMatch(/^[A-Z2-7]+=*$/);
  // The super administrator manages staff and the platform, not bookings.
  await expect(page).toHaveURL(/\/staff/);
  await expect(page.getByRole('link', { name: 'Bookings' })).toHaveCount(0);
});

test('the session lives only in an httpOnly cookie, and pages carry a strict CSP', async ({
  browser,
}) => {
  const page = await director.page(browser);
  const response = await page.goto(`${s.adminUrl}/staff`);
  const session = (await page.context().cookies()).find((c) => c.name.endsWith('ot_session'));
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe('Strict');
  expect(session?.value.split('.')).toHaveLength(1); // sealed, not a readable JWT
  const csp = response?.headers()['content-security-policy'] ?? '';
  expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(response?.headers()['cache-control']).toContain('no-store');
  expect(await page.evaluate(() => document.cookie)).not.toContain('ot_session');
});

test('the administrator invites an operations head, who sets up their own access', async ({
  browser,
}) => {
  const page = await director.page(browser);
  await page.goto(`${s.adminUrl}/staff`);
  await page.getByText('Invite a staff member').click();
  const form = page.locator('details.action', { hasText: 'Invite a staff member' });
  await form.getByLabel('Work email').fill(opsHead.email);
  await form.getByLabel('Full name').fill('Neha Gupta');
  await form.getByLabel('Role').selectOption('OPERATIONS_HEAD');
  await form.getByLabel('Reason (recorded with the change)').fill('New operations head for Noida');
  await form.getByRole('button', { name: 'Send invitation' }).click();
  const link = (await page.getByTestId('invitation-link').textContent()) ?? '';
  expect(link).toContain('/accept-invitation?token=');
  // The link is not in the address bar (or browser history).
  expect(page.url()).not.toContain('token=');

  const invitee = await (await browser.newContext()).newPage();
  await opsHead.acceptInvitation(invitee, link);
  await opsHead.signIn(invitee);
  await expect(invitee.getByRole('heading', { name: 'Live board' })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('row', { name: /Neha Gupta/ })).toContainText('Enrolled');
});

test('find a booking, put it on hold with a reason, and see the change and its trace', async ({
  browser,
}) => {
  const booking = await paidBooking(s, 10);
  const page = await opsHead.page(browser);
  await page.goto(s.adminUrl);
  await page.getByRole('link', { name: 'Bookings' }).click();
  await page.getByLabel('Booking code').fill(booking.code);
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('link', { name: booking.code }).click();
  await expect(page.getByRole('heading', { name: new RegExp(booking.code) })).toContainText(
    'Confirmed',
  );

  await (await holdForm(page, 'Customer travelling, will confirm')).click();
  await expect(page.locator('.notice')).toContainText('Change saved.');
  await expect(page.getByRole('heading', { name: new RegExp(booking.code) })).toContainText(
    'On hold',
  );
  await expect(page.getByRole('cell', { name: 'Customer travelling, will confirm' })).toBeVisible();

  await page.getByRole('link', { name: 'Full trace' }).click();
  await expect(page.getByRole('heading', { name: 'Full trace' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'status', exact: true }).first()).toBeVisible();
});

test('two people changing the same booking: the second is told to refresh, nothing is overwritten', async ({
  browser,
}) => {
  const booking = await paidBooking(s, 12);
  const url = `${s.adminUrl}/bookings/${booking.id}`;
  const first = await opsHead.page(browser);
  const second = await opsHead.page(browser);
  await first.goto(url);
  await second.goto(url);

  const firstSubmit = await holdForm(first, 'Pausing on customer request');
  const secondSubmit = await holdForm(second, 'Pausing on customer request');
  await firstSubmit.click();
  await expect(first.locator('.notice')).toContainText('Change saved.');
  await secondSubmit.click();
  await expect(second.locator('.notice')).toContainText('Someone else changed this booking');
  await expect(second.getByRole('heading', { name: new RegExp(booking.code) })).toContainText(
    'On hold',
  );
});

test('signing out ends the session', async ({ browser }) => {
  const page = await opsHead.page(browser);
  await page.goto(s.adminUrl);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto(`${s.adminUrl}/bookings`);
  await expect(page).toHaveURL(/\/login\?next=%2Fbookings/);
});
