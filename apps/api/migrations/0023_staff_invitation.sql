-- 0023 Staff accounts are created by invitation.
--
-- An administrator (user.manage, recent MFA, written reason) creates the account and its
-- roles; the person receives a one-time invitation link, chooses their own password and
-- enrols their authenticator at first sign-in. Nobody ever knows another person's
-- password. A new invitation is also how a forgotten password is reset.

CREATE TABLE staff_invitation (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app_user (id),
  token_hash  text NOT NULL UNIQUE,          -- SHA-256 of the token; the token is shown once
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at  timestamptz,
  created_by  uuid REFERENCES app_user (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (accepted_at IS NULL OR revoked_at IS NULL),
  CHECK (expires_at > created_at)
);

-- At most one usable invitation per person.
CREATE UNIQUE INDEX staff_invitation_open_uq ON staff_invitation (user_id)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TRIGGER staff_invitation_context BEFORE INSERT OR UPDATE ON staff_invitation
  FOR EACH ROW EXECUTE FUNCTION require_action_context();
CREATE TRIGGER staff_invitation_audit AFTER INSERT OR UPDATE ON staff_invitation
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'token_hash');
CREATE TRIGGER staff_invitation_no_delete BEFORE DELETE ON staff_invitation
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

