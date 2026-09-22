# Decisions log and open items

## Decided (22 Sep 2026)

| Topic           | Decision                                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| Booking sources | Customer self-booking from day 1 **and** manual booking by operations (`CUSTOMER_APP`, `ADMIN`).         |
| First service   | HH60 House Help. Catalog is fully data-driven for later services.                                        |
| Stack           | TypeScript, NestJS, PostgreSQL, Next.js admin; modular monolith, one database.                           |
| Mobile          | Native customer and worker apps on the same API; PWA allowed for the worker pilot.                       |
| Languages       | English and Hindi from the start; more languages as data.                                                |
| Booking rules   | Database is the final authority on availability; original promise stored permanently; full audit trail.  |
| Launch city     | Noida — configured as data, not in code.                                                                 |
| Pricing         | Rule-based (service, zone, duration, time, tax, discount, promo, extra charges); worker payout separate. |
| Accounts        | All production accounts company-owned; developers get role-based access.                                 |

## Still needed from One Tappe

| #   | Item                                                                                             | Needed for                        |
| --- | ------------------------------------------------------------------------------------------------ | --------------------------------- |
| 1   | Noida launch zones: localities, pincodes, zone centre points and service radius                  | Service-area configuration        |
| 2   | HH60 price, GST treatment (confirmed by CA), any instant/evening charges, launch promo codes     | Pricing rules                     |
| 3   | HH60 task list (and what is excluded), in English and Hindi                                      | Catalog, app copy                 |
| 4   | Worker payout for HH60 (job pay, travel allowance)                                               | Payout rules                      |
| 5   | Which worker verifications and training are mandatory for HH60                                   | Eligibility rules                 |
| 6   | Payment policy: prepaid only in the app? cancellation / refund rules and timings                 | Payment and refund flows          |
| 7   | Legal entity name, GSTIN, invoice series format                                                  | Invoices                          |
| 8   | Providers chosen for: payment gateway, SMS/OTP, WhatsApp Business, maps, push, email, monitoring | Integrations (sandbox keys first) |
| 9   | Customer terms, privacy notice, worker terms (final text from counsel)                           | Consent screens                   |
| 10  | Brand assets: logo, colours, fonts                                                               | Design tokens                     |
| 11  | Staff list with roles (and city scope) for the first admin accounts                              | Seeding users                     |

## Design questions to confirm

| #   | Question                                                                                     | Current default                                                                        |
| --- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Q1  | Payment window after booking before the worker hold is released                              | 10 minutes (per service, configurable)                                                 |
| Q2  | Time a worker has to accept an offer                                                         | 3 minutes (per service, configurable)                                                  |
| Q3  | Scheduled start times on a 15-minute grid; minimum lead time and booking horizon per service | 60 minutes lead time, 14 days ahead (configurable per service)                         |
| Q4  | Instant booking for HH60 at launch?                                                          | Supported by the engine; switch on per service when worker supply allows               |
| Q5  | When a customer reschedules an assigned booking, the worker must accept the new time again   | Yes — the previous worker stays eligible; preferring them first is a possible addition |
| Q6  | Can a customer cancel once the worker is en route? Is a fee charged?                         | Allowed (status permits it); fee policy pending your cancellation rules                |
