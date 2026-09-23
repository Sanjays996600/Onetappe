## What changes and why

<!-- The problem, the change, and anything a reviewer should look at first. -->

## How it was verified

- [ ] Tests added or updated for the new behaviour (and for the failure cases)
- [ ] `pnpm lint`, `pnpm format:check`, `pnpm typecheck` and the API tests pass locally

## Safety checklist

- [ ] **Migrations**: new files only (existing migrations are never edited); `pnpm db:codegen` re-run; safe to apply while the previous release is still serving traffic
- [ ] **Money**: payment state changes only from server-verified gateway data; amounts in paise; idempotent
- [ ] **Access**: every new endpoint has an app/role/permission check and cannot reach another user's records
- [ ] **Personal data**: no phone numbers, addresses or document contents in logs, errors, metrics or analytics
- [ ] **Secrets**: none committed; new settings added to `.env.example` with placeholder values only
- [ ] **Configuration**: business values (prices, cities, rules) come from audited configuration, not code
- [ ] **External services** (Razorpay, MSG91, Zoho, FCM, email): failure or slowness cannot corrupt a booking

## Deployment notes

<!-- New environment variables, provider settings, manual steps, or "none". -->
