-- 0016 Authorized-but-not-captured payments.
--
-- A gateway payment can be authorized (money held) before it is captured (money taken).
-- One Tappe captures authorized payments itself (reconciliation job) rather than relying
-- only on the gateway's automatic-capture setting. A new attempt inside the same checkout
-- can be authorized after an earlier attempt failed, hence FAILED -> AUTHORIZED.

ALTER TABLE payment ADD COLUMN authorized_at timestamptz;

CREATE OR REPLACE FUNCTION payment_before_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.booking_id, NEW.provider, NEW.amount_paise, NEW.currency, NEW.idempotency_key)
     IS DISTINCT FROM
     (OLD.booking_id, OLD.provider, OLD.amount_paise, OLD.currency, OLD.idempotency_key) THEN
    RAISE EXCEPTION 'Payment amount and ownership are fixed' USING ERRCODE = 'OT003';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'CREATED'    AND NEW.status IN ('AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELLED')) OR
       (OLD.status = 'AUTHORIZED' AND NEW.status IN ('CAPTURED', 'FAILED', 'CANCELLED')) OR
       (OLD.status = 'FAILED'     AND NEW.status IN ('AUTHORIZED', 'CAPTURED'))) THEN
    -- FAILED -> AUTHORIZED/CAPTURED: a later attempt in the same checkout succeeded.
    RAISE EXCEPTION 'Payment cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'OT008';
  END IF;
  RETURN NEW;
END;
$$;

CREATE INDEX payment_open_idx ON payment (status, created_at)
  WHERE status IN ('CREATED', 'AUTHORIZED', 'FAILED');
