# Decisions log and open items

## Decided (22 Sep 2026)

| Topic                | Decision                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Booking sources      | Customer self-booking from day 1 **and** manual booking by operations (`CUSTOMER_APP`, `ADMIN`).                                                 |
| First service        | HH60 House Help. Catalog is fully data-driven for later services.                                                                                |
| Stack                | TypeScript, NestJS, PostgreSQL, Next.js admin; modular monolith, one database.                                                                   |
| Mobile               | Native customer and worker apps on the same API; PWA allowed for the worker pilot.                                                               |
| Languages            | English and Hindi from the start; more languages as data.                                                                                        |
| Booking rules        | Database is the final authority on availability; original promise stored permanently; full audit trail.                                          |
| Launch city          | Noida — configured as data, not in code.                                                                                                         |
| Pricing              | Rule-based (service, zone, duration, time, tax, discount, promo, extra charges); worker payout separate.                                         |
| Accounts             | All production accounts company-owned; developers get role-based access.                                                                         |
| Authentication       | Customers and workers: phone + OTP, no passwords. Staff: email + password + authenticator app (MFA).                                             |
| Staff roles          | Eight roles with granular permissions; no universal admin; PII masked unless revealed (audited).                                                 |
| Payments             | Razorpay first, behind a provider interface; paid only on server-verified gateway events.                                                        |
| OTP delivery         | Behind a provider interface; MSG91 adapter first. Test OTP only in automated tests.                                                              |
| Mobile apps (23 Sep) | React Native + Expo for the customer and worker apps (one TypeScript codebase each for Android and iOS; shares the API client and domain rules). |
| Maps (23 Sep)        | Google Maps Platform: map pin and address search in the apps; company Google Cloud billing account.                                              |

## Still needed from One Tappe

| #   | Item                                                                                                                                          | Needed for                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 1   | Noida launch zones: localities, pincodes, zone centre points and service radius                                                               | Service-area configuration             |
| 2   | HH60 price, GST treatment (confirmed by CA), any instant/evening charges, launch promo codes                                                  | Pricing rules                          |
| 3   | HH60 task list (and what is excluded), in English and Hindi                                                                                   | Catalog, app copy                      |
| 4   | Worker payout for HH60 (job pay, travel allowance)                                                                                            | Payout rules                           |
| 5   | Which worker verifications and training are mandatory for HH60                                                                                | Eligibility rules                      |
| 6   | Payment policy: prepaid only in the app? cancellation / refund rules and timings                                                              | Payment and refund flows               |
| 7   | Legal entity name, GSTIN, invoice series format                                                                                               | Invoices                               |
| 8   | Providers still to choose: WhatsApp Business, maps, push, email, monitoring (Razorpay and MSG91 are the current choices for payments and OTP) | Integrations (sandbox keys first)      |
| 9   | Customer terms, privacy notice, worker terms (final text from counsel)                                                                        | Consent screens                        |
| 10  | Brand assets: logo, colours, fonts                                                                                                            | Design tokens                          |
| 11  | Staff list with roles (and city scope) for the first admin accounts                                                                           | Seeding users                          |
| 12  | Company Razorpay account: test-mode keys for staging, webhook secret, automatic capture turned on                                             | Running payments against Razorpay      |
| 13  | Company MSG91 account: auth key, DLT-registered sender id and OTP template (en/hi)                                                            | Real OTP SMS in staging                |
| 14  | Company cloud storage bucket (S3-compatible, encrypted, private) for worker documents                                                         | Production start                       |
| 15  | Create `main` and apply the GitHub ruleset and security settings in [09-github-controls.md](09-github-controls.md) (repository admin)         | Merge safety (before UI work)          |
| 16  | Cancellation and refund rules (who pays what, when)                                                                                           | Replacing the default full-refund rule |
| 17  | Google Maps Platform keys (Android, iOS, web), restricted to the apps' identifiers, from the company Google Cloud account                     | Customer app location step (before UI) |
| 18  | Live worker location on the customer's tracking screen at launch, or status-based tracking only                                               | Tracking scope                         |
| 19  | Named on-call people (and phone numbers) to be paged for SOS / critical safety incidents                                                      | Safety escalation                      |
| 20  | How workers are paid: payout frequency, bank transfer method (manual batch / RazorpayX), who approves                                         | Worker payouts                         |
| 21  | Company cloud account (AWS recommended, `ap-south-1`) for staging and production: database, S3, KMS, secrets, monitoring                      | Staging, provider verification         |
| 22  | Worker document retention period after offboarding (counsel)                                                                                  | `documents.retention` setting          |
| 23  | GST treatment and invoice series confirmed by the CA                                                                                          | Invoices                               |

## Design questions to confirm

| #   | Question                                                                                     | Current default                                                                        |
| --- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Q1  | Payment window after booking before the worker hold is released                              | 10 minutes (per service, configurable)                                                 |
| Q2  | Time a worker has to accept an offer                                                         | 3 minutes (per service, configurable)                                                  |
| Q3  | Scheduled start times on a 15-minute grid; minimum lead time and booking horizon per service | 60 minutes lead time, 14 days ahead (configurable per service)                         |
| Q4  | Instant booking for HH60 at launch?                                                          | Supported by the engine; switch on per service when worker supply allows               |
| Q5  | When a customer reschedules an assigned booking, the worker must accept the new time again   | Yes — the previous worker stays eligible; preferring them first is a possible addition |
| Q6  | Can a customer cancel once the worker is en route? Is a fee charged?                         | Allowed (status permits it); fee policy pending your cancellation rules                |
