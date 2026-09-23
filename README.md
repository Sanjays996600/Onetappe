# One Tappe

Home-services booking platform: customer app, worker app and operations panel on one API.
Launching in Noida with **HH60 House Help**; services, areas and prices are configuration.

| Document                                                                     | Contents                                                                                                 |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [docs/01-system-design.md](docs/01-system-design.md)                         | Decisions, architecture, data model, booking engine, guarantees, status                                  |
| [docs/02-ui-ux-screen-map.md](docs/02-ui-ux-screen-map.md)                   | Customer app, worker app and admin panel screens with the APIs behind them                               |
| [docs/03-inputs-needed.md](docs/03-inputs-needed.md)                         | Decisions log and the information still needed                                                           |
| [docs/04-api-and-security.md](docs/04-api-and-security.md)                   | Auth, roles, PII, full API list, payments, jobs, environments, CI                                        |
| [docs/05-architecture.md](docs/05-architecture.md)                           | Component diagram, source of truth per data type, Zoho and Razorpay boundaries, tested failure behaviour |
| [docs/06-security-review.md](docs/06-security-review.md)                     | Security review, open security items                                                                     |
| [docs/07-operations-and-recovery.md](docs/07-operations-and-recovery.md)     | Monitoring, alerts, backups, RPO/RTO, restore procedure                                                  |
| [docs/08-provider-setup.md](docs/08-provider-setup.md)                       | Razorpay, MSG91, Zoho, FCM, email, S3, PostgreSQL setup and launch checks                                |
| [docs/09-github-controls.md](docs/09-github-controls.md)                     | Exact GitHub ruleset and security settings                                                               |
| [docs/10-system-matrix.md](docs/10-system-matrix.md)                         | Status of every component, and what must happen before UI and production                                 |
| [docs/12-production-readiness-gate.md](docs/12-production-readiness-gate.md) | Engineering gate: verified status of every component, load and concurrency results, open questions       |
| [docs/11-security-readiness.md](docs/11-security-readiness.md)               | Security and readiness review: data map, authorization, SOS, recovery, blockers before pilot/production  |

## Repository

```
apps/api          NestJS API, SQL migrations, integration tests
apps/admin        Operations panel (Next.js; server-side session, no tokens in the browser)
apps/customer     Customer app (React Native + Expo)
apps/worker       Worker (partner) app (React Native + Expo)
packages/mobile-kit  Components, copy and helpers shared by the two phone apps
packages/api-client  Typed API client shared by the admin panel and the mobile apps
e2e               Browser tests of the whole system (Playwright)
packages/domain   Booking state machine, pricing and capacity rules (no framework code)
infra             Local PostgreSQL via docker compose
```

## Local development

Requirements: Node 22, pnpm 10, PostgreSQL 16 (or Docker).

```bash
pnpm install
docker compose -f infra/docker-compose.yml up -d     # or use a local PostgreSQL 16
cp apps/api/.env.example apps/api/.env
pnpm build                                           # builds @onetappe/domain for the API
pnpm db:migrate                                      # applies apps/api/migrations
pnpm test                                            # unit + integration tests
```

`TEST_DATABASE_URL` must point to a database whose name contains `test`; it is wiped and
re-migrated on every test run.

Run the API and the background worker (a separate process) after `pnpm build`:

```bash
pnpm --filter @onetappe/api start          # HTTP API on :3000, routes under /api/v1
pnpm --filter @onetappe/api start:worker   # expiry, offers, re-dispatch, notifications, payments
```

Locally, OTP codes are printed to the API log and payments use the signed sandbox gateway.
Complete a sandbox payment with `POST /api/v1/sandbox/payments/:orderId`, body
`{ "outcome": "capture" | "fail" }`. The route exists only while `PAYMENT_PROVIDER=sandbox`,
which production refuses.

## Environments

| `APP_ENV`    | OTP                | Payments           | Data                             |
| ------------ | ------------------ | ------------------ | -------------------------------- |
| `local`      | printed to the log | sandbox            | developer database               |
| `test`       | captured by tests  | sandbox            | wiped on every test run          |
| `staging`    | MSG91              | Razorpay test keys | staging database, no real people |
| `production` | MSG91              | Razorpay live keys | company-owned production account |

The API refuses to start with a combination that breaks these rules; see
[docs/04-api-and-security.md §1](docs/04-api-and-security.md#1-environments). Secrets are never
committed; staging and production values live in the company's secret manager.

Every push and pull request runs the `CI` workflow (`format`, `lint`, `typecheck` + build,
`domain-tests`, `migration-guard`, `migrations`, `integration-tests`) and the `Security`
workflow (`secret-scan`, `dependency-audit`, `dependency-review`, `codeql`). The branch
protection that makes them required is a repository setting; see
[docs/09-github-controls.md](docs/09-github-controls.md).

The first staff account of a new environment is created once with
`pnpm --filter @onetappe/api staff:bootstrap --email <email> --name "<name>"`; all later
accounts are invited from the admin panel.

## Browser tests (end to end)

`e2e/` starts the real system and drives it with Playwright:

- a fresh `onetappe_e2e` database;
- the API and background worker from `apps/api/dist`;
- the admin panel from its production build;
- the web builds of the customer and worker apps, built against that API (the web build
  exists for these tests; the apps ship on Android and iOS).

`E2E_SKIP_APP_BUILD=1` reuses the existing app builds while iterating on tests.

Build first, then run:

```bash
pnpm build
pnpm --filter @onetappe/e2e exec playwright install chromium   # once
pnpm --filter @onetappe/e2e test
```

`E2E_OWNER_URL` points at the database; its name must contain `e2e`. `E2E_CHROMIUM_PATH`
uses an already installed Chromium. Service logs and traces of a failed run are in
`e2e/.state/logs` and `e2e/test-results`.

## Database changes

1. Add `apps/api/migrations/NNNN_description.sql`. Never edit, rename or delete an existing
   migration (CI's `migration-guard` refuses it).
2. `pnpm db:migrate`
3. `pnpm db:codegen` to regenerate `apps/api/src/database/db.generated.ts`, and commit it.
