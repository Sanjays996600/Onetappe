# What we need before development starts

Status: **OPEN — please answer**. Each item says why it matters and what happens if it is
not decided (the default we will assume).

## A. Product decisions (needed first — they change the design)

| # | Question | Why it matters | Default if undecided |
|---|---|---|---|
| A1 | **Who creates bookings in version 1?** (a) Only the desk, from WhatsApp/phone; (b) desk **and** customer self-booking through the portal | The PDF recommends WhatsApp + phone intake with a controlled register (V22, A24). Self-booking adds the full C-01…C-09 flow. | (a) desk intake + customer **quote/accept/track links**; self-booking right after |
| A2 | **Which services are in the first release?** | Each service has its own screens, checks and release gate | `HH60` house help only; others in Phase 2/3 |
| A3 | **Worker app: PWA (installable web app) or native Android?** | Native needs Play Store account and more build time; PWA is faster and works on most Android phones | PWA |
| A4 | **Languages** | All screens and templates must be written and reviewed in each language | English + Hindi |
| A5 | Keep `INCIDENT_OPEN` / `REFUND_PENDING` as **flags** instead of lifecycle states? (see system design §5.2) | Affects state machine | Flags |
| A6 | Payment: advance before confirmation, or pay after service? Cash allowed? | Changes C-11 and the CONFIRMED rule | Payment link after confirmation, pay-after-service allowed, cash with numbered receipt |

## B. Technical decisions

| # | Question | Default |
|---|---|---|
| B1 | Is the proposed stack OK (TypeScript, NestJS, PostgreSQL, Next.js)? Does anyone on your team already know a different stack they must maintain? | Proposed stack |
| B2 | Cloud account for hosting (India region) — do you have AWS / GCP / Azure, or should we plan for a simpler host? | AWS Mumbai |
| B3 | Domain name (e.g. `onetappe.in`) and who controls DNS | — needed |
| B4 | Payment provider (Razorpay / Cashfree / other) — account in the **company's** name | Razorpay test mode for development |
| B5 | SMS/OTP provider and WhatsApp Business number (company-owned) | Console logs OTP in development |
| B6 | Monthly hosting budget ceiling | Keep under a small fixed amount; single region, single DB |

## C. Business data (can arrive during development; needed before launch)

| # | Item | Source in PDF |
|---|---|---|
| C1 | Legal entity name, address, GSTIN, signatory (is it *Tap Buzz Technologies Pvt Ltd*?) | A02, A40 |
| C2 | Brand: logo, colours, fonts (or permission to propose them) | — |
| C3 | First locality: name, pincodes / streets, map boundary, exclusions | V05, A06 |
| C4 | Staffed desk hours and after-hours message | V04, A02 |
| C5 | Approved prices and tax per SKU (signed by CA) | A29, A32 |
| C6 | Customer terms, privacy notice, cancellation/refund policy text (from counsel) | A28, A31 |
| C7 | Support phone, grievance officer name and contact | A22, A38 |
| C8 | HH60 task list and exclusions as you want them shown to customers | A11 |
| C9 | Worker rate card (job pay, travel, waiting) | A10, A32 |
| C10 | Names of the people in each role + backups (to create accounts) | V04 |
| C11 | Invoice number format and issuing entity per service | A23 |

## D. Things I will prepare once A and B are answered

1. Repository scaffold (monorepo, CI, linting, local Docker database).
2. Database schema + migrations for Phase 1 with the constraints in the design.
3. Design tokens and component library, then screen-by-screen UI in the order of the
   HH60 walk-through.
4. Seed data with **synthetic** people only.
