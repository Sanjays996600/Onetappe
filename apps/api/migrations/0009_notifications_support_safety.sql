-- 0009 Promotion redemptions, notifications, support cases and safety incidents.

CREATE TABLE promotion_redemption (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id    uuid NOT NULL REFERENCES promotion (id),
  user_id         uuid NOT NULL REFERENCES app_user (id),
  booking_id      uuid NOT NULL UNIQUE REFERENCES booking (id),
  discount_paise  bigint NOT NULL CHECK (discount_paise > 0),
  -- RESERVED at booking, REDEEMED once paid, RELEASED if the booking never went ahead.
  status          text NOT NULL DEFAULT 'RESERVED'
                  CHECK (status IN ('RESERVED', 'REDEEMED', 'RELEASED')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX promotion_redemption_usage_idx ON promotion_redemption (promotion_id, user_id)
  WHERE status <> 'RELEASED';

-- ---------------------------------------------------------------------------
-- Notifications (push, SMS, WhatsApp, email, in-app), templated per language.
-- ---------------------------------------------------------------------------

CREATE TABLE notification_template (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                  text NOT NULL CHECK (code ~ '^[A-Z0-9_]{2,60}$'),
  channel               text NOT NULL CHECK (channel IN ('PUSH', 'SMS', 'WHATSAPP', 'EMAIL', 'IN_APP')),
  locale                text NOT NULL REFERENCES locale (code),
  version               int NOT NULL CHECK (version > 0),
  title                 text,
  body                  text NOT NULL,
  -- Template id registered with the provider (DLT for SMS, Meta for WhatsApp).
  provider_template_id  text,
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, channel, locale, version)
);

CREATE UNIQUE INDEX notification_template_active_uq
  ON notification_template (code, channel, locale) WHERE is_active;

CREATE TABLE notification (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES app_user (id),
  booking_id           uuid REFERENCES booking (id),
  template_id          uuid NOT NULL REFERENCES notification_template (id),
  channel              text NOT NULL CHECK (channel IN ('PUSH', 'SMS', 'WHATSAPP', 'EMAIL', 'IN_APP')),
  locale               text NOT NULL REFERENCES locale (code),
  variables            jsonb NOT NULL DEFAULT '{}'::jsonb,
  status               text NOT NULL DEFAULT 'QUEUED'
                       CHECK (status IN ('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ',
                                         'FAILED', 'CANCELLED')),
  -- The same logical message is never queued twice (e.g. "BOOKING_CONFIRMED:<booking>").
  dedupe_key           text NOT NULL UNIQUE,
  attempts             int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at      timestamptz NOT NULL DEFAULT now(),
  provider_message_id  text,
  last_error           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz,
  delivered_at         timestamptz,
  read_at              timestamptz
);

CREATE INDEX notification_queue_idx ON notification (next_attempt_at)
  WHERE status IN ('QUEUED', 'FAILED');
CREATE INDEX notification_user_idx ON notification (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Support cases (complaints, questions, refund requests from customers or workers).
-- ---------------------------------------------------------------------------

CREATE SEQUENCE support_case_code_seq;

CREATE TABLE support_case (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_code           text NOT NULL UNIQUE
                      DEFAULT ('SC' || lpad(nextval('support_case_code_seq')::text, 7, '0')),
  booking_id          uuid REFERENCES booking (id),
  raised_by_user_id   uuid NOT NULL REFERENCES app_user (id),
  raised_by_role      text NOT NULL CHECK (raised_by_role IN ('CUSTOMER', 'WORKER', 'STAFF')),
  source              action_source NOT NULL,
  category            text NOT NULL
                      CHECK (category IN ('SERVICE_QUALITY', 'LATE_ARRIVAL', 'NO_SHOW',
                                          'BILLING', 'REFUND', 'DAMAGE', 'BEHAVIOUR',
                                          'APP_ISSUE', 'WORKER_PAYOUT', 'OTHER')),
  severity            text NOT NULL DEFAULT 'MEDIUM'
                      CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH')),
  status              text NOT NULL DEFAULT 'OPEN'
                      CHECK (status IN ('OPEN', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER',
                                        'RESOLVED', 'CLOSED')),
  owner_user_id       uuid REFERENCES app_user (id),
  subject             text NOT NULL CHECK (length(subject) <= 200),
  description         text NOT NULL CHECK (length(description) <= 5000),
  desired_resolution  text,
  resolution_summary  text,
  next_update_due_at  timestamptz,
  -- Linked safety incident when the case raises a safety concern.
  safety_incident_id  uuid,
  opened_at           timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz,
  closed_at           timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('RESOLVED', 'CLOSED') OR resolution_summary IS NOT NULL)
);

CREATE INDEX support_case_queue_idx ON support_case (status, next_update_due_at);
CREATE INDEX support_case_booking_idx ON support_case (booking_id);

CREATE TABLE support_case_event (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id        uuid NOT NULL REFERENCES support_case (id),
  event_type     text NOT NULL CHECK (event_type IN ('NOTE', 'STATUS_CHANGE', 'OWNER_CHANGE',
                                                     'MESSAGE_TO_CUSTOMER', 'MESSAGE_FROM_CUSTOMER')),
  from_status    text,
  to_status      text,
  body           text,
  -- Internal notes are never shown in customer or worker apps.
  is_internal    boolean NOT NULL DEFAULT true,
  actor_user_id  uuid REFERENCES app_user (id),
  source         action_source NOT NULL,
  occurred_at    timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX support_case_event_case_idx ON support_case_event (case_id, id);

-- ---------------------------------------------------------------------------
-- Safety incidents (SOS, injury, harassment, …). Access is restricted by permission.
-- ---------------------------------------------------------------------------

CREATE SEQUENCE safety_incident_code_seq;

CREATE TABLE safety_incident (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_code        text NOT NULL UNIQUE
                       DEFAULT ('SI' || lpad(nextval('safety_incident_code_seq')::text, 6, '0')),
  booking_id           uuid REFERENCES booking (id),
  reported_by_user_id  uuid NOT NULL REFERENCES app_user (id),
  reporter_role        text NOT NULL CHECK (reporter_role IN ('CUSTOMER', 'WORKER', 'STAFF')),
  source               action_source NOT NULL,
  severity             text NOT NULL CHECK (severity IN ('CRITICAL', 'HIGH', 'ROUTINE')),
  category             text NOT NULL
                       CHECK (category IN ('SOS', 'INJURY', 'MEDICAL', 'HARASSMENT', 'VIOLENCE',
                                           'THEFT_ALLEGATION', 'PROPERTY_DAMAGE', 'UNSAFE_PREMISES',
                                           'OUT_OF_SCOPE_REQUEST', 'DATA_EXPOSURE', 'OTHER')),
  status               text NOT NULL DEFAULT 'OPEN'
                       CHECK (status IN ('OPEN', 'CONTAINED', 'UNDER_REVIEW', 'CLOSED')),
  lat                  numeric(9, 6) CHECK (lat BETWEEN -90 AND 90),
  lng                  numeric(9, 6) CHECK (lng BETWEEN -180 AND 180),
  location_text        text,
  -- Restricted narrative. Never copied into the general audit log.
  summary              text NOT NULL,
  commander_user_id    uuid REFERENCES app_user (id),
  occurred_at          timestamptz NOT NULL DEFAULT now(),
  reported_at          timestamptz NOT NULL DEFAULT now(),
  review_due_at        timestamptz,
  closed_by            uuid REFERENCES app_user (id),
  closed_at            timestamptz,
  closure_summary      text,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL)),
  CHECK (status <> 'CLOSED' OR (closed_by IS NOT NULL AND closure_summary IS NOT NULL)),
  -- Serious incidents are closed by someone other than the person who led the response.
  CHECK (severity = 'ROUTINE' OR closed_by IS NULL OR closed_by IS DISTINCT FROM commander_user_id)
);

CREATE INDEX safety_incident_open_idx ON safety_incident (severity, reported_at)
  WHERE status <> 'CLOSED';

ALTER TABLE support_case
  ADD CONSTRAINT support_case_safety_incident_fk
  FOREIGN KEY (safety_incident_id) REFERENCES safety_incident (id);

CREATE TABLE safety_incident_event (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  incident_id    uuid NOT NULL REFERENCES safety_incident (id),
  event_type     text NOT NULL CHECK (event_type IN ('NOTE', 'STATUS_CHANGE', 'ACTION_TAKEN',
                                                     'ESCALATED', 'COMMANDER_CHANGE')),
  from_status    text,
  to_status      text,
  body           text NOT NULL,
  actor_user_id  uuid REFERENCES app_user (id),
  source         action_source NOT NULL,
  occurred_at    timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX safety_incident_event_incident_idx ON safety_incident_event (incident_id, id);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER promotion_redemption_updated_at BEFORE UPDATE ON promotion_redemption FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER support_case_updated_at BEFORE UPDATE ON support_case FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER safety_incident_updated_at BEFORE UPDATE ON safety_incident FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER support_case_context BEFORE INSERT OR UPDATE ON support_case FOR EACH ROW EXECUTE FUNCTION require_action_context();
CREATE TRIGGER safety_incident_context BEFORE INSERT OR UPDATE ON safety_incident FOR EACH ROW EXECUTE FUNCTION require_action_context();

CREATE TRIGGER promotion_redemption_no_delete BEFORE DELETE ON promotion_redemption FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER notification_template_no_delete BEFORE DELETE ON notification_template FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER support_case_no_delete BEFORE DELETE ON support_case FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER safety_incident_no_delete BEFORE DELETE ON safety_incident FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER support_case_event_append_only BEFORE UPDATE OR DELETE ON support_case_event FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER safety_incident_event_append_only BEFORE UPDATE OR DELETE ON safety_incident_event FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

CREATE TRIGGER promotion_redemption_audit AFTER INSERT OR UPDATE ON promotion_redemption FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
CREATE TRIGGER notification_template_audit AFTER INSERT OR UPDATE ON notification_template FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
CREATE TRIGGER support_case_audit AFTER INSERT OR UPDATE ON support_case FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
CREATE TRIGGER safety_incident_audit AFTER INSERT OR UPDATE ON safety_incident FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'summary', 'closure_summary');
