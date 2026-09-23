# One Tappe

Home-services booking platform: customer app, worker app and operations panel on one API.
Launching in Noida with **HH60 House Help**; services, areas and prices are configuration.

| Document                                                   | Contents                                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| [docs/01-system-design.md](docs/01-system-design.md)       | Decisions, architecture, data model, booking engine, guarantees, status    |
| [docs/02-ui-ux-screen-map.md](docs/02-ui-ux-screen-map.md) | Customer app, worker app and admin panel screens with the APIs behind them |
| [docs/03-inputs-needed.md](docs/03-inputs-needed.md)       | Decisions log and the information still needed                             |
| [docs/04-api-and-security.md](docs/04-api-and-security.md) | Auth, roles, PII, full API list, payments, jobs, environments, CI          |

## Repository

```
apps/api          NestJS API, SQL migrations, integration tests
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
| `test`       | fixed test code    | sandbox            | wiped on every test run          |
| `staging`    | MSG91              | Razorpay test keys | staging database, no real people |
| `production` | MSG91              | Razorpay live keys | company-owned production account |

The API refuses to start with a combination that breaks these rules; see
[docs/04-api-and-security.md §1](docs/04-api-and-security.md#1-environments). Secrets are never
committed; staging and production values live in the company's secret manager.

Checks run in CI on every push and pull request, as six separate jobs: `format`, `lint`,
`typecheck` (+ build), `domain-tests`, `migrations` (apply, re-apply is a no-op, generated
types current) and `integration-tests`. To block merging until they pass, enable branch
protection on `main` with these six as required status checks (GitHub → Settings → Branches).

## Database changes

1. Add `apps/api/migrations/NNNN_description.sql` (never edit an applied migration).
2. `pnpm db:migrate`
3. `pnpm db:codegen` to regenerate `apps/api/src/database/db.generated.ts`, and commit it.
