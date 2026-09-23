-- 0022 Least privilege for the running application.
--
-- Migrations run as the schema owner. The API and the background worker log in as a
-- separate user that is a member of onetappe_app (created by infrastructure, e.g.
-- `CREATE ROLE onetappe_api LOGIN PASSWORD '…' IN ROLE onetappe_app`), which can read and
-- write rows but cannot:
--   * change the schema, or disable the triggers that enforce the booking state machine,
--     reservations, audit and append-only history (only a table's owner can);
--   * TRUNCATE anything, or touch the migration record;
--   * UPDATE or DELETE history, audit, invoices and other append-only records (also refused
--     by triggers; this is a second, independent lock), or edit the transition tables.
-- A leaked application credential or an SQL injection therefore cannot rewrite history.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'onetappe_app') THEN
    CREATE ROLE onetappe_app NOLOGIN;
  END IF;
END
$$;

-- Nobody but the owner creates objects in the schema.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO onetappe_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO onetappe_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO onetappe_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO onetappe_app;

-- Tables created by later migrations get the same grants; each migration that adds an
-- append-only table revokes UPDATE/DELETE for it as below.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO onetappe_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO onetappe_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO onetappe_app;

-- The migration record belongs to the migrator.
REVOKE INSERT, UPDATE, DELETE ON schema_migration FROM onetappe_app;

-- Append-only records: add, never change.
REVOKE UPDATE, DELETE ON
  audit_log,
  booking_price_line,
  booking_rating,
  booking_schedule_change,
  booking_status_history,
  credit_note,
  integration_inbound_event,
  invoice,
  safety_incident_event,
  support_case_event,
  worker_presence_event,
  worker_status_history
FROM onetappe_app;

-- The allowed transitions are part of the schema.
REVOKE INSERT, UPDATE, DELETE ON booking_status_transition, worker_status_transition
FROM onetappe_app;
