# One Tappe

Home-services booking platform: customer app, worker app and operations panel on one API.
Launching in Noida with **HH60 House Help**; services, areas and prices are configuration.

| Document                                                   | Contents                                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| [docs/01-system-design.md](docs/01-system-design.md)       | Decisions, architecture, data model, booking engine, guarantees, status    |
| [docs/02-ui-ux-screen-map.md](docs/02-ui-ux-screen-map.md) | Customer app, worker app and admin panel screens with the APIs behind them |
| [docs/03-inputs-needed.md](docs/03-inputs-needed.md)       | Decisions log and the information still needed                             |

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

Checks run in CI on every push: formatting, lint, typecheck, build, migrations, generated
database types up to date, tests.

## Database changes

1. Add `apps/api/migrations/NNNN_description.sql` (never edit an applied migration).
2. `pnpm db:migrate`
3. `pnpm db:codegen` to regenerate `apps/api/src/database/db.generated.ts`, and commit it.
