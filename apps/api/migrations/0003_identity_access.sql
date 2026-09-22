-- 0003 Identity and access: users, roles, permissions, sessions, devices, consent.
-- One person = one app_user, whether they are a customer, a worker, staff or several.

CREATE TABLE app_user (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164        text UNIQUE CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  email             citext UNIQUE,
  full_name         text,
  preferred_locale  text NOT NULL DEFAULT 'en' REFERENCES locale (code),
  status            text NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DEACTIVATED')),
  phone_verified_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deactivated_at    timestamptz,
  CHECK (phone_e164 IS NOT NULL OR email IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- Roles and permissions (RBAC). Roles may be scoped to a city.
-- ---------------------------------------------------------------------------

CREATE TABLE role (
  code         text PRIMARY KEY CHECK (code ~ '^[A-Z_]+$'),
  name         text NOT NULL,
  description  text NOT NULL,
  is_staff     boolean NOT NULL
);

CREATE TABLE permission (
  code         text PRIMARY KEY CHECK (code ~ '^[a-z_]+(\.[a-z_]+)+$'),
  description  text NOT NULL,
  -- Grants access to personal or safety data that is masked by default.
  is_sensitive boolean NOT NULL DEFAULT false
);

CREATE TABLE role_permission (
  role_code        text NOT NULL REFERENCES role (code),
  permission_code  text NOT NULL REFERENCES permission (code),
  PRIMARY KEY (role_code, permission_code)
);

CREATE TABLE user_role (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app_user (id),
  role_code   text NOT NULL REFERENCES role (code),
  -- NULL = all cities.
  city_id     uuid REFERENCES city (id),
  granted_by  uuid REFERENCES app_user (id),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  revoked_by  uuid REFERENCES app_user (id),
  revoked_at  timestamptz,
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CHECK (granted_by IS NULL OR granted_by <> user_id)
);

CREATE UNIQUE INDEX user_role_active_uq
  ON user_role (user_id, role_code, COALESCE(city_id, '00000000-0000-0000-0000-000000000000'))
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Authentication
-- ---------------------------------------------------------------------------

-- Staff sign in with password + TOTP. Secrets are stored encrypted by the API.
CREATE TABLE staff_credential (
  user_id               uuid PRIMARY KEY REFERENCES app_user (id),
  password_hash         text NOT NULL,
  totp_secret_encrypted bytea,
  mfa_enrolled_at       timestamptz,
  failed_attempts       int NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until          timestamptz,
  password_changed_at   timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Phone OTP challenges for customers and workers. Only a hash of the code is stored.
CREATE TABLE otp_challenge (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164    text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  purpose       text NOT NULL CHECK (purpose IN ('LOGIN')),
  client_app    text NOT NULL CHECK (client_app IN ('CUSTOMER_APP', 'WORKER_APP')),
  code_hash     text NOT NULL,
  attempts      int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts  int NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  request_ip    inet,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX otp_challenge_phone_idx ON otp_challenge (phone_e164, created_at DESC);

CREATE TABLE auth_session (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES app_user (id),
  client_app          text NOT NULL CHECK (client_app IN ('CUSTOMER_APP', 'WORKER_APP', 'ADMIN_WEB')),
  device_id           uuid,
  refresh_token_hash  text NOT NULL UNIQUE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_used_at        timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  revoked_at          timestamptz,
  revoke_reason       text,
  ip                  inet,
  user_agent          text
);

CREATE INDEX auth_session_user_idx ON auth_session (user_id) WHERE revoked_at IS NULL;

-- Devices for push notifications (Android, iOS, web).
CREATE TABLE user_device (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES app_user (id),
  client_app    text NOT NULL CHECK (client_app IN ('CUSTOMER_APP', 'WORKER_APP', 'ADMIN_WEB')),
  platform      text NOT NULL CHECK (platform IN ('ANDROID', 'IOS', 'WEB')),
  push_token    text UNIQUE,
  app_version   text,
  locale        text REFERENCES locale (code),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  disabled_at   timestamptz
);

ALTER TABLE auth_session
  ADD CONSTRAINT auth_session_device_fk FOREIGN KEY (device_id) REFERENCES user_device (id);

-- ---------------------------------------------------------------------------
-- Legal documents and consent (terms, privacy notice, marketing, location, …)
-- ---------------------------------------------------------------------------

CREATE TABLE legal_document (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL CHECK (code IN ('CUSTOMER_TERMS', 'PRIVACY_NOTICE',
                                                'WORKER_TERMS', 'CANCELLATION_POLICY')),
  version         text NOT NULL,
  locale          text NOT NULL REFERENCES locale (code),
  title           text NOT NULL,
  url             text NOT NULL,
  content_sha256  text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  effective_from  timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, version, locale)
);

CREATE TABLE consent_record (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES app_user (id),
  purpose            text NOT NULL CHECK (purpose IN ('TERMS', 'PRIVACY', 'MARKETING',
                                                      'LOCATION', 'WORKER_TRACKING')),
  legal_document_id  uuid REFERENCES legal_document (id),
  granted_at         timestamptz NOT NULL DEFAULT now(),
  withdrawn_at       timestamptz,
  source             action_source NOT NULL,
  ip                 inet,
  CHECK (withdrawn_at IS NULL OR withdrawn_at >= granted_at)
);

CREATE INDEX consent_record_user_idx ON consent_record (user_id, purpose);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER app_user_updated_at BEFORE UPDATE ON app_user
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER staff_credential_updated_at BEFORE UPDATE ON staff_credential
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER app_user_no_delete BEFORE DELETE ON app_user
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER user_role_no_delete BEFORE DELETE ON user_role
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER consent_record_no_delete BEFORE DELETE ON consent_record
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TRIGGER user_role_context BEFORE INSERT OR UPDATE ON user_role
  FOR EACH ROW EXECUTE FUNCTION require_action_context();

CREATE TRIGGER app_user_audit AFTER INSERT OR UPDATE ON app_user
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
CREATE TRIGGER user_role_audit AFTER INSERT OR UPDATE ON user_role
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
CREATE TRIGGER role_permission_audit AFTER INSERT OR UPDATE OR DELETE ON role_permission
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('role_code');
CREATE TRIGGER staff_credential_audit AFTER INSERT OR UPDATE ON staff_credential
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('user_id', 'password_hash', 'totp_secret_encrypted');
CREATE TRIGGER consent_record_audit AFTER INSERT OR UPDATE ON consent_record
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');

-- ---------------------------------------------------------------------------
-- Seed: roles and permissions
-- ---------------------------------------------------------------------------

INSERT INTO role (code, name, description, is_staff) VALUES
  ('CUSTOMER',             'Customer',             'Books and pays for services', false),
  ('WORKER',               'Worker',               'Delivers services', false),
  ('SUPER_ADMIN',          'Super admin',          'Manages users, roles and configuration', true),
  ('FOUNDER',              'Founder',              'Business approvals and reporting', true),
  ('CITY_MANAGER',         'City manager',         'Runs live operations for a city', true),
  ('OPERATIONS_AGENT',     'Operations agent',     'Creates and dispatches bookings', true),
  ('SUPPORT_AGENT',        'Support agent',        'Handles customer and worker support cases', true),
  ('VERIFICATION_OFFICER', 'Verification officer', 'Verifies worker documents and training', true),
  ('SAFETY_OFFICER',       'Safety officer',       'Handles safety incidents and restrictions', true),
  ('FINANCE',              'Finance',              'Payments, refunds, invoices and payouts', true),
  ('MARKETING',            'Marketing',            'Promotions', true);

INSERT INTO permission (code, description, is_sensitive) VALUES
  ('customer.read',                'View customer list and profiles (masked)', false),
  ('customer.read_contact',        'View full customer phone numbers and addresses', true),
  ('customer.manage',              'Edit or suspend customers', false),
  ('worker.read',                  'View worker list and profiles (masked)', false),
  ('worker.read_contact',          'View full worker phone numbers and addresses', true),
  ('worker.manage',                'Edit worker profiles, permissions and status', false),
  ('worker_verification.read',     'View verification status and documents', true),
  ('worker_verification.decide',   'Approve or reject verification items', true),
  ('worker_bank.read',             'View worker bank details', true),
  ('availability.manage',          'Create and cancel worker shifts', false),
  ('catalog.manage',               'Manage categories, services, options and tasks', false),
  ('service_area.manage',          'Manage cities, zones, localities and pincodes', false),
  ('pricing.manage',               'Manage price, charge, tax and payout rules', false),
  ('promotion.manage',             'Manage promotions', false),
  ('booking.read',                 'View bookings', false),
  ('booking.create_on_behalf',     'Create bookings for customers', false),
  ('booking.update',               'Reschedule, hold and annotate bookings', false),
  ('booking.cancel',               'Cancel bookings', false),
  ('booking.assign',               'Assign and reassign workers', false),
  ('booking.override',             'Override start verification or confirm without prepayment', false),
  ('payment.read',                 'View payments and invoices', false),
  ('refund.request',               'Request refunds', false),
  ('refund.approve',               'Approve or reject refunds', false),
  ('payout.manage',                'Prepare worker payouts', false),
  ('payout.approve',               'Approve worker payouts', false),
  ('support.read',                 'View support cases', false),
  ('support.manage',               'Handle support cases', false),
  ('safety.read',                  'View safety incidents', true),
  ('safety.manage',                'Manage safety incidents and worker restrictions', true),
  ('notification.manage',          'Manage notification templates', false),
  ('audit.read',                   'View the audit log', true),
  ('user.manage',                  'Create staff users and assign roles', false);

INSERT INTO role_permission (role_code, permission_code)
SELECT r, p FROM (VALUES
  ('SUPER_ADMIN', 'user.manage'), ('SUPER_ADMIN', 'audit.read'),
  ('SUPER_ADMIN', 'catalog.manage'), ('SUPER_ADMIN', 'service_area.manage'),
  ('SUPER_ADMIN', 'pricing.manage'), ('SUPER_ADMIN', 'notification.manage'),

  ('FOUNDER', 'customer.read'), ('FOUNDER', 'worker.read'), ('FOUNDER', 'booking.read'),
  ('FOUNDER', 'payment.read'), ('FOUNDER', 'support.read'), ('FOUNDER', 'safety.read'),
  ('FOUNDER', 'audit.read'), ('FOUNDER', 'catalog.manage'), ('FOUNDER', 'service_area.manage'),
  ('FOUNDER', 'pricing.manage'), ('FOUNDER', 'payout.approve'), ('FOUNDER', 'refund.approve'),

  ('CITY_MANAGER', 'customer.read'), ('CITY_MANAGER', 'customer.read_contact'),
  ('CITY_MANAGER', 'worker.read'), ('CITY_MANAGER', 'worker.read_contact'),
  ('CITY_MANAGER', 'worker.manage'), ('CITY_MANAGER', 'availability.manage'),
  ('CITY_MANAGER', 'service_area.manage'), ('CITY_MANAGER', 'booking.read'),
  ('CITY_MANAGER', 'booking.create_on_behalf'), ('CITY_MANAGER', 'booking.update'),
  ('CITY_MANAGER', 'booking.cancel'), ('CITY_MANAGER', 'booking.assign'),
  ('CITY_MANAGER', 'booking.override'), ('CITY_MANAGER', 'payment.read'),
  ('CITY_MANAGER', 'refund.request'), ('CITY_MANAGER', 'refund.approve'),
  ('CITY_MANAGER', 'support.read'), ('CITY_MANAGER', 'support.manage'),
  ('CITY_MANAGER', 'safety.read'), ('CITY_MANAGER', 'promotion.manage'),

  ('OPERATIONS_AGENT', 'customer.read'), ('OPERATIONS_AGENT', 'customer.read_contact'),
  ('OPERATIONS_AGENT', 'worker.read'), ('OPERATIONS_AGENT', 'availability.manage'),
  ('OPERATIONS_AGENT', 'booking.read'), ('OPERATIONS_AGENT', 'booking.create_on_behalf'),
  ('OPERATIONS_AGENT', 'booking.update'), ('OPERATIONS_AGENT', 'booking.cancel'),
  ('OPERATIONS_AGENT', 'booking.assign'), ('OPERATIONS_AGENT', 'support.read'),

  ('SUPPORT_AGENT', 'customer.read'), ('SUPPORT_AGENT', 'worker.read'),
  ('SUPPORT_AGENT', 'booking.read'), ('SUPPORT_AGENT', 'booking.cancel'),
  ('SUPPORT_AGENT', 'payment.read'), ('SUPPORT_AGENT', 'refund.request'),
  ('SUPPORT_AGENT', 'support.read'), ('SUPPORT_AGENT', 'support.manage'),

  ('VERIFICATION_OFFICER', 'worker.read'), ('VERIFICATION_OFFICER', 'worker.read_contact'),
  ('VERIFICATION_OFFICER', 'worker.manage'), ('VERIFICATION_OFFICER', 'worker_verification.read'),
  ('VERIFICATION_OFFICER', 'worker_verification.decide'),

  ('SAFETY_OFFICER', 'customer.read'), ('SAFETY_OFFICER', 'customer.read_contact'),
  ('SAFETY_OFFICER', 'worker.read'), ('SAFETY_OFFICER', 'worker.read_contact'),
  ('SAFETY_OFFICER', 'worker_verification.read'), ('SAFETY_OFFICER', 'booking.read'),
  ('SAFETY_OFFICER', 'booking.cancel'), ('SAFETY_OFFICER', 'support.read'),
  ('SAFETY_OFFICER', 'safety.read'), ('SAFETY_OFFICER', 'safety.manage'),

  ('FINANCE', 'booking.read'), ('FINANCE', 'payment.read'), ('FINANCE', 'refund.request'),
  ('FINANCE', 'refund.approve'), ('FINANCE', 'payout.manage'), ('FINANCE', 'worker_bank.read'),
  ('FINANCE', 'pricing.manage'),

  ('MARKETING', 'promotion.manage')
) AS grants (r, p);
