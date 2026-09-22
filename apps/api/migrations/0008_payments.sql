-- 0008 Payments, gateway events, refunds, invoices, worker earnings and payouts.
--
--   * Gateway events are stored once per provider event id (webhook retries are no-ops).
--   * A booking can have at most one captured payment (no double charge).
--   * Refunds can never exceed what was captured, and need a second person to approve.
--   * Worker payouts need a second person to approve.

CREATE TABLE payment (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id           uuid NOT NULL REFERENCES booking (id),
  provider             text NOT NULL CHECK (provider IN ('RAZORPAY', 'CASHFREE', 'CASH', 'TEST')),
  provider_order_id    text,
  provider_payment_id  text,
  amount_paise         bigint NOT NULL CHECK (amount_paise > 0),
  currency             char(3) NOT NULL DEFAULT 'INR',
  status               text NOT NULL DEFAULT 'CREATED'
                       CHECK (status IN ('CREATED', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELLED')),
  method               text,
  failure_reason       text,
  -- Cash receipts are numbered; collected_by is the staff/worker who took the cash.
  cash_receipt_number  text UNIQUE,
  collected_by         uuid REFERENCES app_user (id),
  idempotency_key      text NOT NULL UNIQUE,
  created_at           timestamptz NOT NULL DEFAULT now(),
  captured_at          timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_order_id),
  UNIQUE (provider, provider_payment_id),
  CHECK (status <> 'CAPTURED' OR captured_at IS NOT NULL),
  CHECK (provider <> 'CASH' OR (cash_receipt_number IS NOT NULL AND collected_by IS NOT NULL))
);

CREATE UNIQUE INDEX payment_one_captured_per_booking_uq ON payment (booking_id)
  WHERE status = 'CAPTURED';
CREATE INDEX payment_booking_idx ON payment (booking_id);

CREATE FUNCTION payment_before_update() RETURNS trigger
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
       (OLD.status = 'FAILED'     AND NEW.status = 'CAPTURED')) THEN
    -- FAILED → CAPTURED happens when a gateway reports success after an earlier failure.
    RAISE EXCEPTION 'Payment cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'OT008';
  END IF;
  RETURN NEW;
END;
$$;

-- Raw gateway notifications, verified and de-duplicated.
CREATE TABLE payment_event (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider            text NOT NULL,
  provider_event_id   text NOT NULL,
  event_type          text NOT NULL,
  signature_verified  boolean NOT NULL,
  payment_id          uuid REFERENCES payment (id),
  payload             jsonb NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now(),
  processed_at        timestamptz,
  processing_error    text,
  UNIQUE (provider, provider_event_id)
);

CREATE FUNCTION payment_event_before_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.provider, NEW.provider_event_id, NEW.event_type, NEW.signature_verified,
      NEW.payload, NEW.received_at)
     IS DISTINCT FROM
     (OLD.provider, OLD.provider_event_id, OLD.event_type, OLD.signature_verified,
      OLD.payload, OLD.received_at) THEN
    RAISE EXCEPTION 'Gateway events are immutable; only processing fields may change'
      USING ERRCODE = 'OT001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE refund (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id          uuid NOT NULL REFERENCES booking (id),
  payment_id          uuid NOT NULL REFERENCES payment (id),
  amount_paise        bigint NOT NULL CHECK (amount_paise > 0),
  reason_code         text NOT NULL
                      CHECK (reason_code IN ('CUSTOMER_CANCELLED', 'COMPANY_CANCELLED',
                                             'NO_WORKER_AVAILABLE', 'WORKER_NO_SHOW',
                                             'SERVICE_ISSUE', 'DUPLICATE_PAYMENT', 'GOODWILL',
                                             'OTHER')),
  reason_text         text NOT NULL,
  status              text NOT NULL DEFAULT 'REQUESTED'
                      CHECK (status IN ('REQUESTED', 'APPROVED', 'REJECTED', 'PROCESSING',
                                        'PROCESSED', 'FAILED')),
  requested_by        uuid REFERENCES app_user (id),
  requested_source    action_source NOT NULL,
  decided_by          uuid REFERENCES app_user (id),
  decided_at          timestamptz,
  decision_note       text,
  provider_refund_id  text UNIQUE,
  idempotency_key     text NOT NULL UNIQUE,
  processed_at        timestamptz,
  failure_reason      text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- Separation of duties: nobody approves their own refund request.
  CHECK (decided_by IS NULL OR requested_by IS NULL OR decided_by <> requested_by),
  CHECK (status NOT IN ('APPROVED', 'REJECTED', 'PROCESSING', 'PROCESSED', 'FAILED')
         OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (status <> 'REJECTED' OR decision_note IS NOT NULL)
);

CREATE INDEX refund_booking_idx ON refund (booking_id);
CREATE INDEX refund_status_idx ON refund (status) WHERE status IN ('REQUESTED', 'APPROVED', 'PROCESSING');

CREATE FUNCTION refund_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_payment  payment%ROWTYPE;
  v_refunded bigint;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.booking_id, NEW.payment_id, NEW.amount_paise, NEW.requested_by, NEW.idempotency_key)
       IS DISTINCT FROM
       (OLD.booking_id, OLD.payment_id, OLD.amount_paise, OLD.requested_by, OLD.idempotency_key) THEN
      RAISE EXCEPTION 'Refund amount and request details are fixed' USING ERRCODE = 'OT003';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
         (OLD.status = 'REQUESTED'  AND NEW.status IN ('APPROVED', 'REJECTED')) OR
         (OLD.status = 'APPROVED'   AND NEW.status = 'PROCESSING') OR
         (OLD.status = 'PROCESSING' AND NEW.status IN ('PROCESSED', 'FAILED')) OR
         (OLD.status = 'FAILED'     AND NEW.status = 'PROCESSING')) THEN
      RAISE EXCEPTION 'Refund cannot move from % to %', OLD.status, NEW.status
        USING ERRCODE = 'OT008';
    END IF;
    RETURN NEW;
  END IF;

  -- Lock the payment so concurrent refund requests are checked one at a time.
  SELECT * INTO v_payment FROM payment WHERE id = NEW.payment_id FOR UPDATE;
  IF v_payment.booking_id <> NEW.booking_id THEN
    RAISE EXCEPTION 'Refund booking does not match the payment''s booking' USING ERRCODE = 'OT008';
  END IF;
  IF v_payment.status <> 'CAPTURED' THEN
    RAISE EXCEPTION 'Only captured payments can be refunded' USING ERRCODE = 'OT007';
  END IF;

  SELECT COALESCE(sum(amount_paise), 0) INTO v_refunded
  FROM refund WHERE payment_id = NEW.payment_id AND status NOT IN ('REJECTED');

  IF v_refunded + NEW.amount_paise > v_payment.amount_paise THEN
    RAISE EXCEPTION 'Refunds (% + %) would exceed the captured amount %',
      v_refunded, NEW.amount_paise, v_payment.amount_paise USING ERRCODE = 'OT007';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Invoices
-- ---------------------------------------------------------------------------

CREATE TABLE invoice_sequence (
  series      text PRIMARY KEY CHECK (series ~ '^[A-Z0-9/-]{2,20}$'),
  next_value  bigint NOT NULL DEFAULT 1 CHECK (next_value > 0)
);

CREATE TABLE invoice (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number       text NOT NULL UNIQUE,
  booking_id           uuid NOT NULL UNIQUE REFERENCES booking (id),
  issuer_legal_name    text NOT NULL,
  issuer_gstin         text,
  issuer_address       text NOT NULL,
  customer_name        text NOT NULL,
  customer_address     text NOT NULL,
  subtotal_paise       bigint NOT NULL CHECK (subtotal_paise >= 0),
  discount_paise       bigint NOT NULL CHECK (discount_paise >= 0),
  tax_paise            bigint NOT NULL CHECK (tax_paise >= 0),
  total_paise          bigint NOT NULL CHECK (total_paise >= 0),
  lines                jsonb NOT NULL,
  document_object_key  text,
  issued_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (total_paise = subtotal_paise - discount_paise + tax_paise)
);

CREATE TABLE credit_note (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_note_number  text NOT NULL UNIQUE,
  invoice_id          uuid NOT NULL REFERENCES invoice (id),
  refund_id           uuid UNIQUE REFERENCES refund (id),
  amount_paise        bigint NOT NULL CHECK (amount_paise > 0),
  reason              text NOT NULL,
  issued_at           timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Worker earnings and payouts
-- ---------------------------------------------------------------------------

CREATE TABLE worker_payout (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id       uuid NOT NULL REFERENCES worker_profile (user_id),
  period_start    date NOT NULL,
  period_end      date NOT NULL,
  total_paise     bigint NOT NULL CHECK (total_paise >= 0),
  status          text NOT NULL DEFAULT 'DRAFT'
                  CHECK (status IN ('DRAFT', 'APPROVED', 'PAID', 'FAILED', 'CANCELLED')),
  prepared_by     uuid NOT NULL REFERENCES app_user (id),
  approved_by     uuid REFERENCES app_user (id),
  approved_at     timestamptz,
  paid_at         timestamptz,
  bank_reference  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start),
  CHECK (approved_by IS NULL OR approved_by <> prepared_by),
  CHECK (approved_by IS NULL OR approved_by <> worker_id),
  CHECK (status NOT IN ('APPROVED', 'PAID') OR approved_by IS NOT NULL),
  CHECK (status <> 'PAID' OR (paid_at IS NOT NULL AND bank_reference IS NOT NULL))
);

CREATE TABLE worker_earning (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id       uuid NOT NULL REFERENCES worker_profile (user_id),
  booking_id      uuid REFERENCES booking (id),
  earning_type    text NOT NULL
                  CHECK (earning_type IN ('JOB', 'TRAVEL', 'WAITING', 'CANCELLATION',
                                          'INCENTIVE', 'ADJUSTMENT')),
  amount_paise    bigint NOT NULL,
  payout_rule_id  uuid REFERENCES payout_rule (id),
  description     text NOT NULL,
  status          text NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'APPROVED', 'ON_HOLD', 'PAID', 'VOID')),
  hold_reason     text,
  payout_id       uuid REFERENCES worker_payout (id),
  created_by      uuid REFERENCES app_user (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- Only adjustments may be negative, and they must say why.
  CHECK (amount_paise >= 0 OR earning_type = 'ADJUSTMENT'),
  CHECK (status <> 'ON_HOLD' OR hold_reason IS NOT NULL),
  CHECK (earning_type IN ('INCENTIVE', 'ADJUSTMENT') OR booking_id IS NOT NULL)
);

CREATE UNIQUE INDEX worker_earning_booking_type_uq
  ON worker_earning (booking_id, worker_id, earning_type)
  WHERE earning_type IN ('JOB', 'TRAVEL', 'CANCELLATION') AND status <> 'VOID';
CREATE INDEX worker_earning_worker_idx ON worker_earning (worker_id, status);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER payment_updated_at BEFORE UPDATE ON payment FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER refund_updated_at BEFORE UPDATE ON refund FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER worker_payout_updated_at BEFORE UPDATE ON worker_payout FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER worker_earning_updated_at BEFORE UPDATE ON worker_earning FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER payment_context BEFORE INSERT OR UPDATE ON payment FOR EACH ROW EXECUTE FUNCTION require_action_context();
CREATE TRIGGER refund_context BEFORE INSERT OR UPDATE ON refund FOR EACH ROW EXECUTE FUNCTION require_action_context();
CREATE TRIGGER worker_payout_context BEFORE INSERT OR UPDATE ON worker_payout FOR EACH ROW EXECUTE FUNCTION require_action_context();
CREATE TRIGGER worker_earning_context BEFORE INSERT OR UPDATE ON worker_earning FOR EACH ROW EXECUTE FUNCTION require_action_context();

CREATE TRIGGER payment_before_update BEFORE UPDATE ON payment FOR EACH ROW EXECUTE FUNCTION payment_before_update();
CREATE TRIGGER payment_event_before_update BEFORE UPDATE ON payment_event FOR EACH ROW EXECUTE FUNCTION payment_event_before_update();
CREATE TRIGGER refund_guard BEFORE INSERT OR UPDATE ON refund FOR EACH ROW EXECUTE FUNCTION refund_guard();

CREATE TRIGGER payment_no_delete BEFORE DELETE ON payment FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER payment_event_no_delete BEFORE DELETE ON payment_event FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER refund_no_delete BEFORE DELETE ON refund FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER invoice_append_only BEFORE UPDATE OR DELETE ON invoice FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER credit_note_append_only BEFORE UPDATE OR DELETE ON credit_note FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER worker_payout_no_delete BEFORE DELETE ON worker_payout FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER worker_earning_no_delete BEFORE DELETE ON worker_earning FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TRIGGER payment_audit AFTER INSERT OR UPDATE ON payment FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
CREATE TRIGGER refund_audit AFTER INSERT OR UPDATE ON refund FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
CREATE TRIGGER invoice_audit AFTER INSERT ON invoice FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
CREATE TRIGGER credit_note_audit AFTER INSERT ON credit_note FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
CREATE TRIGGER worker_payout_audit AFTER INSERT OR UPDATE ON worker_payout FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
CREATE TRIGGER worker_earning_audit AFTER INSERT OR UPDATE ON worker_earning FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
