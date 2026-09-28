# One Tappe: working rules

These rules apply to every change in this repository. Carry them into any new project too.

## Design

- Design every component against [docs/13-system-design-guidelines.md](docs/13-system-design-guidelines.md). Follow its "How to apply these guidelines" steps, name the chapter or pattern you used, and write down the trade-off in the docs.
- Follow the method in order: INSPECT → TEST → DOCUMENT → IDENTIFY GAPS → CLASSIFY RISKS → ASK QUESTIONS → FIX FOUNDATION → RETEST → STAGING → SECURITY REVIEW → REAL DEVICE TEST → PRODUCTION.
- Ask before you assume anything about business rules, legal matters, infrastructure or credentials. Don't silently make business decisions on behalf of One Tappe.
- Keep booking, pricing, availability and payment state authoritative in PostgreSQL behind the API. Never move it into the mobile apps or Zoho, and never duplicate that logic in the apps.
- Don't add unnecessary microservices. Don't rewrite correctly designed and tested components just for style.

## No shortcuts

- NO SHORTCUTS. If something needs more time to implement correctly, say so.
- Never weaken security, bypass authorization or disable failing security tests to go faster.
- Never suppress errors to make tests pass. Root-cause flaky tests; never skip or quarantine them.
- Don't hard-code secrets or commit them. Never use production credentials or data during development or testing.
- Don't trust frontend state. Never mark a booking PAID because the app says so. Verify payment server-side through the provider's webhook. Webhook processing must be idempotent. Never store card data.
- Production must have no universal, static, master or test OTP.
- A Zoho outage must not take down bookings.
- Never expose PostgreSQL to the public internet. Never manipulate production data by hand instead of fixing the system.
- Don't copy sensitive customer data between systems unnecessarily.
- Company-owned accounts and credentials only.

## Code quality

- Write clean, well-structured code in the style of the surrounding code: clear module boundaries, small single-purpose functions, explicit types, and names that match the domain.
- Enforce invariants in the database (constraints, unique keys, exclusion constraints) as well as in code.
- Validate every input at the API boundary. Check authorization on every route and every object (no IDOR/BOLA).
- Keep external calls out of database transactions. Use the outbox and leased jobs for side effects.
- Money is stored as integer minor units, never floating point.
- Every change comes with tests: unit tests, integration tests, and concurrency or failure tests where relevant.
- Before every push, run `pnpm lint`, `pnpm format:check`, `pnpm typecheck` and `pnpm test`. Run Prettier from the repo root so `.prettierignore` applies.
- Regenerate generated files with the tooling (`pnpm db:codegen`), never by hand.
