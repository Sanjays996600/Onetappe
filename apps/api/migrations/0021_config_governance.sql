-- 0021 Configuration governance and operating hours.
--
-- 1. Money rules are facts once created: price, charge, payout, tax and cancellation rules
--    can be ended (valid_to / is_active) but their amounts and matching conditions never
--    change. A new price is a new rule, so any past quote can be explained exactly.
-- 2. Operating hours per zone (optionally per service). When a zone has hours, every
--    booking's promised time must fall inside one of its windows; the database enforces it
--    for every channel, and availability only offers times that fit.

CREATE FUNCTION forbid_rule_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mutable text[] := TG_ARGV;  -- columns that may change
  col text;
BEGIN
  FOR col IN SELECT key FROM jsonb_each(to_jsonb(NEW)) LOOP
    IF col = ANY (mutable) OR col = 'updated_at' THEN CONTINUE; END IF;
    IF (to_jsonb(NEW) -> col) IS DISTINCT FROM (to_jsonb(OLD) -> col) THEN
      RAISE EXCEPTION '%.% cannot be changed once created; end this rule and create a new one',
        TG_TABLE_NAME, col USING ERRCODE = 'OT003';
    END IF;
  END LOOP;
  -- Ending is forward-only: a rule cannot be ended in the past or re-opened.
  -- (Read through jsonb: not every table guarded here has an is_active column.)
  IF (to_jsonb(OLD) ->> 'is_active') = 'false' AND (to_jsonb(NEW) ->> 'is_active') = 'true' THEN
    RAISE EXCEPTION '% cannot be re-activated; create a new rule', TG_TABLE_NAME USING ERRCODE = 'OT003';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION forbid_retroactive_end() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_end timestamptz := (to_jsonb(OLD) ->> TG_ARGV[0])::timestamptz;
  new_end timestamptz := (to_jsonb(NEW) ->> TG_ARGV[0])::timestamptz;
BEGIN
  IF new_end IS DISTINCT FROM old_end THEN
    IF new_end IS NULL OR new_end < now() - interval '1 minute' THEN
      RAISE EXCEPTION '%: an end date can only be set to now or later', TG_TABLE_NAME
        USING ERRCODE = 'OT003';
    END IF;
    IF old_end IS NOT NULL AND old_end < now() THEN
      RAISE EXCEPTION '%: this rule has already ended', TG_TABLE_NAME USING ERRCODE = 'OT003';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER price_rule_immutable BEFORE UPDATE ON price_rule
  FOR EACH ROW EXECUTE FUNCTION forbid_rule_rewrite('valid_to', 'is_active', 'notes');
CREATE TRIGGER price_rule_end BEFORE UPDATE ON price_rule
  FOR EACH ROW EXECUTE FUNCTION forbid_retroactive_end('valid_to');
CREATE TRIGGER charge_rule_immutable BEFORE UPDATE ON charge_rule
  FOR EACH ROW EXECUTE FUNCTION forbid_rule_rewrite('valid_to', 'is_active', 'label');
CREATE TRIGGER charge_rule_end BEFORE UPDATE ON charge_rule
  FOR EACH ROW EXECUTE FUNCTION forbid_retroactive_end('valid_to');
CREATE TRIGGER payout_rule_immutable BEFORE UPDATE ON payout_rule
  FOR EACH ROW EXECUTE FUNCTION forbid_rule_rewrite('valid_to', 'is_active');
CREATE TRIGGER payout_rule_end BEFORE UPDATE ON payout_rule
  FOR EACH ROW EXECUTE FUNCTION forbid_retroactive_end('valid_to');
CREATE TRIGGER tax_rate_immutable BEFORE UPDATE ON tax_rate
  FOR EACH ROW EXECUTE FUNCTION forbid_rule_rewrite('effective_to', 'name');
CREATE TRIGGER tax_rate_end BEFORE UPDATE ON tax_rate
  FOR EACH ROW EXECUTE FUNCTION forbid_retroactive_end('effective_to');
CREATE TRIGGER cancellation_rule_immutable BEFORE UPDATE ON cancellation_rule
  FOR EACH ROW EXECUTE FUNCTION forbid_rule_rewrite('valid_to', 'is_active', 'description');
CREATE TRIGGER cancellation_rule_end BEFORE UPDATE ON cancellation_rule
  FOR EACH ROW EXECUTE FUNCTION forbid_retroactive_end('valid_to');
-- A promotion's code and discount are what customers were told; they cannot change.
CREATE TRIGGER promotion_immutable BEFORE UPDATE ON promotion
  FOR EACH ROW EXECUTE FUNCTION forbid_rule_rewrite(
    'valid_to', 'is_active', 'description', 'max_redemptions', 'max_redemptions_per_user');

CREATE TRIGGER cancellation_rule_updated_audit AFTER UPDATE ON cancellation_rule
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');

-- ---------------------------------------------------------------------------
-- Operating hours.
-- ---------------------------------------------------------------------------
CREATE TABLE operating_hours (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id       uuid NOT NULL REFERENCES zone (id),
  -- NULL = every service in the zone; a service's own rows replace the zone's.
  service_id    uuid REFERENCES service (id),
  weekday       smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),   -- ISO: 1 = Monday
  open_minute   smallint NOT NULL CHECK (open_minute BETWEEN 0 AND 1439),
  close_minute  smallint NOT NULL CHECK (close_minute BETWEEN 1 AND 1440),
  valid_from    timestamptz NOT NULL DEFAULT now(),
  valid_to      timestamptz,
  created_by    uuid REFERENCES app_user (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (close_minute > open_minute),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE INDEX operating_hours_zone_idx ON operating_hours (zone_id, weekday);

CREATE TRIGGER operating_hours_updated_at BEFORE UPDATE ON operating_hours
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER operating_hours_immutable BEFORE UPDATE ON operating_hours
  FOR EACH ROW EXECUTE FUNCTION forbid_rule_rewrite('valid_to');
CREATE TRIGGER operating_hours_end BEFORE UPDATE ON operating_hours
  FOR EACH ROW EXECUTE FUNCTION forbid_retroactive_end('valid_to');
CREATE TRIGGER operating_hours_no_delete BEFORE DELETE ON operating_hours
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER operating_hours_audit AFTER INSERT OR UPDATE ON operating_hours
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');

-- True when [p_start, p_end) fits inside an operating window for the zone and service
-- (local time of the zone's city), or when no hours apply (hours are not configured).
CREATE FUNCTION within_operating_hours(p_zone uuid, p_service uuid, p_start timestamptz,
                                       p_end timestamptz)
RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE
  tz text;
  local_start timestamp;
  start_minute int;
  end_minute int;
  scope_service uuid;
BEGIN
  SELECT c.time_zone INTO tz FROM zone z JOIN city c ON c.id = z.city_id WHERE z.id = p_zone;
  IF tz IS NULL THEN RETURN false; END IF;

  -- A service's own hours replace the zone's general hours.
  SELECT CASE WHEN EXISTS (
           SELECT 1 FROM operating_hours h
           WHERE h.zone_id = p_zone AND h.service_id = p_service
             AND h.valid_from <= p_start AND (h.valid_to IS NULL OR h.valid_to > p_start))
         THEN p_service END
    INTO scope_service;
  IF scope_service IS NULL AND NOT EXISTS (
       SELECT 1 FROM operating_hours h
       WHERE h.zone_id = p_zone AND h.service_id IS NULL
         AND h.valid_from <= p_start AND (h.valid_to IS NULL OR h.valid_to > p_start)) THEN
    RETURN true;
  END IF;

  local_start := p_start AT TIME ZONE tz;
  start_minute := extract(hour FROM local_start)::int * 60 + extract(minute FROM local_start)::int;
  end_minute := start_minute + ceil(extract(epoch FROM (p_end - p_start)) / 60)::int;

  RETURN EXISTS (
    SELECT 1 FROM operating_hours h
    WHERE h.zone_id = p_zone
      AND h.service_id IS NOT DISTINCT FROM scope_service
      AND h.valid_from <= p_start AND (h.valid_to IS NULL OR h.valid_to > p_start)
      AND h.weekday = extract(isodow FROM local_start)
      AND start_minute >= h.open_minute
      AND end_minute <= h.close_minute
  );
END;
$$;

CREATE FUNCTION booking_operating_hours_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.scheduled_start IS DISTINCT FROM OLD.scheduled_start
     OR NEW.scheduled_end IS DISTINCT FROM OLD.scheduled_end THEN
    IF NOT within_operating_hours(NEW.zone_id, NEW.service_id, NEW.scheduled_start, NEW.scheduled_end) THEN
      RAISE EXCEPTION 'The requested time is outside operating hours'
        USING ERRCODE = 'OT009';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER booking_operating_hours BEFORE INSERT OR UPDATE OF scheduled_start, scheduled_end
  ON booking FOR EACH ROW EXECUTE FUNCTION booking_operating_hours_check();

-- Which services and cities a promotion covers is part of the offer: audited too.
CREATE TRIGGER promotion_service_audit AFTER INSERT OR UPDATE OR DELETE ON promotion_service
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('promotion_id');
CREATE TRIGGER promotion_city_audit AFTER INSERT OR UPDATE OR DELETE ON promotion_city
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('promotion_id');
