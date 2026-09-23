# One Tappe — Operations, monitoring, backup and disaster recovery

The first part (monitoring) describes what the code provides today. The second part
(backup and recovery) is the plan the infrastructure must implement before production.
It cannot be built in this repository because it lives in the company's cloud account.

## 1. Health and monitoring (built)

| What                         | Where                                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Liveness / readiness         | `GET /api/v1/health/live`, `GET /api/v1/health/ready` (readiness checks the database)                                |
| Worker liveness              | `GET /health/live` on the worker's internal port (`WORKER_METRICS_PORT`, default 9464)                               |
| Metrics (Prometheus)         | API: `GET /api/v1/metrics`; worker: `GET /metrics` on 9464. Bearer `METRICS_TOKEN` is required outside local/test    |
| Structured logs              | One JSON line per event on stdout, with `requestId`, `bookingId`, `actorUserId` and `job`. Personal data is redacted |
| Booking trace                | `GET /admin/bookings/:id/trace`: everything that happened to one booking, with request ids                           |
| System status for operations | `GET /admin/system/status`: job runs, backlogs, integration state, payment and refund problems                       |
| Integration control          | `GET /admin/integrations`, events, retry, discard, resume (audited)                                                  |
| Alert rules                  | `infra/monitoring/alerts.yml`                                                                                        |

**Metrics:**

- `onetappe_http_request_duration_seconds` (route pattern, method, status)
- `onetappe_job_runs_total` and `onetappe_job_duration_seconds` (job, outcome)
- `onetappe_backlog` and `onetappe_backlog_oldest_waiting_seconds`, for:
  - notifications;
  - integration events by state;
  - open payments and payment event errors;
  - failed refunds;
  - open critical safety incidents;
  - confirmed bookings without a worker.
- `onetappe_integration_paused`
- Node process metrics.

**Alerts** (in `infra/monitoring/alerts.yml`):

| Severity | Alerts                                                                                                                                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Critical | `ApiDown`, `WorkerDown`, `ApiErrorRateHigh`, `SafetyIncidentOpen`                                                                                                                                                          |
| Warning  | `ApiLatencyHigh`, `JobFailing`, `NotificationBacklog`, `IntegrationPaused`, `IntegrationDeadEvents`, `IntegrationBacklogOld`, `PaymentsUnresolved`, `PaymentEventProblems`, `RefundsFailed`, `ConfirmedBookingsUnassigned` |

**Security events in the audit log:** failed staff logins and lockouts, access denied,
personal-data reveals, document views, and every configuration and role change.

**Still to set up (infrastructure):**

- a Prometheus/Grafana (or managed equivalent) that scrapes both processes;
- Alertmanager routes. Critical alerts page the on-call person; warnings go to the
  operations channel;
- a log store with 90-day retention, with access limited to engineering and audit;
- an uptime check from outside the cloud;
- database metrics from the managed service: connections, CPU, storage, replication lag
  and slow queries;
- a dashboard per alert above.

## 2. What is backed up

| Data                       | Where it lives              | Backup                                                                                           |
| -------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------ |
| All business data          | Managed PostgreSQL 16       | Continuous WAL archiving (point-in-time recovery) + daily snapshots                              |
| Worker documents           | Private S3 bucket (SSE-KMS) | Bucket versioning + replication to a second region / backup account                              |
| Secrets                    | Cloud secret manager        | Managed by the secret manager (versioned); the break-glass copy is kept offline by the directors |
| Code, migrations           | GitHub                      | GitHub, plus the container images in the registry for every release                              |
| Zoho, Razorpay, MSG91 data | Those providers             | Not ours to back up. Our records of payments, cases and notifications are in PostgreSQL          |

## 3. Targets

| Target                           | Value                        | Why                                                                                        |
| -------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------ |
| RPO (maximum data loss)          | 5 minutes                    | Continuous WAL archiving; bookings and payments are the business                           |
| RTO (time to restore service)    | 2 hours                      | Restore to a new instance, repoint the API; payments reconcile themselves from Razorpay    |
| High availability (zone failure) | Automatic failover, < 2 min  | Multi-AZ managed PostgreSQL; the API reconnects by itself (tested in `resilience.test.ts`) |
| Snapshot retention               | 35 days daily; 12 monthly    | Point-in-time recovery for 35 days; monthly for audits                                     |
| Document backup retention        | Follows the retention policy | Deleted documents must not survive in backups beyond the legal period (counsel to confirm) |

## 4. Protection of backups

- Encrypted with a KMS key separate from the production data key.
- Copied daily to a **separate cloud account** with write-once (object lock) storage.
  Deleting production then cannot delete the backups, whether by mistake or through a
  compromised credential.
- Only two named people can restore: the CTO and one director. Access is logged, and
  restores are announced in the operations channel.
- Backups hold the same personal data as production and get the same protection. They
  are never restored to developer machines. For debugging, use anonymised copies made by
  a script that replaces names, phones, addresses and documents.

## 5. Restore procedure

**Database: point-in-time or last good state**

1. Declare the incident, and stop the worker process so no jobs act on a database that is
   about to be replaced. Put the API in maintenance mode at the edge, which answers 503.
2. Restore to a new instance at the chosen time: just before the bad change, or the latest
   time for a lost instance.
3. Run `pnpm db:migrate` against it as the owner. It must report `0 applied` because the
   restore contains the schema. If it applies anything, the restore point predates a
   release: roll the application back to the matching version instead.
4. Create or confirm the runtime login as a member of `onetappe_app`.
5. Point `DATABASE_URL` for the API and worker at the new instance, start the API, check
   `/health/ready`, then start the worker.
6. Reconcile with the outside world. The jobs do this automatically, but check it:
   - `reconcile-payments` asks Razorpay about every open payment. Payments captured after
     the restore point are then recovered from Razorpay itself. Webhooks Razorpay retries
     are handled idempotently.
   - `deliver-integration-events` resends anything not confirmed to Zoho. Duplicates are
     prevented by the case-code search.
   - Compare the Razorpay dashboard's captured payments for the gap window with
     `payment`. The runbook query is in the `reconcile-payments` job; any difference
     becomes an operations case.
7. Remove maintenance mode and record the timeline in the incident report.

**Documents:** restore the object version from the versioned or replicated bucket. The
database keeps each file's SHA-256, so a restored file that doesn't match is never served.

## 6. Restore testing

- **Before launch:** a full restore drill on staging:
  - timed against the RTO;
  - includes the payment reconciliation step;
  - the result recorded in `docs/` with the date.
- **Monthly:** an automated job restores the latest snapshot to a temporary instance,
  runs `pnpm db:migrate` (expects `0 applied`) and a set of checks (row counts, latest
  booking time), then deletes the instance. If it fails, it alerts.
- **Quarterly:** a restore drill run by someone other than the usual operator, following
  this document.

## 7. Application recovery

- Deployments are container images built by CI from a commit on `main`. A rollback
  deploys the previous image.
- Migrations only move forward and are designed to be compatible with the previous
  release, so a rollback never needs the database rolled back. A migration that cannot
  meet this is split over two releases. The PR template asks this question.
- The API and worker have no local state: replace, scale or restart them at any time.
  Leases expire, and another process picks the work up.
