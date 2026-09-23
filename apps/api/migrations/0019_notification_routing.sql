-- 0019 Notification routing.
--
-- Business code raises events (BOOKING_CONFIRMED...). Which channels an event goes out on
-- is configuration: one row per (event, channel), switched on or off by operations. The
-- wording stays in notification_template. A channel is used only when its route is on, a
-- template exists in the recipient's language (or English), and the recipient can be
-- reached on it (device token, phone, email, WhatsApp opt-in).

CREATE TABLE notification_route (
  event_code  text NOT NULL CHECK (event_code ~ '^[A-Z0-9_]{2,60}$'),
  channel     text NOT NULL CHECK (channel IN ('PUSH', 'SMS', 'WHATSAPP', 'EMAIL', 'IN_APP')),
  is_enabled  boolean NOT NULL DEFAULT true,
  updated_by  uuid REFERENCES app_user (id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_code, channel)
);

CREATE TRIGGER notification_route_updated_at BEFORE UPDATE ON notification_route
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER notification_route_no_delete BEFORE DELETE ON notification_route
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER notification_route_audit AFTER INSERT OR UPDATE ON notification_route
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('event_code');

-- Behaviour-preserving start: every channel that already has a template stays on.
INSERT INTO notification_route (event_code, channel)
SELECT DISTINCT code, channel FROM notification_template WHERE is_active;

-- WhatsApp business-initiated messages require the person's opt-in.
ALTER TABLE consent_record DROP CONSTRAINT consent_record_purpose_check;
ALTER TABLE consent_record ADD CONSTRAINT consent_record_purpose_check
  CHECK (purpose IN ('TERMS', 'PRIVACY', 'MARKETING', 'LOCATION', 'WORKER_TRACKING', 'WHATSAPP'));

-- Provider outcome detail for support questions ("did the SMS go out?").
ALTER TABLE notification ADD COLUMN skipped_reason text
  CHECK (skipped_reason IN ('NO_RECIPIENT', 'NO_PROVIDER', 'NO_CONSENT', 'ROUTE_DISABLED'));
