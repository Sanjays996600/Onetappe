# One Tappe — GitHub repository controls

These are repository settings, which only a repository admin can change. They cannot be
set from code. The files that support them are in the repository:

- `.github/workflows/ci.yml`
- `.github/workflows/security.yml`
- `.github/CODEOWNERS`
- `.github/dependabot.yml`
- `.github/pull_request_template.md`
- `.gitleaksignore`

## 0. Create `main` (one time)

The repository currently has only the working branch
`claude/appointment-booking-app-design-tqp3ip`. Create `main` from it, then make it the
default branch:

1. **Code → Branches → New branch.** Name `main`, source
   `claude/appointment-booking-app-design-tqp3ip`.
2. **Settings → General → Default branch** → `main`.

From then on, work reaches `main` only through pull requests.

## 1. Ownership and access (Settings → Collaborators and teams)

- The repository belongs to the company's GitHub **organization**, not to a personal
  account. Transfer it if needed: _Settings → General → Transfer_.
- At least two people are organization owners (directors), with two-factor
  authentication required (_Organization settings → Authentication security_).
- Developers get **Write**, never Admin. The CI and deploy credentials belong to the
  organization.

## 2. Ruleset for `main` (Settings → Rules → Rulesets → New branch ruleset)

| Setting                                                            | Value                                                                                                                                                                 |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ruleset name                                                       | `main protection`                                                                                                                                                     |
| Enforcement status                                                 | **Active**                                                                                                                                                            |
| Bypass list                                                        | **Empty** (not even admins; emergencies use a reviewed pull request too)                                                                                              |
| Target branches                                                    | Include default branch (`main`)                                                                                                                                       |
| Restrict deletions                                                 | ✅                                                                                                                                                                    |
| Block force pushes                                                 | ✅                                                                                                                                                                    |
| Require linear history                                             | ✅ (squash or rebase merges only)                                                                                                                                     |
| Require a pull request before merging                              | ✅                                                                                                                                                                    |
| → Required approvals                                               | **1** (raise to 2 once the team has 3+ engineers)                                                                                                                     |
| → Dismiss stale pull request approvals when new commits are pushed | ✅                                                                                                                                                                    |
| → Require review from Code Owners                                  | ✅                                                                                                                                                                    |
| → Require approval of the most recent reviewable push              | ✅ (the author cannot approve their own last change)                                                                                                                  |
| → Require conversation resolution before merging                   | ✅                                                                                                                                                                    |
| Require status checks to pass                                      | ✅, with **Require branches to be up to date before merging** ✅                                                                                                      |
| → Status checks (add each by name)                                 | `format`, `lint`, `typecheck`, `domain-tests`, `migration-guard`, `migrations`, `integration-tests`, `secret-scan`, `dependency-audit`, `dependency-review`, `codeql` |
| Require code scanning results                                      | ✅ CodeQL, alerts ≥ **High**; security alerts ≥ **High**                                                                                                              |
| Require signed commits                                             | Optional (recommended once everyone has signing set up)                                                                                                               |

A status check appears in the picker only after it has run once on a pull request. Open
one small pull request after creating `main`, then add the checks.

## 3. Security features (Settings → Code security)

| Feature                         | Setting                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| Dependency graph                | On                                                                                                |
| Dependabot alerts               | On                                                                                                |
| Dependabot security updates     | On                                                                                                |
| Dependabot version updates      | On (configured by `.github/dependabot.yml`)                                                       |
| Code scanning                   | CodeQL through the `Security` workflow (_Advanced_ setup, so do not also turn on _Default_ setup) |
| Secret scanning                 | On                                                                                                |
| Push protection                 | **On**: pushes containing recognised secrets are blocked before they reach GitHub                 |
| Private vulnerability reporting | On                                                                                                |

## 4. Actions (Settings → Actions → General)

- **Actions permissions:** allow actions created by GitHub, verified creators and the ones
  used here:
  - `pnpm/action-setup`
  - `github/codeql-action`
  - `actions/dependency-review-action`
  - `actions/checkout`
  - `actions/setup-node`
- **Workflow permissions:** _Read repository contents_ (the workflows ask for more only
  where needed).
- **Fork pull request workflows:** require approval for all outside collaborators.

## 5. Environments and deployment (when deployment is set up)

Settings → Environments:

- `staging`: deploys automatically from `main`.
- `production`: requires **2 reviewers** (directors or tech lead) and deploys only from
  `main`. It holds the deploy role, not application secrets; those stay in the cloud
  secret manager.

Migrations run as a separate, gated step before the new version starts. They use the owner
credential available only to that step.

## 6. What each check proves

| Check                         | Proves                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `format`, `lint`, `typecheck` | Code style, strict type-checked lint rules, TypeScript types, production build                                                  |
| `domain-tests`                | State machine, pricing and capacity rules                                                                                       |
| `migration-guard`             | No existing migration was edited, renamed or removed; new ones are numbered after the last                                      |
| `migrations`                  | All migrations apply to an empty database, re-running applies nothing, generated DB types are current                           |
| `integration-tests`           | 22 test files (241 tests) over HTTP against PostgreSQL 16, run as the least-privilege role, with real ClamAV and an S3 emulator |
| `secret-scan`                 | No secrets in the full git history (gitleaks)                                                                                   |
| `dependency-audit`            | No known high or critical vulnerabilities in dependencies                                                                       |
| `dependency-review`           | A pull request adds no vulnerable dependency                                                                                    |
| `codeql`                      | Static security analysis (security-extended queries)                                                                            |
