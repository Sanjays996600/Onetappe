-- 0011 Worker lifecycle, staff roles and granular permissions, staff MFA, session
-- rotation, refund policy decisions, cancellation rules, business settings, job runs.

-- ===========================================================================
-- 1. Worker operational lifecycle (separate from being able to log in)
-- ===========================================================================

ALTER TABLE worker_profile DROP CONSTRAINT worker_profile_status_check;
ALTER TABLE worker_profile DROP CONSTRAINT worker_profile_check;

UPDATE worker_profile SET status = CASE status
  WHEN 'UNDER_REVIEW' THEN 'VERIFICATION_PENDING'
  WHEN 'TRAINING' THEN 'TRAINING_PENDING'
  WHEN 'APPROVED' THEN 'ACTIVE'
  WHEN 'OFFBOARDED' THEN 'INACTIVE'
  ELSE status END;

ALTER TABLE worker_profile
  ADD CONSTRAINT worker_profile_status_check CHECK (status IN (
    'REGISTERED', 'PROFILE_PENDING', 'DOCUMENTS_PENDING', 'VERIFICATION_PENDING',
    'TRAINING_PENDING', 'APPROVED', 'ACTIVE', 'SUSPENDED', 'RESTRICTED', 'REJECTED', 'INACTIVE')),
  ADD CONSTRAINT worker_profile_approval_check CHECK (
    status NOT IN ('APPROVED', 'ACTIVE', 'RESTRICTED')
    OR (approved_by IS NOT NULL AND approved_at IS NOT NULL));

CREATE TABLE worker_status_transition (
  from_status      text NOT NULL,
  to_status        text NOT NULL,
  sources          text[] NOT NULL CHECK (cardinality(sources) > 0),
  requires_reason  boolean NOT NULL,
  PRIMARY KEY (from_status, to_status)
);

INSERT INTO worker_status_transition (from_status, to_status, sources, requires_reason) VALUES
  -- Onboarding progresses automatically as the worker completes each step.
  ('REGISTERED',           'PROFILE_PENDING',      '{WORKER_APP,SYSTEM,ADMIN}', false),
  ('PROFILE_PENDING',      'DOCUMENTS_PENDING',    '{WORKER_APP,SYSTEM,ADMIN}', false),
  ('DOCUMENTS_PENDING',    'VERIFICATION_PENDING', '{WORKER_APP,SYSTEM,ADMIN}', false),
  ('VERIFICATION_PENDING', 'DOCUMENTS_PENDING',    '{SYSTEM,ADMIN}',            false),
  ('VERIFICATION_PENDING', 'TRAINING_PENDING',     '{SYSTEM,ADMIN}',            false),
  ('TRAINING_PENDING',     'VERIFICATION_PENDING', '{SYSTEM,ADMIN}',            false),
  -- Decisions by worker operations.
  ('TRAINING_PENDING',     'APPROVED',             '{ADMIN}',                   false),
  ('APPROVED',             'ACTIVE',               '{ADMIN}',                   false),
  ('REGISTERED',           'REJECTED',             '{ADMIN}',                   true),
  ('PROFILE_PENDING',      'REJECTED',             '{ADMIN}',                   true),
  ('DOCUMENTS_PENDING',    'REJECTED',             '{ADMIN}',                   true),
  ('VERIFICATION_PENDING', 'REJECTED',             '{ADMIN}',                   true),
  ('TRAINING_PENDING',     'REJECTED',             '{ADMIN}',                   true),
  ('REJECTED',             'PROFILE_PENDING',      '{ADMIN}',                   true),
  -- Operational control.
  ('ACTIVE',               'RESTRICTED',           '{ADMIN,SYSTEM}',            true),
  ('RESTRICTED',           'ACTIVE',               '{ADMIN,SYSTEM}',            true),
  ('APPROVED',             'SUSPENDED',            '{ADMIN}',                   true),
  ('ACTIVE',               'SUSPENDED',            '{ADMIN}',                   true),
  ('RESTRICTED',           'SUSPENDED',            '{ADMIN}',                   true),
  ('SUSPENDED',            'ACTIVE',               '{ADMIN}',                   true),
  ('SUSPENDED',            'INACTIVE',             '{ADMIN}',                   true),
  ('APPROVED',             'INACTIVE',             '{ADMIN,WORKER_APP}',        true),
  ('ACTIVE',               'INACTIVE',             '{ADMIN,WORKER_APP}',        true),
  ('RESTRICTED',           'INACTIVE',             '{ADMIN,WORKER_APP}',        true),
  ('INACTIVE',             'ACTIVE',               '{ADMIN}',                   true);

CREATE TRIGGER worker_status_transition_append_only
  BEFORE UPDATE OR DELETE ON worker_status_transition
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

CREATE TABLE worker_status_history (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  worker_id      uuid NOT NULL REFERENCES worker_profile (user_id),
  from_status    text,
  to_status      text NOT NULL,
  actor_user_id  uuid REFERENCES app_user (id),
  actor_role     text,
  source         action_source NOT NULL,
  reason         text,
  request_id     text,
  occurred_at    timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX worker_status_history_worker_idx ON worker_status_history (worker_id, id);

CREATE TRIGGER worker_status_history_append_only
  BEFORE UPDATE OR DELETE ON worker_status_history
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER worker_status_history_no_truncate
  BEFORE TRUNCATE ON worker_status_history
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();

CREATE FUNCTION worker_profile_status_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_rule worker_status_transition%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'REGISTERED' THEN
      RAISE EXCEPTION 'A worker must be created as REGISTERED, not %', NEW.status
        USING ERRCODE = 'OT002';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    SELECT * INTO v_rule FROM worker_status_transition
    WHERE from_status = OLD.status AND to_status = NEW.status;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Worker % cannot move from % to %', OLD.worker_code, OLD.status, NEW.status
        USING ERRCODE = 'OT002';
    END IF;
    IF NOT (app_source() = ANY (v_rule.sources)) THEN
      RAISE EXCEPTION 'Source % may not move worker % from % to %',
        COALESCE(app_source(), '(none)'), OLD.worker_code, OLD.status, NEW.status
        USING ERRCODE = 'OT002';
    END IF;
    IF v_rule.requires_reason AND app_reason() IS NULL THEN
      RAISE EXCEPTION 'Moving worker % to % requires a reason', OLD.worker_code, NEW.status
        USING ERRCODE = 'OT002';
    END IF;
    NEW.status_reason := app_reason();
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION worker_profile_status_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO worker_status_history (worker_id, from_status, to_status, actor_user_id,
                                       actor_role, source, reason, request_id)
    VALUES (NEW.user_id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status,
            app_actor_user_id(), app_actor_role(), app_source(), app_reason(), app_request_id());
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER worker_profile_status_guard BEFORE INSERT OR UPDATE ON worker_profile
  FOR EACH ROW EXECUTE FUNCTION worker_profile_status_guard();
CREATE TRIGGER worker_profile_status_history AFTER INSERT OR UPDATE ON worker_profile
  FOR EACH ROW EXECUTE FUNCTION worker_profile_status_history();

-- Only ACTIVE (or RESTRICTED, within the restriction's limits) workers can be booked.
CREATE OR REPLACE FUNCTION worker_ineligibility_reason(
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
  IF v_status NOT IN ('ACTIVE', 'RESTRICTED') THEN RETURN 'WORKER_NOT_ACTIVE:' || v_status; END IF;

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

-- Instant bookings additionally need the worker to be online right now.
CREATE OR REPLACE FUNCTION worker_reservation_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_booking  booking%ROWTYPE;
  v_required smallint;
  v_reason   text;
BEGIN
  SELECT * INTO v_booking FROM booking WHERE id = NEW.booking_id;

  IF NEW.status = 'HELD' AND v_booking.status <> 'PENDING_PAYMENT' THEN
    RAISE EXCEPTION 'HELD reservations are only for bookings awaiting payment'
      USING ERRCODE = 'OT005';
  END IF;
  IF NEW.status = 'ALLOCATED' AND v_booking.status <> 'CONFIRMED' THEN
    RAISE EXCEPTION 'ALLOCATED reservations are only for confirmed bookings'
      USING ERRCODE = 'OT005';
  END IF;
  IF NEW.status NOT IN ('HELD', 'ALLOCATED') THEN
    RAISE EXCEPTION 'A reservation must start as HELD or ALLOCATED' USING ERRCODE = 'OT005';
  END IF;

  SELECT workers_required INTO v_required FROM service WHERE id = v_booking.service_id;
  IF NEW.crew_slot > v_required THEN
    RAISE EXCEPTION 'Service needs % worker(s); crew slot % is invalid', v_required, NEW.crew_slot
      USING ERRCODE = 'OT005';
  END IF;

  IF NOT (NEW.period @> tstzrange(v_booking.scheduled_start, v_booking.scheduled_end, '[)')) THEN
    RAISE EXCEPTION 'Reservation must cover the booked service time' USING ERRCODE = 'OT005';
  END IF;

  v_reason := worker_ineligibility_reason(NEW.worker_id, v_booking.service_id,
                                          v_booking.zone_id, NEW.period);
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'Worker % is not eligible: %', NEW.worker_id, v_reason
      USING ERRCODE = 'OT005', DETAIL = v_reason;
  END IF;

  IF v_booking.booking_type = 'INSTANT' AND NOT EXISTS (
    SELECT 1 FROM worker_presence p WHERE p.worker_id = NEW.worker_id AND p.is_online
  ) THEN
    RAISE EXCEPTION 'Worker % is offline', NEW.worker_id
      USING ERRCODE = 'OT005', DETAIL = 'WORKER_OFFLINE';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM worker_shift s
    WHERE s.worker_id = NEW.worker_id AND s.status = 'PLANNED'
      AND s.zone_id = v_booking.zone_id AND s.period @> NEW.period
  ) THEN
    RAISE EXCEPTION 'Worker % has no planned shift in this zone covering the reservation',
      NEW.worker_id USING ERRCODE = 'OT005', DETAIL = 'OUTSIDE_SHIFT';
  END IF;

  UPDATE worker_reservation
     SET status = 'RELEASED', released_at = now(), release_reason = 'HOLD_EXPIRED',
         hold_expires_at = NULL
   WHERE worker_id = NEW.worker_id AND status = 'HELD'
     AND hold_expires_at <= now() AND period && NEW.period;

  RETURN NEW;
END;
$$;

-- ===========================================================================
-- 2. Staff roles and granular permissions. No role grants everything.
-- ===========================================================================

-- Move any existing grants to the new role names before retiring the old roles.
INSERT INTO role (code, name, description, is_staff) VALUES
  ('OPERATIONS_HEAD',   'Operations head',   'Runs live operations; approves operational overrides', true),
  ('DISPATCHER',        'Dispatcher',        'Creates bookings on behalf of customers and assigns workers', true),
  ('CUSTOMER_SUPPORT',  'Customer support',  'Handles customer questions, complaints and refund requests', true),
  ('WORKER_OPERATIONS', 'Worker operations', 'Onboards, verifies and manages workers', true),
  ('SAFETY',            'Safety',            'Handles safety incidents and worker restrictions', true),
  ('AUDITOR',           'Auditor',           'Read-only access to records and the audit log (masked)', true);

UPDATE user_role SET role_code = CASE role_code
  WHEN 'CITY_MANAGER' THEN 'OPERATIONS_HEAD'
  WHEN 'FOUNDER' THEN 'OPERATIONS_HEAD'
  WHEN 'OPERATIONS_AGENT' THEN 'DISPATCHER'
  WHEN 'SUPPORT_AGENT' THEN 'CUSTOMER_SUPPORT'
  WHEN 'VERIFICATION_OFFICER' THEN 'WORKER_OPERATIONS'
  WHEN 'SAFETY_OFFICER' THEN 'SAFETY'
  WHEN 'MARKETING' THEN 'OPERATIONS_HEAD'
  ELSE role_code END;

DELETE FROM role_permission;
DELETE FROM role WHERE code IN ('FOUNDER', 'CITY_MANAGER', 'OPERATIONS_AGENT', 'SUPPORT_AGENT',
                                'VERIFICATION_OFFICER', 'SAFETY_OFFICER', 'MARKETING');
DELETE FROM permission;

INSERT INTO permission (code, description, is_sensitive) VALUES
  ('customer.read',               'View customers with contact details masked', false),
  ('customer.pii.reveal',         'Reveal a customer''s full phone number and address (audited)', true),
  ('customer.manage',             'Edit or suspend customer accounts', false),
  ('worker.read',                 'View workers with personal details masked', false),
  ('worker.pii.reveal',           'Reveal a worker''s phone, address, date of birth, emergency contact (audited)', true),
  ('worker.manage',               'Edit worker profiles and service permissions', false),
  ('worker.status.manage',        'Approve, activate, suspend, reject or deactivate workers', true),
  ('worker.verification.read',    'View verification status per item', false),
  ('worker.verification.decide',  'Approve or reject verification items and training', true),
  ('worker.documents.view',       'Open worker identity and verification documents (audited)', true),
  ('worker.bank.view',            'View worker bank details (audited)', true),
  ('worker.restriction.manage',   'Impose or lift worker restrictions', true),
  ('availability.read',           'View worker shifts and presence', false),
  ('availability.manage',         'Create and cancel worker shifts', false),
  ('catalog.manage',              'Manage categories, services, options and tasks', false),
  ('service_area.manage',         'Manage cities, zones, localities and pincodes', false),
  ('pricing.manage',              'Manage price, charge, tax, payout and cancellation rules', false),
  ('promotion.manage',            'Manage promotions', false),
  ('settings.manage',             'Manage business settings (invoice issuer, support contacts)', false),
  ('booking.read',                'Search and view bookings and their timelines (masked)', false),
  ('booking.create_on_behalf',    'Create bookings for customers', false),
  ('booking.reschedule',          'Reschedule bookings', false),
  ('booking.cancel',              'Cancel bookings', false),
  ('booking.assign',              'Offer, assign and reassign workers', false),
  ('booking.mark_no_show',        'Record customer or worker no-shows', false),
  ('booking.override',            'Start without code, confirm without prepayment, force assignment', true),
  ('payment.read',                'View payments, provider references and gateway events', false),
  ('invoice.read',                'View and download invoices', false),
  ('refund.read',                 'View refunds', false),
  ('refund.request',              'Request refunds', false),
  ('refund.approve',              'Approve or reject refund requests', true),
  ('payout.read',                 'View worker earnings and payouts', false),
  ('payout.manage',               'Prepare worker payouts', false),
  ('payout.approve',              'Approve worker payouts', true),
  ('support.read',                'View support cases', false),
  ('support.manage',              'Handle support cases', false),
  ('safety.escalate',             'Raise a safety escalation', false),
  ('safety.read',                 'View safety incidents and narratives', true),
  ('safety.manage',               'Command and close safety incidents', true),
  ('notification.manage',         'Manage notification templates', false),
  ('audit.read',                  'View the audit log', true),
  ('user.manage',                 'Create and deactivate staff accounts', false),
  ('role.assign',                 'Grant and revoke staff roles', true);

INSERT INTO role_permission (role_code, permission_code)
SELECT r, p FROM (VALUES
  -- System administration only; no business data access by default.
  ('SUPER_ADMIN', 'user.manage'), ('SUPER_ADMIN', 'role.assign'), ('SUPER_ADMIN', 'settings.manage'),
  ('SUPER_ADMIN', 'catalog.manage'), ('SUPER_ADMIN', 'service_area.manage'),
  ('SUPER_ADMIN', 'notification.manage'), ('SUPER_ADMIN', 'audit.read'),

  ('OPERATIONS_HEAD', 'customer.read'), ('OPERATIONS_HEAD', 'customer.pii.reveal'),
  ('OPERATIONS_HEAD', 'worker.read'), ('OPERATIONS_HEAD', 'worker.pii.reveal'),
  ('OPERATIONS_HEAD', 'worker.status.manage'), ('OPERATIONS_HEAD', 'worker.verification.read'),
  ('OPERATIONS_HEAD', 'availability.read'), ('OPERATIONS_HEAD', 'availability.manage'),
  ('OPERATIONS_HEAD', 'service_area.manage'), ('OPERATIONS_HEAD', 'promotion.manage'),
  ('OPERATIONS_HEAD', 'booking.read'), ('OPERATIONS_HEAD', 'booking.create_on_behalf'),
  ('OPERATIONS_HEAD', 'booking.reschedule'), ('OPERATIONS_HEAD', 'booking.cancel'),
  ('OPERATIONS_HEAD', 'booking.assign'), ('OPERATIONS_HEAD', 'booking.mark_no_show'),
  ('OPERATIONS_HEAD', 'booking.override'), ('OPERATIONS_HEAD', 'invoice.read'),
  ('OPERATIONS_HEAD', 'refund.read'), ('OPERATIONS_HEAD', 'refund.request'),
  ('OPERATIONS_HEAD', 'support.read'), ('OPERATIONS_HEAD', 'support.manage'),
  ('OPERATIONS_HEAD', 'safety.escalate'), ('OPERATIONS_HEAD', 'safety.read'),

  ('DISPATCHER', 'customer.read'), ('DISPATCHER', 'customer.pii.reveal'),
  ('DISPATCHER', 'worker.read'), ('DISPATCHER', 'availability.read'),
  ('DISPATCHER', 'availability.manage'), ('DISPATCHER', 'booking.read'),
  ('DISPATCHER', 'booking.create_on_behalf'), ('DISPATCHER', 'booking.reschedule'),
  ('DISPATCHER', 'booking.cancel'), ('DISPATCHER', 'booking.assign'),
  ('DISPATCHER', 'booking.mark_no_show'), ('DISPATCHER', 'support.read'),
  ('DISPATCHER', 'safety.escalate'),

  ('CUSTOMER_SUPPORT', 'customer.read'), ('CUSTOMER_SUPPORT', 'customer.pii.reveal'),
  ('CUSTOMER_SUPPORT', 'booking.read'), ('CUSTOMER_SUPPORT', 'booking.reschedule'),
  ('CUSTOMER_SUPPORT', 'booking.cancel'), ('CUSTOMER_SUPPORT', 'invoice.read'),
  ('CUSTOMER_SUPPORT', 'refund.read'), ('CUSTOMER_SUPPORT', 'refund.request'),
  ('CUSTOMER_SUPPORT', 'support.read'), ('CUSTOMER_SUPPORT', 'support.manage'),
  ('CUSTOMER_SUPPORT', 'safety.escalate'),

  ('WORKER_OPERATIONS', 'worker.read'), ('WORKER_OPERATIONS', 'worker.pii.reveal'),
  ('WORKER_OPERATIONS', 'worker.manage'), ('WORKER_OPERATIONS', 'worker.status.manage'),
  ('WORKER_OPERATIONS', 'worker.verification.read'), ('WORKER_OPERATIONS', 'worker.verification.decide'),
  ('WORKER_OPERATIONS', 'worker.documents.view'), ('WORKER_OPERATIONS', 'availability.read'),
  ('WORKER_OPERATIONS', 'availability.manage'), ('WORKER_OPERATIONS', 'safety.escalate'),

  -- Money, without personal contact details.
  ('FINANCE', 'booking.read'), ('FINANCE', 'payment.read'), ('FINANCE', 'invoice.read'),
  ('FINANCE', 'refund.read'), ('FINANCE', 'refund.request'), ('FINANCE', 'refund.approve'),
  ('FINANCE', 'payout.read'), ('FINANCE', 'payout.manage'), ('FINANCE', 'payout.approve'),
  ('FINANCE', 'worker.bank.view'), ('FINANCE', 'pricing.manage'),

  ('SAFETY', 'safety.read'), ('SAFETY', 'safety.manage'), ('SAFETY', 'safety.escalate'),
  ('SAFETY', 'worker.read'), ('SAFETY', 'worker.pii.reveal'), ('SAFETY', 'worker.status.manage'),
  ('SAFETY', 'worker.restriction.manage'), ('SAFETY', 'customer.read'),
  ('SAFETY', 'customer.pii.reveal'), ('SAFETY', 'booking.read'), ('SAFETY', 'booking.cancel'),
  ('SAFETY', 'support.read'),

  -- Read-only and masked; cannot reveal personal data.
  ('AUDITOR', 'audit.read'), ('AUDITOR', 'booking.read'), ('AUDITOR', 'payment.read'),
  ('AUDITOR', 'invoice.read'), ('AUDITOR', 'refund.read'), ('AUDITOR', 'payout.read'),
  ('AUDITOR', 'customer.read'), ('AUDITOR', 'worker.read'), ('AUDITOR', 'support.read'),
  ('AUDITOR', 'safety.read')
) AS grants (r, p);

-- ===========================================================================
-- 3. Staff sign-in: password → authenticator (TOTP) → session
-- ===========================================================================

ALTER TABLE staff_credential
  ADD COLUMN totp_pending_secret_encrypted bytea,
  ADD COLUMN totp_last_used_step bigint;

CREATE TABLE staff_login_challenge (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES app_user (id),
  token_hash    text NOT NULL UNIQUE,
  purpose       text NOT NULL CHECK (purpose IN ('MFA_VERIFY', 'MFA_ENROLL')),
  attempts      int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts  int NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  ip            inet,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Refresh-token rotation: the previous hash is kept to detect reuse of a stolen token.
ALTER TABLE auth_session
  ADD COLUMN previous_refresh_token_hash text,
  ADD COLUMN mfa_verified_at timestamptz,
  ADD COLUMN rotated_at timestamptz;

CREATE INDEX auth_session_previous_hash_idx ON auth_session (previous_refresh_token_hash)
  WHERE previous_refresh_token_hash IS NOT NULL;
CREATE INDEX otp_challenge_ip_idx ON otp_challenge (request_ip, created_at DESC);

-- ===========================================================================
-- 4. Payments and refunds
-- ===========================================================================

ALTER TABLE payment DROP CONSTRAINT payment_provider_check;
ALTER TABLE payment ADD CONSTRAINT payment_provider_check
  CHECK (provider IN ('RAZORPAY', 'SANDBOX', 'CASH'));

-- Customer-facing data needed to open the gateway checkout for this order.
ALTER TABLE payment ADD COLUMN checkout jsonb;

ALTER TABLE payment_event ADD COLUMN refund_id uuid REFERENCES refund (id);

-- Refunds can be approved by a named person or by a configured policy (e.g. automatic
-- full refund when One Tappe cancels). Either way the decision is recorded.
ALTER TABLE refund DROP CONSTRAINT refund_check1;
ALTER TABLE refund DROP CONSTRAINT refund_reason_code_check;
ALTER TABLE refund
  ADD COLUMN decision_policy text,
  ADD CONSTRAINT refund_decision_check CHECK (
    status NOT IN ('APPROVED', 'REJECTED', 'PROCESSING', 'PROCESSED', 'FAILED')
    OR (decided_at IS NOT NULL AND (decided_by IS NOT NULL OR decision_policy IS NOT NULL))),
  ADD CONSTRAINT refund_reason_code_check CHECK (reason_code IN (
    'CUSTOMER_CANCELLED', 'COMPANY_CANCELLED', 'NO_WORKER_AVAILABLE', 'WORKER_NO_SHOW',
    'SERVICE_ISSUE', 'DUPLICATE_PAYMENT', 'PAYMENT_AFTER_EXPIRY', 'GOODWILL', 'OTHER'));

-- Configurable customer-cancellation refunds. The rule with the largest
-- min_minutes_before_start that is still <= the time left before the booking applies.
-- With no matching rule the customer receives a full refund.
CREATE TABLE cancellation_rule (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL = every service.
  service_id                uuid REFERENCES service (id),
  min_minutes_before_start  int NOT NULL CHECK (min_minutes_before_start >= 0),
  refund_bp                 int NOT NULL CHECK (refund_bp BETWEEN 0 AND 10000),
  description               text NOT NULL,
  valid_from                timestamptz NOT NULL,
  valid_to                  timestamptz,
  is_active                 boolean NOT NULL DEFAULT true,
  created_by                uuid REFERENCES app_user (id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE TRIGGER cancellation_rule_no_delete BEFORE DELETE ON cancellation_rule
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER cancellation_rule_audit AFTER INSERT OR UPDATE ON cancellation_rule
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');

-- ===========================================================================
-- 5. Business settings managed by operations (invoice issuer, support contact, …)
-- ===========================================================================

CREATE TABLE business_setting (
  key          text PRIMARY KEY CHECK (key ~ '^[a-z_]+(\.[a-z_]+)*$'),
  value        jsonb NOT NULL,
  description  text NOT NULL,
  updated_by   uuid REFERENCES app_user (id),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER business_setting_updated_at BEFORE UPDATE ON business_setting
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER business_setting_no_delete BEFORE DELETE ON business_setting
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER business_setting_audit AFTER INSERT OR UPDATE ON business_setting
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('key');

-- ===========================================================================
-- 6. Background job runs (observability; jobs themselves are idempotent)
-- ===========================================================================

CREATE TABLE job_run (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_name     text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at  timestamptz,
  status       text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
  processed    int NOT NULL DEFAULT 0,
  error        text
);

CREATE INDEX job_run_name_idx ON job_run (job_name, started_at DESC);

-- ===========================================================================
-- 7. Notifications: recipients are resolved at send time; channels may be skipped
--    when the user has no address for them.
-- ===========================================================================

ALTER TABLE notification DROP CONSTRAINT notification_status_check;
ALTER TABLE notification ADD CONSTRAINT notification_status_check CHECK (status IN (
  'QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'CANCELLED', 'SKIPPED'));
