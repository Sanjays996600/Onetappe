-- 0006 Worker availability: planned shifts and online/offline presence.
-- A worker can only be reserved inside a planned shift (enforced in 0007).

CREATE TABLE worker_shift (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id     uuid NOT NULL REFERENCES worker_profile (user_id),
  zone_id       uuid NOT NULL REFERENCES zone (id),
  period        tstzrange NOT NULL,
  status        text NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED', 'CANCELLED')),
  created_by    uuid REFERENCES app_user (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  cancelled_by  uuid REFERENCES app_user (id),
  cancelled_at  timestamptz,
  cancel_reason text,
  CHECK (NOT isempty(period) AND NOT lower_inf(period) AND NOT upper_inf(period)
         AND lower_inc(period) AND NOT upper_inc(period)),
  CHECK (upper(period) - lower(period) <= interval '16 hours'),
  CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL)),
  -- A worker cannot have two overlapping planned shifts.
  CONSTRAINT worker_shift_no_overlap
    EXCLUDE USING gist (worker_id WITH =, period WITH &&) WHERE (status = 'PLANNED')
);

CREATE INDEX worker_shift_zone_period_idx ON worker_shift USING gist (zone_id, period)
  WHERE status = 'PLANNED';

-- Current online/offline state, updated from the worker app.
CREATE TABLE worker_presence (
  worker_id         uuid PRIMARY KEY REFERENCES worker_profile (user_id),
  is_online         boolean NOT NULL DEFAULT false,
  changed_at        timestamptz NOT NULL DEFAULT now(),
  last_lat          numeric(9, 6) CHECK (last_lat BETWEEN -90 AND 90),
  last_lng          numeric(9, 6) CHECK (last_lng BETWEEN -180 AND 180),
  last_location_at  timestamptz
);

-- Every online/offline change, kept for duty-hour and payout questions.
CREATE TABLE worker_presence_event (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  worker_id    uuid NOT NULL REFERENCES worker_profile (user_id),
  is_online    boolean NOT NULL,
  source       action_source NOT NULL,
  occurred_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX worker_presence_event_worker_idx ON worker_presence_event (worker_id, occurred_at);

CREATE FUNCTION worker_presence_log() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.is_online IS DISTINCT FROM OLD.is_online THEN
    INSERT INTO worker_presence_event (worker_id, is_online, source)
    VALUES (NEW.worker_id, NEW.is_online, COALESCE(app_source(), 'SYSTEM'));
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER worker_presence_log AFTER INSERT OR UPDATE ON worker_presence
  FOR EACH ROW EXECUTE FUNCTION worker_presence_log();
CREATE TRIGGER worker_presence_event_append_only BEFORE UPDATE OR DELETE ON worker_presence_event
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

CREATE TRIGGER worker_shift_no_delete BEFORE DELETE ON worker_shift
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER worker_shift_audit AFTER INSERT OR UPDATE ON worker_shift
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
