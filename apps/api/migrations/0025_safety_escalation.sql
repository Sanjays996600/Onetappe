-- 0025 SOS paging, acknowledgement and escalation.
--
-- A critical incident pages the level-1 on-call safety staff at once (SMS and email, in
-- the same transaction that records the incident), then pages wider every few minutes
-- until a person acknowledges it. Delivery failures do not stop escalation: only an
-- acknowledgement does. Prometheus alerts on the same state independently.

ALTER TABLE safety_incident
  ADD COLUMN acknowledged_at    timestamptz,
  ADD COLUMN acknowledged_by    uuid REFERENCES app_user (id),
  -- How many paging rounds have been sent (the roster level is min(rounds, 3)).
  ADD COLUMN pages_sent         int NOT NULL DEFAULT 0 CHECK (pages_sent >= 0),
  ADD COLUMN next_page_at       timestamptz,
  ADD CONSTRAINT safety_incident_ack_pair CHECK ((acknowledged_at IS NULL) = (acknowledged_by IS NULL)),
  ADD CONSTRAINT safety_incident_ack_stops_paging CHECK (acknowledged_at IS NULL OR next_page_at IS NULL);

CREATE INDEX safety_incident_page_due_idx ON safety_incident (next_page_at)
  WHERE next_page_at IS NOT NULL;

ALTER TABLE safety_incident_event DROP CONSTRAINT safety_incident_event_event_type_check;
ALTER TABLE safety_incident_event ADD CONSTRAINT safety_incident_event_event_type_check
  CHECK (event_type IN ('NOTE', 'STATUS_CHANGE', 'ACTION_TAKEN', 'ESCALATED', 'COMMANDER_CHANGE',
                        'ACKNOWLEDGED', 'PAGED', 'NO_ONE_ON_CALL'));

-- Who is paged, by level. Level 1 is paged first; each later round adds the next level.
CREATE TABLE safety_on_call (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  level       smallint NOT NULL CHECK (level BETWEEN 1 AND 3),
  user_id     uuid NOT NULL REFERENCES app_user (id),
  reason      text NOT NULL CHECK (length(trim(reason)) > 0),
  added_by    uuid NOT NULL REFERENCES app_user (id),
  added_at    timestamptz NOT NULL DEFAULT now(),
  removed_by  uuid REFERENCES app_user (id),
  removed_at  timestamptz,
  CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);

CREATE UNIQUE INDEX safety_on_call_active_uq ON safety_on_call (level, user_id)
  WHERE removed_at IS NULL;

CREATE TRIGGER safety_on_call_context BEFORE INSERT OR UPDATE ON safety_on_call
  FOR EACH ROW EXECUTE FUNCTION require_action_context();
CREATE TRIGGER safety_on_call_no_delete BEFORE DELETE ON safety_on_call
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER safety_on_call_audit AFTER INSERT OR UPDATE ON safety_on_call
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');

-- The page itself: no names, addresses or locations (SMS passes through carriers); the
-- details are in the admin panel, behind sign-in and the safety permissions.
INSERT INTO notification_template (code, channel, locale, version, title, body) VALUES
  ('SAFETY_ALERT', 'SMS', 'en', 1, NULL,
   'One Tappe SAFETY: {{category}} {{incidentCode}} raised by a {{reporter}} at {{raisedAt}}. Page {{page}}. Open the admin panel and acknowledge now.'),
  ('SAFETY_ALERT', 'EMAIL', 'en', 1, 'SAFETY {{category}} {{incidentCode}} — acknowledge now',
   'A {{reporter}} raised {{category}} {{incidentCode}} at {{raisedAt}}. This is page {{page}}; paging widens until someone acknowledges it in the admin panel.');

INSERT INTO notification_route (event_code, channel) VALUES
  ('SAFETY_ALERT', 'SMS'), ('SAFETY_ALERT', 'EMAIL');
