-- 0005 Customers, addresses, workers, verification, training, permissions, restrictions.

CREATE TABLE customer_profile (
  user_id           uuid PRIMARY KEY REFERENCES app_user (id),
  marketing_opt_in  boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Saved addresses. Bookings copy the address into a snapshot, so later edits never
-- change where a past booking was delivered.
CREATE TABLE address (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES app_user (id),
  label               text NOT NULL DEFAULT 'Home',
  contact_name        text NOT NULL,
  contact_phone_e164  text NOT NULL CHECK (contact_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  house_number        text NOT NULL,
  building            text,
  street              text,
  landmark            text,
  pincode             text NOT NULL CHECK (pincode ~ '^[1-9][0-9]{5}$'),
  -- Resolved by the serviceability check; NULL when the area is not served.
  locality_id         uuid REFERENCES locality (id),
  city_name           text NOT NULL,
  lat                 numeric(9, 6) NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng                 numeric(9, 6) NOT NULL CHECK (lng BETWEEN -180 AND 180),
  access_notes        text,
  is_default          boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  archived_at         timestamptz
);

CREATE INDEX address_user_idx ON address (user_id) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX address_one_default_uq ON address (user_id)
  WHERE is_default AND archived_at IS NULL;

-- ---------------------------------------------------------------------------
-- Workers
-- ---------------------------------------------------------------------------

CREATE TABLE worker_profile (
  user_id                  uuid PRIMARY KEY REFERENCES app_user (id),
  worker_code              text NOT NULL UNIQUE CHECK (worker_code ~ '^W[0-9A-Z]{4,12}$'),
  -- REGISTERED → DOCUMENTS_PENDING → UNDER_REVIEW → TRAINING → APPROVED
  -- APPROVED ↔ SUSPENDED; any → OFFBOARDED
  status                   text NOT NULL DEFAULT 'REGISTERED'
                           CHECK (status IN ('REGISTERED', 'DOCUMENTS_PENDING', 'UNDER_REVIEW',
                                             'TRAINING', 'APPROVED', 'SUSPENDED', 'OFFBOARDED')),
  date_of_birth            date,
  gender                   text CHECK (gender IN ('FEMALE', 'MALE', 'OTHER', 'UNDISCLOSED')),
  languages                text[] NOT NULL DEFAULT ARRAY['hi']::text[],
  home_address_id          uuid REFERENCES address (id),
  primary_zone_id          uuid REFERENCES zone (id),
  emergency_contact_name   text,
  emergency_contact_phone  text CHECK (emergency_contact_phone ~ '^\+[1-9][0-9]{7,14}$'),
  approved_by              uuid REFERENCES app_user (id),
  approved_at              timestamptz,
  status_reason            text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'APPROVED' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK (approved_by IS NULL OR approved_by <> user_id)
);

-- One row per verification attempt; history is kept. The current state of a type is
-- its most recent row.
CREATE TABLE worker_verification (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id            uuid NOT NULL REFERENCES worker_profile (user_id),
  verification_type    text NOT NULL
                       CHECK (verification_type IN ('IDENTITY', 'ADDRESS', 'POLICE', 'REFERENCE',
                                                    'FITNESS', 'SKILL_ASSESSMENT', 'CONTRACT',
                                                    'PHOTO', 'BANK_ACCOUNT')),
  status               text NOT NULL DEFAULT 'PENDING'
                       CHECK (status IN ('PENDING', 'SUBMITTED', 'IN_REVIEW', 'VERIFIED',
                                         'REJECTED', 'EXPIRED', 'WITHDRAWN')),
  method               text,
  -- Never a full ID number: last characters only, for matching.
  reference_masked     text CHECK (reference_masked IS NULL OR length(reference_masked) <= 8),
  -- Object key in the restricted document vault.
  document_object_key  text,
  submitted_at         timestamptz,
  decided_by           uuid REFERENCES app_user (id),
  decided_at           timestamptz,
  expires_at           timestamptz,
  rejection_reason     text,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (decided_by IS NULL OR decided_by <> worker_id),
  CHECK (status NOT IN ('VERIFIED', 'REJECTED') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (status <> 'REJECTED' OR rejection_reason IS NOT NULL)
);

CREATE INDEX worker_verification_worker_idx
  ON worker_verification (worker_id, verification_type, created_at DESC);

-- Which verifications a service needs before a worker may be booked for it.
CREATE TABLE service_verification_requirement (
  service_id         uuid NOT NULL REFERENCES service (id),
  verification_type  text NOT NULL
                     CHECK (verification_type IN ('IDENTITY', 'ADDRESS', 'POLICE', 'REFERENCE',
                                                  'FITNESS', 'SKILL_ASSESSMENT', 'CONTRACT',
                                                  'PHOTO', 'BANK_ACCOUNT')),
  PRIMARY KEY (service_id, verification_type)
);

CREATE TABLE training_module (
  code         text PRIMARY KEY CHECK (code ~ '^[A-Z0-9_]{2,40}$'),
  name         text NOT NULL,
  description  text,
  is_active    boolean NOT NULL DEFAULT true
);

CREATE TABLE service_training_requirement (
  service_id   uuid NOT NULL REFERENCES service (id),
  module_code  text NOT NULL REFERENCES training_module (code),
  PRIMARY KEY (service_id, module_code)
);

CREATE TABLE worker_training (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id    uuid NOT NULL REFERENCES worker_profile (user_id),
  module_code  text NOT NULL REFERENCES training_module (code),
  status       text NOT NULL DEFAULT 'ASSIGNED'
               CHECK (status IN ('ASSIGNED', 'IN_PROGRESS', 'PASSED', 'FAILED')),
  score        smallint CHECK (score BETWEEN 0 AND 100),
  assessed_by  uuid REFERENCES app_user (id),
  assessed_at  timestamptz,
  expires_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (assessed_by IS NULL OR assessed_by <> worker_id),
  CHECK (status NOT IN ('PASSED', 'FAILED') OR (assessed_by IS NOT NULL AND assessed_at IS NOT NULL))
);

CREATE INDEX worker_training_worker_idx ON worker_training (worker_id, module_code, created_at DESC);

-- What a worker may be booked for, and optionally where.
CREATE TABLE worker_service_permission (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id      uuid NOT NULL REFERENCES worker_profile (user_id),
  service_id     uuid NOT NULL REFERENCES service (id),
  -- NULL = any zone the service is sold in.
  zone_id        uuid REFERENCES zone (id),
  granted_by     uuid NOT NULL REFERENCES app_user (id),
  granted_at     timestamptz NOT NULL DEFAULT now(),
  valid_until    timestamptz,
  revoked_by     uuid REFERENCES app_user (id),
  revoked_at     timestamptz,
  revoke_reason  text,
  CHECK (granted_by <> worker_id),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CHECK (revoked_at IS NULL OR revoke_reason IS NOT NULL)
);

CREATE UNIQUE INDEX worker_service_permission_active_uq
  ON worker_service_permission (worker_id, service_id,
                                COALESCE(zone_id, '00000000-0000-0000-0000-000000000000'))
  WHERE revoked_at IS NULL;

-- Targeted restrictions (safety, quality). Lifting needs a different person.
CREATE TABLE worker_restriction (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id    uuid NOT NULL REFERENCES worker_profile (user_id),
  -- NULL service/zone = applies to all services/zones.
  service_id   uuid REFERENCES service (id),
  zone_id      uuid REFERENCES zone (id),
  reason       text NOT NULL,
  imposed_by   uuid NOT NULL REFERENCES app_user (id),
  imposed_at   timestamptz NOT NULL DEFAULT now(),
  review_at    timestamptz NOT NULL,
  lifted_by    uuid REFERENCES app_user (id),
  lifted_at    timestamptz,
  lift_reason  text,
  CHECK (imposed_by <> worker_id),
  CHECK (lifted_by IS NULL OR lifted_by <> imposed_by),
  CHECK ((lifted_at IS NULL) = (lifted_by IS NULL)),
  CHECK (lifted_at IS NULL OR lift_reason IS NOT NULL)
);

CREATE INDEX worker_restriction_active_idx ON worker_restriction (worker_id) WHERE lifted_at IS NULL;

-- Bank details: encrypted by the API; a different person must verify a change.
CREATE TABLE worker_bank_account (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id                   uuid NOT NULL REFERENCES worker_profile (user_id),
  account_holder_name         text NOT NULL,
  account_number_encrypted    bytea NOT NULL,
  account_number_last4        char(4) NOT NULL CHECK (account_number_last4 ~ '^[0-9]{4}$'),
  ifsc                        text NOT NULL CHECK (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  status                      text NOT NULL DEFAULT 'PENDING'
                              CHECK (status IN ('PENDING', 'VERIFIED', 'REJECTED', 'SUPERSEDED')),
  submitted_by                uuid NOT NULL REFERENCES app_user (id),
  verified_by                 uuid REFERENCES app_user (id),
  verified_at                 timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CHECK (verified_by IS NULL OR verified_by <> submitted_by),
  CHECK (verified_by IS NULL OR verified_by <> worker_id)
);

CREATE UNIQUE INDEX worker_bank_account_verified_uq ON worker_bank_account (worker_id)
  WHERE status = 'VERIFIED';

-- ---------------------------------------------------------------------------
-- Eligibility: the database's own answer to "may this worker do this service, in this
-- zone, during this period?". Used by the reservation trigger (migration 0006).
-- ---------------------------------------------------------------------------

CREATE FUNCTION worker_ineligibility_reason(
  p_worker_id uuid, p_service_id uuid, p_zone_id uuid, p_period tstzrange
) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_status text;
  v_missing text;
BEGIN
  SELECT w.status INTO v_status
  FROM worker_profile w JOIN app_user u ON u.id = w.user_id
  WHERE w.user_id = p_worker_id AND u.status = 'ACTIVE';

  IF v_status IS NULL THEN RETURN 'WORKER_NOT_FOUND_OR_INACTIVE'; END IF;
  IF v_status <> 'APPROVED' THEN RETURN 'WORKER_NOT_APPROVED'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM worker_service_permission p
    WHERE p.worker_id = p_worker_id AND p.service_id = p_service_id
      AND p.revoked_at IS NULL
      AND (p.zone_id IS NULL OR p.zone_id = p_zone_id)
      AND (p.valid_until IS NULL OR p.valid_until >= upper(p_period))
  ) THEN
    RETURN 'NO_SERVICE_PERMISSION';
  END IF;

  IF EXISTS (
    SELECT 1 FROM worker_restriction r
    WHERE r.worker_id = p_worker_id AND r.lifted_at IS NULL
      AND (r.service_id IS NULL OR r.service_id = p_service_id)
      AND (r.zone_id IS NULL OR r.zone_id = p_zone_id)
  ) THEN
    RETURN 'WORKER_RESTRICTED';
  END IF;

  -- Every required verification must be VERIFIED in its latest attempt and still valid
  -- at the end of the period.
  SELECT string_agg(req.verification_type, ',') INTO v_missing
  FROM service_verification_requirement req
  WHERE req.service_id = p_service_id
    AND NOT EXISTS (
      SELECT 1 FROM (
        SELECT v.status, v.expires_at
        FROM worker_verification v
        WHERE v.worker_id = p_worker_id AND v.verification_type = req.verification_type
        ORDER BY v.created_at DESC
        LIMIT 1
      ) latest
      WHERE latest.status = 'VERIFIED'
        AND (latest.expires_at IS NULL OR latest.expires_at >= upper(p_period))
    );
  IF v_missing IS NOT NULL THEN RETURN 'VERIFICATION_MISSING:' || v_missing; END IF;

  SELECT string_agg(req.module_code, ',') INTO v_missing
  FROM service_training_requirement req
  WHERE req.service_id = p_service_id
    AND NOT EXISTS (
      SELECT 1 FROM worker_training t
      WHERE t.worker_id = p_worker_id AND t.module_code = req.module_code
        AND t.status = 'PASSED'
        AND (t.expires_at IS NULL OR t.expires_at >= upper(p_period))
    );
  IF v_missing IS NOT NULL THEN RETURN 'TRAINING_MISSING:' || v_missing; END IF;

  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER customer_profile_updated_at BEFORE UPDATE ON customer_profile FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER address_updated_at BEFORE UPDATE ON address FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER worker_profile_updated_at BEFORE UPDATE ON worker_profile FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER worker_verification_updated_at BEFORE UPDATE ON worker_verification FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER worker_training_updated_at BEFORE UPDATE ON worker_training FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER worker_bank_account_updated_at BEFORE UPDATE ON worker_bank_account FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Addresses are archived, not deleted (bookings reference them).
CREATE TRIGGER address_no_delete BEFORE DELETE ON address FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER worker_profile_no_delete BEFORE DELETE ON worker_profile FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER worker_verification_no_delete BEFORE DELETE ON worker_verification FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER worker_training_no_delete BEFORE DELETE ON worker_training FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER worker_service_permission_no_delete BEFORE DELETE ON worker_service_permission FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER worker_restriction_no_delete BEFORE DELETE ON worker_restriction FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER worker_bank_account_no_delete BEFORE DELETE ON worker_bank_account FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TRIGGER worker_profile_context BEFORE INSERT OR UPDATE ON worker_profile FOR EACH ROW EXECUTE FUNCTION require_action_context();
CREATE TRIGGER worker_verification_context BEFORE INSERT OR UPDATE ON worker_verification FOR EACH ROW EXECUTE FUNCTION require_action_context();
CREATE TRIGGER worker_service_permission_context BEFORE INSERT OR UPDATE ON worker_service_permission FOR EACH ROW EXECUTE FUNCTION require_action_context();
CREATE TRIGGER worker_restriction_context BEFORE INSERT OR UPDATE ON worker_restriction FOR EACH ROW EXECUTE FUNCTION require_action_context();
CREATE TRIGGER worker_bank_account_context BEFORE INSERT OR UPDATE ON worker_bank_account FOR EACH ROW EXECUTE FUNCTION require_action_context();

CREATE TRIGGER customer_profile_audit AFTER INSERT OR UPDATE ON customer_profile FOR EACH ROW EXECUTE FUNCTION audit_row_change('user_id');
CREATE TRIGGER address_audit AFTER INSERT OR UPDATE ON address FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
CREATE TRIGGER worker_profile_audit AFTER INSERT OR UPDATE ON worker_profile FOR EACH ROW EXECUTE FUNCTION audit_row_change('user_id');
CREATE TRIGGER worker_verification_audit AFTER INSERT OR UPDATE ON worker_verification FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'document_object_key');
CREATE TRIGGER worker_training_audit AFTER INSERT OR UPDATE ON worker_training FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
CREATE TRIGGER worker_service_permission_audit AFTER INSERT OR UPDATE ON worker_service_permission FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
CREATE TRIGGER worker_restriction_audit AFTER INSERT OR UPDATE ON worker_restriction FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
CREATE TRIGGER worker_bank_account_audit AFTER INSERT OR UPDATE ON worker_bank_account FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'account_number_encrypted');
