-- 0020 Restricted document lifecycle (worker identity and verification documents).
--
-- Files live in private object storage and are never reachable by a public URL. This table
-- is the authority on each file: who owns it, what it really is (detected from its bytes,
-- not the name or declared type), whether malware scanning passed, how long it is kept,
-- and when it was deleted. Staff can open a document only once it is CLEAN, and every
-- opening is audited.

CREATE TABLE stored_document (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id          uuid NOT NULL REFERENCES app_user (id),
  purpose                text NOT NULL CHECK (purpose IN ('WORKER_VERIFICATION')),
  object_key             text NOT NULL UNIQUE CHECK (object_key ~ '^[a-z0-9][a-z0-9/_-]{8,200}$'),
  declared_content_type  text NOT NULL CHECK (declared_content_type IN ('image/jpeg', 'image/png', 'application/pdf')),
  detected_content_type  text,
  size_bytes             bigint CHECK (size_bytes > 0),
  sha256                 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  status                 text NOT NULL DEFAULT 'AWAITING_UPLOAD'
                         CHECK (status IN ('AWAITING_UPLOAD', 'PENDING_SCAN', 'CLEAN', 'REJECTED', 'DELETED')),
  rejection_reason       text CHECK (rejection_reason IN ('NOT_UPLOADED', 'EMPTY', 'TOO_LARGE',
                                                          'TYPE_MISMATCH', 'MALWARE')),
  scan_engine            text,
  scan_signature         text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  upload_confirmed_at    timestamptz,
  scanned_at             timestamptz,
  -- Set when the document is no longer needed (e.g. worker offboarded + retention period).
  retain_until           timestamptz,
  deleted_at             timestamptz,
  deleted_reason         text,
  CHECK (status <> 'REJECTED' OR rejection_reason IS NOT NULL),
  CHECK (status <> 'DELETED' OR deleted_at IS NOT NULL),
  CHECK (status NOT IN ('PENDING_SCAN', 'CLEAN') OR (sha256 IS NOT NULL AND size_bytes IS NOT NULL))
);

CREATE INDEX stored_document_owner_idx ON stored_document (owner_user_id, created_at);
CREATE INDEX stored_document_work_idx ON stored_document (status, created_at)
  WHERE status IN ('AWAITING_UPLOAD', 'PENDING_SCAN');
CREATE INDEX stored_document_retention_idx ON stored_document (retain_until)
  WHERE retain_until IS NOT NULL AND status <> 'DELETED';

-- A document's identity never changes once recorded.
CREATE FUNCTION stored_document_before_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.owner_user_id, NEW.purpose, NEW.object_key, NEW.declared_content_type)
     IS DISTINCT FROM (OLD.owner_user_id, OLD.purpose, OLD.object_key, OLD.declared_content_type) THEN
    RAISE EXCEPTION 'Document identity is fixed' USING ERRCODE = 'OT003';
  END IF;
  IF OLD.sha256 IS NOT NULL AND NEW.sha256 IS DISTINCT FROM OLD.sha256 THEN
    RAISE EXCEPTION 'Document content hash is fixed' USING ERRCODE = 'OT003';
  END IF;
  IF OLD.status = 'DELETED' THEN
    RAISE EXCEPTION 'A deleted document cannot change' USING ERRCODE = 'OT003';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER stored_document_before_update BEFORE UPDATE ON stored_document
  FOR EACH ROW EXECUTE FUNCTION stored_document_before_update();
CREATE TRIGGER stored_document_no_delete BEFORE DELETE ON stored_document
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER stored_document_no_truncate BEFORE TRUNCATE ON stored_document
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();
CREATE TRIGGER stored_document_audit AFTER INSERT OR UPDATE ON stored_document
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'object_key');

ALTER TABLE worker_verification ADD COLUMN document_id uuid REFERENCES stored_document (id);
