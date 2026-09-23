-- 0017 External business-system integrations (Zoho CRM, Zoho Desk).
--
-- One Tappe stays the source of truth for bookings, availability, payments and history.
-- Integrations are fed from a transactional outbox: the business change and the
-- "tell Zoho" event commit together, a background worker delivers the event later, and
-- failures are retried, then parked as DEAD for a person to act on. A Zoho outage can
-- therefore never block or undo a booking, payment or support case.

ALTER DOMAIN action_source DROP CONSTRAINT action_source_check;
ALTER DOMAIN action_source ADD CONSTRAINT action_source_check
  CHECK (VALUE IN ('CUSTOMER_APP', 'WORKER_APP', 'ADMIN', 'SYSTEM', 'PAYMENT_GATEWAY',
                   'INTEGRATION'));

-- ---------------------------------------------------------------------------
-- Outbox. An event names what changed (aggregate) — the worker reads the current state at
-- delivery time, so a delayed event never sends stale data and replays are harmless.
-- ---------------------------------------------------------------------------
CREATE TABLE integration_event (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target           text NOT NULL CHECK (target IN ('ZOHO_CRM', 'ZOHO_DESK')),
  event_type       text NOT NULL CHECK (event_type ~ '^[A-Z][A-Z_]{2,60}$'),
  aggregate_type   text NOT NULL CHECK (aggregate_type IN ('customer', 'worker', 'booking',
                                                         'support_case', 'safety_incident')),
  aggregate_id     uuid NOT NULL,
  -- Small, non-sensitive hints only (e.g. the inbound webhook id); never personal data.
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The same logical event is never queued twice.
  dedupe_key       text NOT NULL UNIQUE CHECK (length(dedupe_key) <= 200),
  -- "Sync the current state of X" events: while one is still pending, further changes to
  -- X need no new event (it will read the latest state anyway).
  coalescible      boolean NOT NULL DEFAULT false,
  status           text NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING', 'PROCESSING', 'SUCCEEDED', 'DEAD', 'DISCARDED')),
  attempts         int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  locked_until     timestamptz,
  locked_by        text,
  last_error       text CHECK (length(last_error) <= 1000),
  last_http_status int,
  request_id       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz,
  -- Who retried or discarded a DEAD event, and why (audited via audit_log as well).
  resolved_by      uuid REFERENCES app_user (id),
  resolution_note  text
);

CREATE INDEX integration_event_due_idx ON integration_event (target, next_attempt_at)
  WHERE status IN ('PENDING', 'PROCESSING');
CREATE UNIQUE INDEX integration_event_coalesce_uq
  ON integration_event (target, event_type, aggregate_id)
  WHERE status = 'PENDING' AND coalescible;
CREATE INDEX integration_event_aggregate_idx
  ON integration_event (target, aggregate_type, aggregate_id, id);
CREATE INDEX integration_event_dead_idx ON integration_event (target, created_at)
  WHERE status = 'DEAD';

CREATE TRIGGER integration_event_no_delete BEFORE DELETE ON integration_event
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER integration_event_no_truncate BEFORE TRUNCATE ON integration_event
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();

-- ---------------------------------------------------------------------------
-- Links between One Tappe records and their counterparts in an external system.
-- ---------------------------------------------------------------------------
CREATE TABLE external_link (
  target        text NOT NULL CHECK (target IN ('ZOHO_CRM', 'ZOHO_DESK')),
  entity_type   text NOT NULL CHECK (entity_type IN ('customer', 'worker', 'booking',
                                                     'support_case', 'safety_incident',
                                                     'contact')),
  internal_id   uuid NOT NULL,
  external_id   text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 100),
  external_ref  text,   -- human reference, e.g. Desk ticket number
  external_url  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  synced_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (target, entity_type, internal_id),
  UNIQUE (target, entity_type, external_id)
);

CREATE TRIGGER external_link_no_delete BEFORE DELETE ON external_link
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------------
-- OAuth access token shared by all API/worker instances. Refreshed under a row lock so
-- instances never race (Zoho allows only a few token requests per 10 minutes). The
-- long-lived refresh token lives in the secret manager, never in the database.
-- ---------------------------------------------------------------------------
CREATE TABLE integration_credential (
  provider                text PRIMARY KEY CHECK (provider IN ('ZOHO')),
  access_token_encrypted  bytea,
  expires_at              timestamptz,
  api_domain              text,
  refreshed_at            timestamptz,
  last_error              text CHECK (length(last_error) <= 500),
  last_error_at           timestamptz
);

INSERT INTO integration_credential (provider) VALUES ('ZOHO');

-- ---------------------------------------------------------------------------
-- Circuit breaker per target: paused on rate limits, credential failures or repeated
-- outages, so a struggling Zoho is not hammered and events simply wait.
-- ---------------------------------------------------------------------------
CREATE TABLE integration_target_state (
  target                text PRIMARY KEY CHECK (target IN ('ZOHO_CRM', 'ZOHO_DESK')),
  paused_until          timestamptz,
  pause_reason          text CHECK (length(pause_reason) <= 300),
  consecutive_failures  int NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_success_at       timestamptz,
  last_failure_at       timestamptz
);

INSERT INTO integration_target_state (target) VALUES ('ZOHO_CRM'), ('ZOHO_DESK');

-- ---------------------------------------------------------------------------
-- Inbound notifications (e.g. Zoho Desk webhooks). Stored as received for traceability;
-- their content is never trusted — the worker fetches the record from Zoho itself.
-- ---------------------------------------------------------------------------
CREATE TABLE integration_inbound_event (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source        text NOT NULL CHECK (source IN ('ZOHO_DESK')),
  received_at   timestamptz NOT NULL DEFAULT now(),
  payload       jsonb NOT NULL,
  external_ids  text[] NOT NULL DEFAULT '{}',
  request_id    text
);

CREATE TRIGGER integration_inbound_event_append_only BEFORE UPDATE OR DELETE
  ON integration_inbound_event FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

-- ---------------------------------------------------------------------------
-- Permissions.
-- ---------------------------------------------------------------------------
INSERT INTO permission (code, description, is_sensitive) VALUES
  ('integration.read',   'View integration health, queues and failed events', false),
  ('integration.manage', 'Retry or discard failed integration events', true);

INSERT INTO role_permission (role_code, permission_code) VALUES
  ('SUPER_ADMIN', 'integration.read'), ('SUPER_ADMIN', 'integration.manage'),
  ('OPERATIONS_HEAD', 'integration.read'), ('OPERATIONS_HEAD', 'integration.manage'),
  ('CUSTOMER_SUPPORT', 'integration.read'),
  ('AUDITOR', 'integration.read');

CREATE TRIGGER integration_inbound_event_no_truncate BEFORE TRUNCATE ON integration_inbound_event
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();
CREATE TRIGGER external_link_no_truncate BEFORE TRUNCATE ON external_link
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();
CREATE TRIGGER external_link_audit AFTER INSERT ON external_link
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('internal_id');
