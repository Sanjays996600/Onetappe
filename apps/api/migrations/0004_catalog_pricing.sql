-- 0004 Service catalog and pricing.
-- Services are data. HH60 is only the first row operations switches on; deep cleaning,
-- appliance repair, elder care, etc. are added as new rows with their own rules.

CREATE TABLE service_category (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id   uuid REFERENCES service_category (id),
  code        text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_]{2,40}$'),
  name        text NOT NULL,
  description text,
  icon_key    text,
  sort_order  int NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE TABLE service (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id            uuid NOT NULL REFERENCES service_category (id),
  code                   text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_]{2,40}$'),
  name                   text NOT NULL,
  description            text,
  -- How the service is delivered; decides which booking steps apply.
  fulfilment_type        text NOT NULL DEFAULT 'WORKER_VISIT'
                         CHECK (fulfilment_type IN ('WORKER_VISIT', 'CREW_VISIT',
                                                    'SURVEY_THEN_VISIT', 'PARTNER_COORDINATION')),
  duration_minutes       int NOT NULL CHECK (duration_minutes BETWEEN 5 AND 1440),
  -- Worker time blocked before (travel) and after (reset) the visit.
  buffer_before_minutes  int NOT NULL DEFAULT 0 CHECK (buffer_before_minutes BETWEEN 0 AND 240),
  buffer_after_minutes   int NOT NULL DEFAULT 0 CHECK (buffer_after_minutes BETWEEN 0 AND 240),
  workers_required       smallint NOT NULL DEFAULT 1 CHECK (workers_required BETWEEN 1 AND 20),
  supports_instant       boolean NOT NULL DEFAULT false,
  supports_scheduled     boolean NOT NULL DEFAULT true,
  min_lead_time_minutes  int NOT NULL DEFAULT 60 CHECK (min_lead_time_minutes >= 0),
  max_advance_days       int NOT NULL DEFAULT 14 CHECK (max_advance_days BETWEEN 0 AND 365),
  -- How long capacity is held while waiting for payment.
  payment_hold_minutes   int NOT NULL DEFAULT 10 CHECK (payment_hold_minutes BETWEEN 1 AND 120),
  -- How long a worker has to accept an offer.
  offer_timeout_seconds  int NOT NULL DEFAULT 180 CHECK (offer_timeout_seconds BETWEEN 30 AND 3600),
  requires_start_code    boolean NOT NULL DEFAULT true,
  -- Service-specific settings that do not justify a column yet (validated by the API).
  attributes             jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort_order             int NOT NULL DEFAULT 0,
  is_active              boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (supports_instant OR supports_scheduled)
);

-- Customer-selectable variants ("required option"), e.g. 60 vs 90 minutes.
CREATE TABLE service_option (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id        uuid NOT NULL REFERENCES service (id),
  code              text NOT NULL CHECK (code ~ '^[A-Z0-9_]{1,40}$'),
  name              text NOT NULL,
  description       text,
  -- Overrides service.duration_minutes when set.
  duration_minutes  int CHECK (duration_minutes BETWEEN 5 AND 1440),
  is_default        boolean NOT NULL DEFAULT false,
  sort_order        int NOT NULL DEFAULT 0,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_id, code),
  UNIQUE (service_id, id)
);

CREATE UNIQUE INDEX service_option_one_default_uq
  ON service_option (service_id) WHERE is_default AND is_active;

-- Checklist tasks the customer can pick and prioritise.
CREATE TABLE service_task (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id           uuid NOT NULL REFERENCES service (id),
  code                 text NOT NULL CHECK (code ~ '^[A-Z0-9_]{2,40}$'),
  name                 text NOT NULL,
  description          text,
  is_default_selected  boolean NOT NULL DEFAULT true,
  sort_order           int NOT NULL DEFAULT 0,
  is_active            boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_id, code)
);

-- Where a service is sold. A service is bookable in a zone only when both are active
-- and this row is active.
CREATE TABLE service_zone (
  service_id      uuid NOT NULL REFERENCES service (id),
  zone_id         uuid NOT NULL REFERENCES zone (id),
  is_active       boolean NOT NULL DEFAULT false,
  notes           text,
  updated_by      uuid REFERENCES app_user (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (service_id, zone_id)
);

-- ---------------------------------------------------------------------------
-- Pricing. Amounts are integer paise, tax-exclusive; rates are basis points.
-- Rule selection (priority → specificity → newest) lives in @onetappe/domain.
-- ---------------------------------------------------------------------------

CREATE TABLE tax_rate (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL CHECK (code ~ '^[A-Z0-9_]{2,20}$'),
  name            text NOT NULL,
  rate_bp         int NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000),
  effective_from  timestamptz NOT NULL,
  effective_to    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  EXCLUDE USING gist (code WITH =, tstzrange(effective_from, effective_to, '[)') WITH &&)
);

-- Shared shape for rules scoped by service/option/city/zone/weekday/time of day.
-- weekdays: ISO 1 (Mon) … 7 (Sun); start_minute/end_minute: local minutes since midnight.
CREATE TABLE price_rule (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id         uuid NOT NULL REFERENCES service (id),
  service_option_id  uuid,
  city_id            uuid REFERENCES city (id),
  zone_id            uuid REFERENCES zone (id),
  weekdays           smallint[] CHECK (weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[]
                                       AND cardinality(weekdays) > 0),
  start_minute       smallint CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute         smallint CHECK (end_minute BETWEEN 0 AND 1439),
  base_amount_paise  bigint NOT NULL CHECK (base_amount_paise >= 0),
  tax_rate_code      text NOT NULL,
  priority           int NOT NULL DEFAULT 0,
  valid_from         timestamptz NOT NULL,
  valid_to           timestamptz,
  is_active          boolean NOT NULL DEFAULT true,
  notes              text,
  created_by         uuid REFERENCES app_user (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (service_id, service_option_id) REFERENCES service_option (service_id, id),
  CHECK ((start_minute IS NULL) = (end_minute IS NULL)),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE INDEX price_rule_service_idx ON price_rule (service_id) WHERE is_active;

-- Additional charges: instant booking, evening, festival, etc.
CREATE TABLE charge_rule (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL CHECK (code ~ '^[A-Z0-9_]{2,40}$'),
  label         text NOT NULL,
  service_id    uuid REFERENCES service (id),
  city_id       uuid REFERENCES city (id),
  zone_id       uuid REFERENCES zone (id),
  booking_type  text CHECK (booking_type IN ('INSTANT', 'SCHEDULED')),
  weekdays      smallint[] CHECK (weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[]
                                  AND cardinality(weekdays) > 0),
  start_minute  smallint CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute    smallint CHECK (end_minute BETWEEN 0 AND 1439),
  kind          text NOT NULL CHECK (kind IN ('FIXED', 'PERCENT_OF_BASE')),
  -- Paise for FIXED, basis points for PERCENT_OF_BASE.
  value         int NOT NULL CHECK (value >= 0),
  taxable       boolean NOT NULL DEFAULT true,
  valid_from    timestamptz NOT NULL,
  valid_to      timestamptz,
  is_active     boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES app_user (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((start_minute IS NULL) = (end_minute IS NULL)),
  CHECK (kind <> 'PERCENT_OF_BASE' OR value <= 10000),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE TABLE promotion (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                      citext NOT NULL UNIQUE CHECK (code ~ '^[A-Za-z0-9_-]{3,30}$'),
  description               text NOT NULL,
  discount_type             text NOT NULL CHECK (discount_type IN ('FLAT', 'PERCENT')),
  value                     int NOT NULL CHECK (value > 0),
  max_discount_paise        bigint CHECK (max_discount_paise > 0),
  min_order_paise           bigint CHECK (min_order_paise >= 0),
  valid_from                timestamptz NOT NULL,
  valid_to                  timestamptz NOT NULL,
  max_redemptions           int CHECK (max_redemptions > 0),
  max_redemptions_per_user  int NOT NULL DEFAULT 1 CHECK (max_redemptions_per_user > 0),
  first_booking_only        boolean NOT NULL DEFAULT false,
  is_active                 boolean NOT NULL DEFAULT true,
  created_by                uuid REFERENCES app_user (id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (discount_type <> 'PERCENT' OR value <= 10000),
  CHECK (valid_to > valid_from)
);

-- Empty = all services / all cities.
CREATE TABLE promotion_service (
  promotion_id  uuid NOT NULL REFERENCES promotion (id),
  service_id    uuid NOT NULL REFERENCES service (id),
  PRIMARY KEY (promotion_id, service_id)
);

CREATE TABLE promotion_city (
  promotion_id  uuid NOT NULL REFERENCES promotion (id),
  city_id       uuid NOT NULL REFERENCES city (id),
  PRIMARY KEY (promotion_id, city_id)
);

-- Worker pay is configured separately from customer price.
CREATE TABLE payout_rule (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id              uuid NOT NULL REFERENCES service (id),
  service_option_id       uuid,
  city_id                 uuid REFERENCES city (id),
  zone_id                 uuid REFERENCES zone (id),
  weekdays                smallint[] CHECK (weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[]
                                            AND cardinality(weekdays) > 0),
  start_minute            smallint CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute              smallint CHECK (end_minute BETWEEN 0 AND 1439),
  base_payout_paise       bigint NOT NULL CHECK (base_payout_paise >= 0),
  travel_allowance_paise  bigint NOT NULL DEFAULT 0 CHECK (travel_allowance_paise >= 0),
  priority                int NOT NULL DEFAULT 0,
  valid_from              timestamptz NOT NULL,
  valid_to                timestamptz,
  is_active               boolean NOT NULL DEFAULT true,
  created_by              uuid REFERENCES app_user (id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (service_id, service_option_id) REFERENCES service_option (service_id, id),
  CHECK ((start_minute IS NULL) = (end_minute IS NULL)),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER service_category_updated_at BEFORE UPDATE ON service_category FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER service_updated_at BEFORE UPDATE ON service FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER service_option_updated_at BEFORE UPDATE ON service_option FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER service_task_updated_at BEFORE UPDATE ON service_task FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER service_zone_updated_at BEFORE UPDATE ON service_zone FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER price_rule_updated_at BEFORE UPDATE ON price_rule FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER charge_rule_updated_at BEFORE UPDATE ON charge_rule FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER promotion_updated_at BEFORE UPDATE ON promotion FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER payout_rule_updated_at BEFORE UPDATE ON payout_rule FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Price history must stay reconstructable: rules are deactivated/expired, never deleted.
CREATE TRIGGER price_rule_no_delete BEFORE DELETE ON price_rule FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER charge_rule_no_delete BEFORE DELETE ON charge_rule FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER payout_rule_no_delete BEFORE DELETE ON payout_rule FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER promotion_no_delete BEFORE DELETE ON promotion FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER tax_rate_no_delete BEFORE DELETE ON tax_rate FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TRIGGER service_category_audit AFTER INSERT OR UPDATE OR DELETE ON service_category FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
CREATE TRIGGER service_audit AFTER INSERT OR UPDATE OR DELETE ON service FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
CREATE TRIGGER service_option_audit AFTER INSERT OR UPDATE OR DELETE ON service_option FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
CREATE TRIGGER service_task_audit AFTER INSERT OR UPDATE OR DELETE ON service_task FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
CREATE TRIGGER service_zone_audit AFTER INSERT OR UPDATE OR DELETE ON service_zone FOR EACH ROW EXECUTE FUNCTION audit_row_change('service_id');
CREATE TRIGGER tax_rate_audit AFTER INSERT OR UPDATE ON tax_rate FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
CREATE TRIGGER price_rule_audit AFTER INSERT OR UPDATE ON price_rule FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
CREATE TRIGGER charge_rule_audit AFTER INSERT OR UPDATE ON charge_rule FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
CREATE TRIGGER promotion_audit AFTER INSERT OR UPDATE ON promotion FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
CREATE TRIGGER payout_rule_audit AFTER INSERT OR UPDATE ON payout_rule FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
