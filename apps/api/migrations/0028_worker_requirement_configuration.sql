-- 0028 Training modules and worker requirements as audited configuration (engineering gate G4).
--
-- A service's verification and training requirements decide which workers may be booked for
-- it: worker_eligibility_problem() reads them at every allocation. Until now they could be
-- changed only by a migration. From here:
--   * strengthening (a new training module, a new requirement) is an audited change;
--   * weakening (removing a requirement) needs two people: one requests it with a reason, a
--     different person approves, and only then is the requirement removed. The database
--     enforces this, so no code path, and no direct SQL by the application role, can drop a
--     requirement on one person's say;
--   * a module that a service requires cannot be switched off; requirements cannot be edited
--     in place (an edit is a removal plus an addition); modules cannot be deleted.
-- Which staff roles hold the new permissions is a business decision and is NOT granted here.

-- ---------------------------------------------------------------------------
-- Permissions (deliberately not granted to any role by this migration)
-- ---------------------------------------------------------------------------

INSERT INTO permission (code, description, is_sensitive) VALUES
  ('worker_requirement.read',
   'View training modules and the verifications and training each service requires', false),
  ('worker_requirement.manage',
   'Add training modules and requirements; request that a requirement be removed', false),
  ('worker_requirement.approve_relaxation',
   'Approve or reject the removal of a worker requirement (never one''s own request)', false);

-- ---------------------------------------------------------------------------
-- Training modules: attributable, audited, never deleted; a required module stays active
-- ---------------------------------------------------------------------------

CREATE FUNCTION training_module_before_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'A training module''s code cannot change' USING ERRCODE = 'OT003';
  END IF;
  IF OLD.is_active AND NOT NEW.is_active AND EXISTS (
    SELECT 1 FROM service_training_requirement r WHERE r.module_code = NEW.code
  ) THEN
    RAISE EXCEPTION 'Training module % is required by a service; remove the requirement first',
      NEW.code USING ERRCODE = 'OT008';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER training_module_context BEFORE INSERT OR UPDATE ON training_module
  FOR EACH ROW EXECUTE FUNCTION require_action_context();
CREATE TRIGGER training_module_guard BEFORE UPDATE ON training_module
  FOR EACH ROW EXECUTE FUNCTION training_module_before_update();
CREATE TRIGGER training_module_no_delete BEFORE DELETE ON training_module
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER training_module_audit AFTER INSERT OR UPDATE ON training_module
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('code');

-- ---------------------------------------------------------------------------
-- Relaxation requests: the only way a requirement is removed
-- ---------------------------------------------------------------------------

CREATE TABLE worker_requirement_relaxation (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id         uuid NOT NULL REFERENCES service (id),
  requirement_kind   text NOT NULL CHECK (requirement_kind IN ('VERIFICATION', 'TRAINING')),
  verification_type  text CHECK (verification_type IN ('IDENTITY', 'ADDRESS', 'POLICE', 'REFERENCE',
                                                       'FITNESS', 'SKILL_ASSESSMENT', 'CONTRACT',
                                                       'PHOTO', 'BANK_ACCOUNT')),
  module_code        text REFERENCES training_module (code),
  reason             text NOT NULL CHECK (length(btrim(reason)) BETWEEN 5 AND 500),
  status             text NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING', 'APPLIED', 'REJECTED', 'WITHDRAWN')),
  requested_by       uuid NOT NULL REFERENCES app_user (id),
  requested_at       timestamptz NOT NULL DEFAULT now(),
  decided_by         uuid REFERENCES app_user (id),
  decided_at         timestamptz,
  decision_note      text CHECK (decision_note IS NULL OR length(btrim(decision_note)) BETWEEN 5 AND 500),
  -- The transaction that removed the requirement; lets the removal prove its approval.
  applied_txid       bigint,
  CHECK ((requirement_kind = 'VERIFICATION') = (verification_type IS NOT NULL)),
  CHECK ((requirement_kind = 'TRAINING') = (module_code IS NOT NULL)),
  -- Four eyes: nobody approves or rejects their own request.
  CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CHECK ((status = 'PENDING') = (decided_at IS NULL)),
  CHECK (status NOT IN ('APPLIED', 'REJECTED') OR decided_by IS NOT NULL),
  CHECK (status <> 'REJECTED' OR decision_note IS NOT NULL),
  CHECK ((status = 'APPLIED') = (applied_txid IS NOT NULL))
);

-- At most one open request per requirement.
CREATE UNIQUE INDEX worker_requirement_relaxation_pending_uq
  ON worker_requirement_relaxation (service_id, requirement_kind,
                                    COALESCE(verification_type, module_code))
  WHERE status = 'PENDING';
CREATE INDEX worker_requirement_relaxation_service_idx
  ON worker_requirement_relaxation (service_id, requested_at DESC);

CREATE FUNCTION worker_requirement_relaxation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING' OR NEW.decided_by IS NOT NULL OR NEW.applied_txid IS NOT NULL THEN
      RAISE EXCEPTION 'A requirement relaxation starts as PENDING' USING ERRCODE = 'OT002';
    END IF;
    IF NEW.requested_by IS DISTINCT FROM app_actor_user_id() THEN
      RAISE EXCEPTION 'A relaxation is requested by the acting staff member' USING ERRCODE = 'OT008';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.service_id, NEW.requirement_kind, NEW.verification_type, NEW.module_code, NEW.reason,
      NEW.requested_by, NEW.requested_at)
     IS DISTINCT FROM
     (OLD.service_id, OLD.requirement_kind, OLD.verification_type, OLD.module_code, OLD.reason,
      OLD.requested_by, OLD.requested_at) THEN
    RAISE EXCEPTION 'A requirement relaxation cannot be edited' USING ERRCODE = 'OT003';
  END IF;
  IF OLD.status <> 'PENDING' OR NEW.status = 'PENDING' THEN
    RAISE EXCEPTION 'Requirement relaxation % is already %', OLD.id, OLD.status
      USING ERRCODE = 'OT002';
  END IF;
  IF NEW.status IN ('APPLIED', 'REJECTED') AND NEW.decided_by IS DISTINCT FROM app_actor_user_id() THEN
    RAISE EXCEPTION 'A relaxation is decided by the acting staff member' USING ERRCODE = 'OT008';
  END IF;
  IF NEW.status = 'APPLIED' AND NEW.applied_txid IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION 'A relaxation is applied in the transaction that approves it'
      USING ERRCODE = 'OT008';
  END IF;
  IF NEW.status = 'WITHDRAWN' AND OLD.requested_by IS DISTINCT FROM app_actor_user_id() THEN
    RAISE EXCEPTION 'Only the requester can withdraw a relaxation' USING ERRCODE = 'OT008';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER worker_requirement_relaxation_context BEFORE INSERT OR UPDATE
  ON worker_requirement_relaxation FOR EACH ROW EXECUTE FUNCTION require_action_context();
CREATE TRIGGER worker_requirement_relaxation_guard BEFORE INSERT OR UPDATE
  ON worker_requirement_relaxation FOR EACH ROW EXECUTE FUNCTION worker_requirement_relaxation_guard();
CREATE TRIGGER worker_requirement_relaxation_no_delete BEFORE DELETE
  ON worker_requirement_relaxation FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER worker_requirement_relaxation_no_truncate BEFORE TRUNCATE
  ON worker_requirement_relaxation FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();
CREATE TRIGGER worker_requirement_relaxation_audit AFTER INSERT OR UPDATE
  ON worker_requirement_relaxation FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');

-- ---------------------------------------------------------------------------
-- Requirements: added freely (audited), never edited, removed only by an approved relaxation
-- ---------------------------------------------------------------------------

CREATE FUNCTION requirement_no_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows cannot be edited; remove and add instead', TG_TABLE_NAME
    USING ERRCODE = 'OT003';
END;
$$;

CREATE FUNCTION service_verification_requirement_before_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM worker_requirement_relaxation r
    WHERE r.status = 'APPLIED' AND r.applied_txid = txid_current()
      AND r.service_id = OLD.service_id
      AND r.requirement_kind = 'VERIFICATION' AND r.verification_type = OLD.verification_type
  ) THEN
    RAISE EXCEPTION 'Removing a verification requirement needs an approved relaxation'
      USING ERRCODE = 'OT008';
  END IF;
  RETURN OLD;
END;
$$;

CREATE FUNCTION service_training_requirement_before_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM worker_requirement_relaxation r
    WHERE r.status = 'APPLIED' AND r.applied_txid = txid_current()
      AND r.service_id = OLD.service_id
      AND r.requirement_kind = 'TRAINING' AND r.module_code = OLD.module_code
  ) THEN
    RAISE EXCEPTION 'Removing a training requirement needs an approved relaxation'
      USING ERRCODE = 'OT008';
  END IF;
  RETURN OLD;
END;
$$;

CREATE FUNCTION service_training_requirement_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM training_module m WHERE m.code = NEW.module_code AND m.is_active) THEN
    RAISE EXCEPTION 'Training module % is not active', NEW.module_code USING ERRCODE = 'OT008';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER service_verification_requirement_context
  BEFORE INSERT OR UPDATE OR DELETE ON service_verification_requirement
  FOR EACH ROW EXECUTE FUNCTION require_action_context();
CREATE TRIGGER service_verification_requirement_no_update
  BEFORE UPDATE ON service_verification_requirement
  FOR EACH ROW EXECUTE FUNCTION requirement_no_update();
CREATE TRIGGER service_verification_requirement_delete_guard
  BEFORE DELETE ON service_verification_requirement
  FOR EACH ROW EXECUTE FUNCTION service_verification_requirement_before_delete();
CREATE TRIGGER service_verification_requirement_no_truncate
  BEFORE TRUNCATE ON service_verification_requirement
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();
CREATE TRIGGER service_verification_requirement_audit
  AFTER INSERT OR UPDATE OR DELETE ON service_verification_requirement
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('service_id');

CREATE TRIGGER service_training_requirement_context
  BEFORE INSERT OR UPDATE OR DELETE ON service_training_requirement
  FOR EACH ROW EXECUTE FUNCTION require_action_context();
CREATE TRIGGER service_training_requirement_active_module
  BEFORE INSERT ON service_training_requirement
  FOR EACH ROW EXECUTE FUNCTION service_training_requirement_before_insert();
CREATE TRIGGER service_training_requirement_no_update
  BEFORE UPDATE ON service_training_requirement
  FOR EACH ROW EXECUTE FUNCTION requirement_no_update();
CREATE TRIGGER service_training_requirement_delete_guard
  BEFORE DELETE ON service_training_requirement
  FOR EACH ROW EXECUTE FUNCTION service_training_requirement_before_delete();
CREATE TRIGGER service_training_requirement_no_truncate
  BEFORE TRUNCATE ON service_training_requirement
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();
CREATE TRIGGER service_training_requirement_audit
  AFTER INSERT OR UPDATE OR DELETE ON service_training_requirement
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('service_id');
