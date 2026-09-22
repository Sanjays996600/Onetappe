-- 0001 Foundation: extensions, action context, audit log and protective triggers.
--
-- Error codes raised by One Tappe triggers (SQLSTATE class "OT"):
--   OT001 append-only table modified          OT005 reservation not allowed
--   OT002 booking status transition invalid   OT006 delete forbidden
--   OT003 immutable column changed            OT007 refund exceeds captured amount
--   OT004 action context (source) missing     OT008 business rule violated

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------------
-- Action context
-- The API sets these per transaction with set_config(name, value, true) so triggers can
-- record who acted, through which channel and why, without trusting callers to write
-- history rows themselves.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app_setting(name text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting(name, true), '')
$$;

CREATE FUNCTION app_actor_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT app_setting('app.actor_user_id')::uuid $$;

CREATE FUNCTION app_actor_role() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT app_setting('app.actor_role') $$;

CREATE FUNCTION app_source() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT app_setting('app.source') $$;

CREATE FUNCTION app_request_id() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT app_setting('app.request_id') $$;

CREATE FUNCTION app_reason() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT app_setting('app.reason') $$;

CREATE FUNCTION app_event() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT app_setting('app.event') $$;

CREATE DOMAIN action_source AS text
  CHECK (VALUE IN ('CUSTOMER_APP', 'WORKER_APP', 'ADMIN', 'SYSTEM', 'PAYMENT_GATEWAY'));

-- Writes to critical tables must say where they came from.
CREATE FUNCTION require_action_context() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app_source() IS NULL THEN
    RAISE EXCEPTION '% on % requires app.source to be set', TG_OP, TG_TABLE_NAME
      USING ERRCODE = 'OT004';
  END IF;
  PERFORM app_source()::action_source;
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- ---------------------------------------------------------------------------
-- Generic protections
-- ---------------------------------------------------------------------------

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE FUNCTION forbid_update_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'OT001';
END;
$$;

CREATE FUNCTION forbid_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Rows in % cannot be deleted; change their status instead', TG_TABLE_NAME
    USING ERRCODE = 'OT006';
END;
$$;

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------

CREATE TABLE audit_log (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_user_id   uuid,
  actor_role      text,
  source          text,
  request_id      text,
  action          text NOT NULL
                  CHECK (action IN ('INSERT', 'UPDATE', 'DELETE', 'READ', 'EXPORT',
                                    'LOGIN', 'LOGOUT', 'ACCESS_DENIED')),
  entity_type     text NOT NULL,
  entity_id       text,
  changed_fields  text[],
  before          jsonb,
  after           jsonb,
  reason          text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id, occurred_at);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_user_id, occurred_at);
CREATE INDEX audit_log_occurred_idx ON audit_log (occurred_at);

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

-- Row-change auditing.
--   TG_ARGV[0]      name of the identifying column (usually 'id')
--   TG_ARGV[1..n]   columns whose values must never be copied into the audit log
CREATE FUNCTION audit_row_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  id_column  text := COALESCE(TG_ARGV[0], 'id');
  old_row    jsonb;
  new_row    jsonb;
  changed    text[];
  col        text;
  i          int;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN old_row := to_jsonb(OLD); END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN new_row := to_jsonb(NEW); END IF;

  FOR i IN 1 .. COALESCE(array_length(TG_ARGV, 1), 0) - 1 LOOP
    col := TG_ARGV[i];
    IF old_row ? col THEN old_row := jsonb_set(old_row, ARRAY[col], '"[REDACTED]"'); END IF;
    IF new_row ? col THEN new_row := jsonb_set(new_row, ARRAY[col], '"[REDACTED]"'); END IF;
  END LOOP;

  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(key ORDER BY key) INTO changed
    FROM jsonb_each(to_jsonb(NEW)) AS n(key, value)
    WHERE n.value IS DISTINCT FROM (to_jsonb(OLD) -> n.key)
      AND n.key NOT IN ('updated_at', 'version');
    IF changed IS NULL THEN RETURN NEW; END IF;
  END IF;

  INSERT INTO audit_log (actor_user_id, actor_role, source, request_id, action,
                         entity_type, entity_id, changed_fields, before, after, reason)
  VALUES (app_actor_user_id(), app_actor_role(), app_source(), app_request_id(), TG_OP,
          TG_TABLE_NAME, COALESCE(new_row, old_row) ->> id_column, changed,
          old_row, new_row, app_reason());

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- ---------------------------------------------------------------------------
-- Languages. English and Hindi at launch; more rows = more languages, no code change.
-- ---------------------------------------------------------------------------

CREATE TABLE locale (
  code         text PRIMARY KEY CHECK (code ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  name         text NOT NULL,
  native_name  text NOT NULL,
  is_active    boolean NOT NULL DEFAULT true,
  sort_order   int NOT NULL DEFAULT 0
);

INSERT INTO locale (code, name, native_name, sort_order) VALUES
  ('en', 'English', 'English', 1),
  ('hi', 'Hindi', 'हिन्दी', 2);

-- Translations for any configurable record (service names, category names, …).
-- The base row holds the default-language (English) text; this table holds the rest.
CREATE TABLE translation (
  entity_type  text NOT NULL,
  entity_id    uuid NOT NULL,
  field        text NOT NULL,
  locale       text NOT NULL REFERENCES locale (code),
  value        text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_id, field, locale)
);

CREATE TRIGGER translation_updated_at
  BEFORE UPDATE ON translation FOR EACH ROW EXECUTE FUNCTION set_updated_at();
