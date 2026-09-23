-- 0015 Idempotent creation for support cases, safety incidents and saved addresses.
--
-- Mobile networks retry. A request carrying the same Idempotency-Key as an earlier one
-- from the same person returns the record the first request created instead of creating
-- a second (a duplicate support case would also become a duplicate Zoho Desk ticket).
-- The key is claimed by a unique constraint in the same transaction that creates the
-- record, so a crash can never leave the key claimed without the record, or vice versa.
-- request_hash detects the same key reused for a different request.

ALTER TABLE support_case
  ADD COLUMN idempotency_key  text CHECK (length(idempotency_key) BETWEEN 8 AND 100),
  ADD COLUMN request_hash     text,
  ADD CONSTRAINT support_case_idempotency_uq UNIQUE (raised_by_user_id, idempotency_key),
  ADD CONSTRAINT support_case_idempotency_hash_ck
    CHECK ((idempotency_key IS NULL) = (request_hash IS NULL));

ALTER TABLE safety_incident
  ADD COLUMN idempotency_key  text CHECK (length(idempotency_key) BETWEEN 8 AND 100),
  ADD COLUMN request_hash     text,
  ADD CONSTRAINT safety_incident_idempotency_uq UNIQUE (reported_by_user_id, idempotency_key),
  ADD CONSTRAINT safety_incident_idempotency_hash_ck
    CHECK ((idempotency_key IS NULL) = (request_hash IS NULL));

ALTER TABLE address
  ADD COLUMN idempotency_key  text CHECK (length(idempotency_key) BETWEEN 8 AND 100),
  ADD COLUMN request_hash     text,
  ADD CONSTRAINT address_idempotency_uq UNIQUE (user_id, idempotency_key),
  ADD CONSTRAINT address_idempotency_hash_ck
    CHECK ((idempotency_key IS NULL) = (request_hash IS NULL));
