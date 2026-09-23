-- 0024 Legal documents and consent.
--
-- A published legal document (terms, privacy notice, cancellation policy) is a fact:
-- people accepted exactly that version, identified by its content hash. It never changes
-- or disappears; a change is a new version. Consents are granted once per document or
-- purpose and can be withdrawn (forward-only), never edited or deleted.

CREATE TRIGGER legal_document_context BEFORE INSERT OR UPDATE ON legal_document
  FOR EACH ROW EXECUTE FUNCTION require_action_context();
CREATE TRIGGER legal_document_immutable BEFORE UPDATE ON legal_document
  FOR EACH ROW EXECUTE FUNCTION forbid_rule_rewrite();
CREATE TRIGGER legal_document_no_delete BEFORE DELETE ON legal_document
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER legal_document_audit AFTER INSERT ON legal_document
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');

-- Only withdrawal may change a consent, once.
CREATE TRIGGER consent_record_immutable BEFORE UPDATE ON consent_record
  FOR EACH ROW EXECUTE FUNCTION forbid_rule_rewrite('withdrawn_at');
CREATE TRIGGER consent_record_withdraw BEFORE UPDATE ON consent_record
  FOR EACH ROW EXECUTE FUNCTION forbid_retroactive_end('withdrawn_at');

-- One active consent per person, purpose and document version (accepting twice is a no-op).
CREATE UNIQUE INDEX consent_record_active_uq ON consent_record
  (user_id, purpose, COALESCE(legal_document_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE withdrawn_at IS NULL;

CREATE INDEX legal_document_current_idx ON legal_document (code, locale, effective_from DESC);
