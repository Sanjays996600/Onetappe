-- 0007 Bookings, status history, schedule history, worker reservations and assignments.
--
-- Guarantees enforced here, independent of any application code:
--   * A booking's status only changes along booking_status_transition, by an allowed
--     source, with a reason where required. Every change is written to
--     booking_status_history automatically.
--   * The originally promised time can never change; every reschedule is recorded in
--     booking_schedule_change.
--   * A worker can never hold two overlapping active reservations (exclusion constraint).
--   * A worker can only be reserved when eligible and inside a planned shift.
--   * Cancelling, expiring or holding a booking releases its reservations.
--   * History tables are append-only; bookings cannot be deleted.

-- ---------------------------------------------------------------------------
-- Allowed transitions (mirrors @onetappe/domain BOOKING_TRANSITIONS; a test keeps
-- the two identical).
-- ---------------------------------------------------------------------------

CREATE TABLE booking_status_transition (
  from_status      text NOT NULL,
  event            text NOT NULL,
  to_status        text NOT NULL,
  sources          text[] NOT NULL CHECK (cardinality(sources) > 0),
  requires_reason  boolean NOT NULL,
  PRIMARY KEY (from_status, event)
);

INSERT INTO booking_status_transition (from_status, event, to_status, sources, requires_reason) VALUES
  ('PENDING_PAYMENT', 'PAYMENT_CAPTURED',           'CONFIRMED',   '{PAYMENT_GATEWAY,SYSTEM}',           false),
  ('PENDING_PAYMENT', 'CONFIRM_WITHOUT_PREPAYMENT', 'CONFIRMED',   '{ADMIN}',                            true),
  ('PENDING_PAYMENT', 'HOLD_EXPIRED',               'EXPIRED',     '{SYSTEM}',                           false),
  ('PENDING_PAYMENT', 'CANCEL',                     'CANCELLED',   '{CUSTOMER_APP,ADMIN,SYSTEM}',        true),
  ('CONFIRMED',       'PLACE_ON_HOLD',              'ON_HOLD',     '{ADMIN}',                            true),
  ('ON_HOLD',         'RELEASE_HOLD',               'CONFIRMED',   '{ADMIN}',                            true),
  ('ON_HOLD',         'CANCEL',                     'CANCELLED',   '{ADMIN,CUSTOMER_APP}',               true),
  ('CONFIRMED',       'WORKER_ACCEPTED',            'ASSIGNED',    '{WORKER_APP,ADMIN}',                 false),
  ('CONFIRMED',       'CANCEL',                     'CANCELLED',   '{CUSTOMER_APP,ADMIN,SYSTEM}',        true),
  ('ASSIGNED',        'WORKER_UNASSIGNED',          'CONFIRMED',   '{WORKER_APP,ADMIN,SYSTEM}',          true),
  ('ASSIGNED',        'CANCEL',                     'CANCELLED',   '{CUSTOMER_APP,ADMIN}',               true),
  ('ASSIGNED',        'START_TRAVEL',               'EN_ROUTE',    '{WORKER_APP,ADMIN}',                 false),
  ('EN_ROUTE',        'WORKER_UNASSIGNED',          'CONFIRMED',   '{ADMIN,SYSTEM}',                     true),
  ('EN_ROUTE',        'MARK_ARRIVED',               'ARRIVED',     '{WORKER_APP,ADMIN}',                 false),
  ('EN_ROUTE',        'CANCEL',                     'CANCELLED',   '{CUSTOMER_APP,ADMIN}',               true),
  ('ARRIVED',         'START_SERVICE',              'IN_PROGRESS', '{WORKER_APP,ADMIN}',                 false),
  ('ARRIVED',         'CUSTOMER_NO_SHOW',           'NO_SHOW',     '{WORKER_APP,ADMIN}',                 true),
  ('ARRIVED',         'CANCEL',                     'CANCELLED',   '{ADMIN}',                            true),
  ('IN_PROGRESS',     'COMPLETE_SERVICE',           'COMPLETED',   '{WORKER_APP,ADMIN}',                 false),
  ('IN_PROGRESS',     'CANCEL',                     'CANCELLED',   '{ADMIN}',                            true),
  ('COMPLETED',       'CLOSE',                      'CLOSED',      '{SYSTEM,ADMIN}',                     false),
  ('NO_SHOW',         'CLOSE',                      'CLOSED',      '{SYSTEM,ADMIN}',                     false);

CREATE TRIGGER booking_status_transition_append_only
  BEFORE UPDATE OR DELETE ON booking_status_transition
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

-- ---------------------------------------------------------------------------
-- Booking
-- ---------------------------------------------------------------------------

CREATE SEQUENCE booking_code_seq;

CREATE TABLE booking (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_code              text NOT NULL UNIQUE
                            DEFAULT ('OT' || lpad(nextval('booking_code_seq')::text, 8, '0')),
  customer_user_id          uuid NOT NULL REFERENCES app_user (id),
  source                    text NOT NULL CHECK (source IN ('CUSTOMER_APP', 'ADMIN')),
  created_by_user_id        uuid NOT NULL REFERENCES app_user (id),
  service_id                uuid NOT NULL REFERENCES service (id),
  service_option_id         uuid,
  city_id                   uuid NOT NULL REFERENCES city (id),
  zone_id                   uuid NOT NULL REFERENCES zone (id),
  locality_id               uuid NOT NULL REFERENCES locality (id),
  address_id                uuid NOT NULL REFERENCES address (id),
  -- Copy of the address at booking time (what the worker is sent to).
  address_snapshot          jsonb NOT NULL,
  booking_type              text NOT NULL CHECK (booking_type IN ('INSTANT', 'SCHEDULED')),
  status                    text NOT NULL DEFAULT 'PENDING_PAYMENT'
                            CHECK (status IN ('PENDING_PAYMENT', 'CONFIRMED', 'ON_HOLD', 'ASSIGNED',
                                              'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED',
                                              'CLOSED', 'CANCELLED', 'EXPIRED', 'NO_SHOW')),
  -- The first promise made to the customer. Immutable.
  original_start            timestamptz NOT NULL,
  original_end              timestamptz NOT NULL,
  -- The current promise. Changes are recorded in booking_schedule_change.
  scheduled_start           timestamptz NOT NULL,
  scheduled_end             timestamptz NOT NULL,
  reschedule_count          int NOT NULL DEFAULT 0 CHECK (reschedule_count >= 0),
  payment_mode              text NOT NULL DEFAULT 'PREPAID'
                            CHECK (payment_mode IN ('PREPAID', 'PAY_AFTER_SERVICE')),
  currency                  char(3) NOT NULL DEFAULT 'INR',
  subtotal_paise            bigint NOT NULL CHECK (subtotal_paise >= 0),
  discount_paise            bigint NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  tax_paise                 bigint NOT NULL DEFAULT 0 CHECK (tax_paise >= 0),
  total_paise               bigint NOT NULL CHECK (total_paise >= 0),
  price_rule_id             uuid NOT NULL REFERENCES price_rule (id),
  promotion_id              uuid REFERENCES promotion (id),
  -- Capacity is held until this time while waiting for payment.
  payment_due_by            timestamptz,
  customer_notes            text CHECK (length(customer_notes) <= 1000),
  idempotency_key           text CHECK (length(idempotency_key) BETWEEN 8 AND 100),
  cancelled_at              timestamptz,
  cancellation_reason       text,
  completed_at              timestamptz,
  closed_at                 timestamptz,
  version                   int NOT NULL DEFAULT 1,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (service_id, service_option_id) REFERENCES service_option (service_id, id),
  UNIQUE (customer_user_id, idempotency_key),
  CHECK (original_end > original_start),
  CHECK (scheduled_end > scheduled_start),
  CHECK (total_paise = subtotal_paise - discount_paise + tax_paise),
  CHECK (discount_paise <= subtotal_paise),
  CHECK (status <> 'CANCELLED' OR (cancelled_at IS NOT NULL AND cancellation_reason IS NOT NULL)),
  CHECK (status <> 'PENDING_PAYMENT' OR payment_due_by IS NOT NULL)
);

CREATE INDEX booking_customer_idx ON booking (customer_user_id, created_at DESC);
CREATE INDEX booking_status_idx ON booking (status, scheduled_start);
CREATE INDEX booking_zone_schedule_idx ON booking (zone_id, scheduled_start);
CREATE INDEX booking_payment_due_idx ON booking (payment_due_by) WHERE status = 'PENDING_PAYMENT';

CREATE TABLE booking_status_history (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id     uuid NOT NULL REFERENCES booking (id),
  from_status    text,
  to_status      text NOT NULL,
  event          text NOT NULL,
  actor_user_id  uuid REFERENCES app_user (id),
  actor_role     text,
  source         action_source NOT NULL,
  reason         text,
  request_id     text,
  occurred_at    timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX booking_status_history_booking_idx ON booking_status_history (booking_id, id);

CREATE TABLE booking_schedule_change (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id      uuid NOT NULL REFERENCES booking (id),
  previous_start  timestamptz NOT NULL,
  previous_end    timestamptz NOT NULL,
  new_start       timestamptz NOT NULL,
  new_end         timestamptz NOT NULL,
  actor_user_id   uuid REFERENCES app_user (id),
  actor_role      text,
  source          action_source NOT NULL,
  reason          text NOT NULL,
  request_id      text,
  occurred_at     timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX booking_schedule_change_booking_idx ON booking_schedule_change (booking_id, id);

-- How the price was calculated, frozen at booking time.
CREATE TABLE booking_price_line (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id    uuid NOT NULL REFERENCES booking (id),
  line_no       smallint NOT NULL CHECK (line_no > 0),
  line_type     text NOT NULL CHECK (line_type IN ('BASE', 'CHARGE', 'DISCOUNT', 'TAX')),
  code          text NOT NULL,
  label         text NOT NULL,
  amount_paise  bigint NOT NULL,
  source_id     uuid,
  UNIQUE (booking_id, line_no),
  CHECK ((line_type = 'DISCOUNT') = (amount_paise < 0) OR amount_paise = 0)
);

-- Tasks chosen by the customer, in priority order, with the worker's outcome.
CREATE TABLE booking_task (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id       uuid NOT NULL REFERENCES booking (id),
  service_task_id  uuid NOT NULL REFERENCES service_task (id),
  name             text NOT NULL,
  priority         smallint NOT NULL CHECK (priority > 0),
  status           text NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING', 'DONE', 'NOT_DONE', 'DISPUTED')),
  note             text,
  updated_by       uuid REFERENCES app_user (id),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booking_id, service_task_id),
  UNIQUE (booking_id, priority)
);

-- Start/complete codes the customer reads out. Only hashes are stored.
CREATE TABLE booking_verification_code (
  booking_id    uuid NOT NULL REFERENCES booking (id),
  purpose       text NOT NULL CHECK (purpose IN ('START', 'COMPLETE')),
  code_hash     text NOT NULL,
  attempts      int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts  int NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  verified_at   timestamptz,
  PRIMARY KEY (booking_id, purpose)
);

CREATE TABLE booking_rating (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id        uuid NOT NULL REFERENCES booking (id),
  rated_by_user_id  uuid NOT NULL REFERENCES app_user (id),
  rater_role        text NOT NULL CHECK (rater_role IN ('CUSTOMER', 'WORKER')),
  score             smallint NOT NULL CHECK (score BETWEEN 1 AND 5),
  comment           text CHECK (length(comment) <= 2000),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booking_id, rater_role)
);

-- ---------------------------------------------------------------------------
-- Booking triggers
-- ---------------------------------------------------------------------------

CREATE FUNCTION booking_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'PENDING_PAYMENT' THEN
    RAISE EXCEPTION 'A booking must be created as PENDING_PAYMENT, not %', NEW.status
      USING ERRCODE = 'OT002';
  END IF;
  -- The first promise is by definition the current promise.
  NEW.original_start := NEW.scheduled_start;
  NEW.original_end := NEW.scheduled_end;
  NEW.version := 1;
  RETURN NEW;
END;
$$;

CREATE FUNCTION booking_before_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_rule booking_status_transition%ROWTYPE;
BEGIN
  IF NEW.original_start IS DISTINCT FROM OLD.original_start
     OR NEW.original_end IS DISTINCT FROM OLD.original_end THEN
    RAISE EXCEPTION 'The original promised time of booking % cannot be changed', OLD.booking_code
      USING ERRCODE = 'OT003';
  END IF;

  IF (NEW.id, NEW.booking_code, NEW.customer_user_id, NEW.source, NEW.created_by_user_id,
      NEW.service_id, NEW.service_option_id, NEW.city_id, NEW.zone_id, NEW.locality_id,
      NEW.address_id, NEW.address_snapshot, NEW.booking_type, NEW.currency,
      NEW.subtotal_paise, NEW.discount_paise, NEW.tax_paise, NEW.total_paise,
      NEW.price_rule_id, NEW.promotion_id, NEW.idempotency_key, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.booking_code, OLD.customer_user_id, OLD.source, OLD.created_by_user_id,
      OLD.service_id, OLD.service_option_id, OLD.city_id, OLD.zone_id, OLD.locality_id,
      OLD.address_id, OLD.address_snapshot, OLD.booking_type, OLD.currency,
      OLD.subtotal_paise, OLD.discount_paise, OLD.tax_paise, OLD.total_paise,
      OLD.price_rule_id, OLD.promotion_id, OLD.idempotency_key, OLD.created_at) THEN
    RAISE EXCEPTION 'Identity, service, address and price of booking % are fixed once created',
      OLD.booking_code USING ERRCODE = 'OT003';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    SELECT * INTO v_rule FROM booking_status_transition
    WHERE from_status = OLD.status AND event = app_event();

    IF NOT FOUND OR v_rule.to_status <> NEW.status THEN
      RAISE EXCEPTION 'Booking % cannot move from % to % via event %',
        OLD.booking_code, OLD.status, NEW.status, COALESCE(app_event(), '(none)')
        USING ERRCODE = 'OT002';
    END IF;
    IF NOT (app_source() = ANY (v_rule.sources)) THEN
      RAISE EXCEPTION 'Source % may not trigger % on booking %',
        COALESCE(app_source(), '(none)'), v_rule.event, OLD.booking_code
        USING ERRCODE = 'OT002';
    END IF;
    IF v_rule.requires_reason AND app_reason() IS NULL THEN
      RAISE EXCEPTION 'Event % on booking % requires a reason', v_rule.event, OLD.booking_code
        USING ERRCODE = 'OT002';
    END IF;

    IF NEW.status = 'CANCELLED' THEN
      NEW.cancelled_at := COALESCE(NEW.cancelled_at, now());
      NEW.cancellation_reason := COALESCE(NEW.cancellation_reason, app_reason());
    ELSIF NEW.status = 'COMPLETED' THEN
      NEW.completed_at := COALESCE(NEW.completed_at, now());
    ELSIF NEW.status = 'CLOSED' THEN
      NEW.closed_at := COALESCE(NEW.closed_at, now());
    END IF;
    IF OLD.status = 'PENDING_PAYMENT' THEN
      NEW.payment_due_by := NULL;
    END IF;
  END IF;

  IF (NEW.scheduled_start, NEW.scheduled_end)
     IS DISTINCT FROM (OLD.scheduled_start, OLD.scheduled_end) THEN
    IF OLD.status NOT IN ('PENDING_PAYMENT', 'CONFIRMED', 'ON_HOLD', 'ASSIGNED')
       OR NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'Booking % cannot be rescheduled in status %', OLD.booking_code, OLD.status
        USING ERRCODE = 'OT008';
    END IF;
    IF app_reason() IS NULL THEN
      RAISE EXCEPTION 'Rescheduling booking % requires a reason', OLD.booking_code
        USING ERRCODE = 'OT008';
    END IF;
    -- Capacity must be moved in the same transaction: release the old reservations
    -- first, then reschedule, then reserve again.
    IF EXISTS (
      SELECT 1 FROM worker_reservation r
      WHERE r.booking_id = OLD.id AND r.status IN ('HELD', 'ALLOCATED', 'ACCEPTED')
        AND NOT (r.period @> tstzrange(NEW.scheduled_start, NEW.scheduled_end, '[)'))
    ) THEN
      RAISE EXCEPTION 'Booking % still has reservations for the old time', OLD.booking_code
        USING ERRCODE = 'OT008';
    END IF;
    NEW.reschedule_count := OLD.reschedule_count + 1;
  END IF;

  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE FUNCTION booking_after_write() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO booking_status_history (booking_id, from_status, to_status, event,
                                        actor_user_id, actor_role, source, reason, request_id)
    VALUES (NEW.id, NULL, NEW.status, 'CREATED', app_actor_user_id(), app_actor_role(),
            app_source(), app_reason(), app_request_id());
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO booking_status_history (booking_id, from_status, to_status, event,
                                        actor_user_id, actor_role, source, reason, request_id)
    VALUES (NEW.id, OLD.status, NEW.status, app_event(), app_actor_user_id(), app_actor_role(),
            app_source(), app_reason(), app_request_id());

    -- Capacity follows the booking: statuses that no longer need a worker give it back.
    IF NEW.status IN ('CANCELLED', 'EXPIRED', 'ON_HOLD') THEN
      UPDATE booking_assignment
         SET status = CASE status WHEN 'OFFERED' THEN 'CANCELLED' ELSE 'WITHDRAWN' END,
             ended_at = now(), end_reason = 'BOOKING_' || NEW.status
       WHERE booking_id = NEW.id AND status IN ('OFFERED', 'ACCEPTED');
      UPDATE worker_reservation
         SET status = 'RELEASED', released_at = now(), release_reason = 'BOOKING_' || NEW.status
       WHERE booking_id = NEW.id AND status IN ('HELD', 'ALLOCATED', 'ACCEPTED');
    END IF;
  END IF;

  IF (NEW.scheduled_start, NEW.scheduled_end)
     IS DISTINCT FROM (OLD.scheduled_start, OLD.scheduled_end) THEN
    INSERT INTO booking_schedule_change (booking_id, previous_start, previous_end, new_start,
                                         new_end, actor_user_id, actor_role, source, reason,
                                         request_id)
    VALUES (NEW.id, OLD.scheduled_start, OLD.scheduled_end, NEW.scheduled_start,
            NEW.scheduled_end, app_actor_user_id(), app_actor_role(), app_source(),
            app_reason(), app_request_id());
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER booking_context BEFORE INSERT OR UPDATE ON booking
  FOR EACH ROW EXECUTE FUNCTION require_action_context();
CREATE TRIGGER booking_before_insert BEFORE INSERT ON booking
  FOR EACH ROW EXECUTE FUNCTION booking_before_insert();
CREATE TRIGGER booking_before_update BEFORE UPDATE ON booking
  FOR EACH ROW EXECUTE FUNCTION booking_before_update();
CREATE TRIGGER booking_after_write AFTER INSERT OR UPDATE ON booking
  FOR EACH ROW EXECUTE FUNCTION booking_after_write();
CREATE TRIGGER booking_no_delete BEFORE DELETE ON booking
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER booking_audit AFTER INSERT OR UPDATE ON booking
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');

CREATE TRIGGER booking_status_history_append_only BEFORE UPDATE OR DELETE ON booking_status_history
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER booking_schedule_change_append_only BEFORE UPDATE OR DELETE ON booking_schedule_change
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER booking_price_line_append_only BEFORE UPDATE OR DELETE ON booking_price_line
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER booking_rating_append_only BEFORE UPDATE OR DELETE ON booking_rating
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER booking_task_no_delete BEFORE DELETE ON booking_task
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER booking_task_audit AFTER INSERT OR UPDATE ON booking_task
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
CREATE TRIGGER booking_verification_code_audit AFTER INSERT OR UPDATE ON booking_verification_code
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('booking_id', 'code_hash');

-- ---------------------------------------------------------------------------
-- Worker reservations: the database is the final authority on availability.
--
--   HELD       tentative, while the customer pays; has hold_expires_at
--   ALLOCATED  booking confirmed; capacity committed; waiting for the worker to accept
--   ACCEPTED   the worker accepted the job
--   RELEASED   no longer blocks the worker's time
-- ---------------------------------------------------------------------------

CREATE TABLE worker_reservation (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id       uuid NOT NULL REFERENCES booking (id),
  worker_id        uuid NOT NULL REFERENCES worker_profile (user_id),
  crew_slot        smallint NOT NULL DEFAULT 1 CHECK (crew_slot > 0),
  -- Travel buffer + service + reset buffer.
  period           tstzrange NOT NULL,
  status           text NOT NULL CHECK (status IN ('HELD', 'ALLOCATED', 'ACCEPTED', 'RELEASED')),
  hold_expires_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  released_at      timestamptz,
  release_reason   text,
  CHECK (NOT isempty(period) AND NOT lower_inf(period) AND NOT upper_inf(period)
         AND lower_inc(period) AND NOT upper_inc(period)),
  CHECK ((status = 'HELD') = (hold_expires_at IS NOT NULL)),
  CHECK ((status = 'RELEASED') = (released_at IS NOT NULL)),
  UNIQUE (id, booking_id, worker_id),
  -- THE double-booking guarantee: one worker, no overlapping active reservations.
  CONSTRAINT worker_reservation_no_overlap
    EXCLUDE USING gist (worker_id WITH =, period WITH &&)
    WHERE (status IN ('HELD', 'ALLOCATED', 'ACCEPTED'))
);

-- One active reservation per crew position of a booking.
CREATE UNIQUE INDEX worker_reservation_active_slot_uq
  ON worker_reservation (booking_id, crew_slot)
  WHERE status IN ('HELD', 'ALLOCATED', 'ACCEPTED');

CREATE INDEX worker_reservation_booking_idx ON worker_reservation (booking_id);
CREATE INDEX worker_reservation_hold_idx ON worker_reservation (hold_expires_at)
  WHERE status = 'HELD';

CREATE FUNCTION worker_reservation_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_booking  booking%ROWTYPE;
  v_required smallint;
  v_reason   text;
BEGIN
  SELECT * INTO v_booking FROM booking WHERE id = NEW.booking_id;

  IF NEW.status = 'HELD' AND v_booking.status <> 'PENDING_PAYMENT' THEN
    RAISE EXCEPTION 'HELD reservations are only for bookings awaiting payment'
      USING ERRCODE = 'OT005';
  END IF;
  IF NEW.status = 'ALLOCATED' AND v_booking.status <> 'CONFIRMED' THEN
    RAISE EXCEPTION 'ALLOCATED reservations are only for confirmed bookings'
      USING ERRCODE = 'OT005';
  END IF;
  IF NEW.status NOT IN ('HELD', 'ALLOCATED') THEN
    RAISE EXCEPTION 'A reservation must start as HELD or ALLOCATED' USING ERRCODE = 'OT005';
  END IF;

  SELECT workers_required INTO v_required FROM service WHERE id = v_booking.service_id;
  IF NEW.crew_slot > v_required THEN
    RAISE EXCEPTION 'Service needs % worker(s); crew slot % is invalid', v_required, NEW.crew_slot
      USING ERRCODE = 'OT005';
  END IF;

  IF NOT (NEW.period @> tstzrange(v_booking.scheduled_start, v_booking.scheduled_end, '[)')) THEN
    RAISE EXCEPTION 'Reservation must cover the booked service time' USING ERRCODE = 'OT005';
  END IF;

  v_reason := worker_ineligibility_reason(NEW.worker_id, v_booking.service_id,
                                          v_booking.zone_id, NEW.period);
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'Worker % is not eligible: %', NEW.worker_id, v_reason
      USING ERRCODE = 'OT005', DETAIL = v_reason;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM worker_shift s
    WHERE s.worker_id = NEW.worker_id AND s.status = 'PLANNED'
      AND s.zone_id = v_booking.zone_id AND s.period @> NEW.period
  ) THEN
    RAISE EXCEPTION 'Worker % has no planned shift in this zone covering the reservation',
      NEW.worker_id USING ERRCODE = 'OT005', DETAIL = 'OUTSIDE_SHIFT';
  END IF;

  -- Expired payment holds must never block anyone: release them before the
  -- exclusion constraint is checked.
  UPDATE worker_reservation
     SET status = 'RELEASED', released_at = now(), release_reason = 'HOLD_EXPIRED',
         hold_expires_at = NULL
   WHERE worker_id = NEW.worker_id AND status = 'HELD'
     AND hold_expires_at <= now() AND period && NEW.period;

  RETURN NEW;
END;
$$;

CREATE FUNCTION worker_reservation_before_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.booking_id, NEW.worker_id, NEW.crew_slot, NEW.period, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.booking_id, OLD.worker_id, OLD.crew_slot, OLD.period, OLD.created_at) THEN
    RAISE EXCEPTION 'A reservation''s worker and period are fixed; release it and create a new one'
      USING ERRCODE = 'OT003';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'HELD'      AND NEW.status IN ('ALLOCATED', 'RELEASED')) OR
       (OLD.status = 'ALLOCATED' AND NEW.status IN ('ACCEPTED', 'RELEASED')) OR
       (OLD.status = 'ACCEPTED'  AND NEW.status = 'RELEASED')) THEN
    RAISE EXCEPTION 'Reservation cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'OT005';
  END IF;

  IF NEW.status <> 'HELD' THEN NEW.hold_expires_at := NULL; END IF;
  IF NEW.status = 'RELEASED' THEN NEW.released_at := COALESCE(NEW.released_at, now()); END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER worker_reservation_context BEFORE INSERT OR UPDATE ON worker_reservation
  FOR EACH ROW EXECUTE FUNCTION require_action_context();
CREATE TRIGGER worker_reservation_before_insert BEFORE INSERT ON worker_reservation
  FOR EACH ROW EXECUTE FUNCTION worker_reservation_before_insert();
CREATE TRIGGER worker_reservation_before_update BEFORE UPDATE ON worker_reservation
  FOR EACH ROW EXECUTE FUNCTION worker_reservation_before_update();
CREATE TRIGGER worker_reservation_no_delete BEFORE DELETE ON worker_reservation
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER worker_reservation_audit AFTER INSERT OR UPDATE ON worker_reservation
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');

-- ---------------------------------------------------------------------------
-- Assignments: offers to workers and their answers.
-- ---------------------------------------------------------------------------

CREATE TABLE booking_assignment (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id          uuid NOT NULL REFERENCES booking (id),
  worker_id           uuid NOT NULL REFERENCES worker_profile (user_id),
  reservation_id      uuid NOT NULL,
  crew_slot           smallint NOT NULL DEFAULT 1 CHECK (crew_slot > 0),
  status              text NOT NULL DEFAULT 'OFFERED'
                      CHECK (status IN ('OFFERED', 'ACCEPTED', 'REJECTED', 'EXPIRED',
                                        'CANCELLED', 'WITHDRAWN', 'COMPLETED')),
  offered_at          timestamptz NOT NULL DEFAULT now(),
  offer_expires_at    timestamptz NOT NULL,
  responded_at        timestamptz,
  response_reason     text,
  offered_by_user_id  uuid REFERENCES app_user (id),
  source              action_source NOT NULL,
  ended_at            timestamptz,
  end_reason          text,
  FOREIGN KEY (reservation_id, booking_id, worker_id)
    REFERENCES worker_reservation (id, booking_id, worker_id),
  CHECK (offer_expires_at > offered_at),
  CHECK (status <> 'REJECTED' OR response_reason IS NOT NULL)
);

-- At most one live offer or accepted assignment per crew position.
CREATE UNIQUE INDEX booking_assignment_live_slot_uq
  ON booking_assignment (booking_id, crew_slot) WHERE status IN ('OFFERED', 'ACCEPTED');
CREATE INDEX booking_assignment_worker_idx ON booking_assignment (worker_id, status);
CREATE INDEX booking_assignment_offer_expiry_idx ON booking_assignment (offer_expires_at)
  WHERE status = 'OFFERED';

CREATE FUNCTION booking_assignment_before_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.booking_id, NEW.worker_id, NEW.reservation_id, NEW.crew_slot,
      NEW.offered_at, NEW.offer_expires_at)
     IS DISTINCT FROM
     (OLD.id, OLD.booking_id, OLD.worker_id, OLD.reservation_id, OLD.crew_slot,
      OLD.offered_at, OLD.offer_expires_at) THEN
    RAISE EXCEPTION 'Offer details are fixed once sent' USING ERRCODE = 'OT003';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
         (OLD.status = 'OFFERED'  AND NEW.status IN ('ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED')) OR
         (OLD.status = 'ACCEPTED' AND NEW.status IN ('WITHDRAWN', 'CANCELLED', 'COMPLETED'))) THEN
      RAISE EXCEPTION 'Assignment cannot move from % to %', OLD.status, NEW.status
        USING ERRCODE = 'OT008';
    END IF;
    IF NEW.status = 'ACCEPTED' AND now() > OLD.offer_expires_at THEN
      RAISE EXCEPTION 'The offer expired at %', OLD.offer_expires_at USING ERRCODE = 'OT008';
    END IF;
    IF OLD.status = 'OFFERED' THEN
      NEW.responded_at := COALESCE(NEW.responded_at, now());
    END IF;
    IF NEW.status IN ('WITHDRAWN', 'CANCELLED', 'COMPLETED', 'EXPIRED') THEN
      NEW.ended_at := COALESCE(NEW.ended_at, now());
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER booking_assignment_context BEFORE INSERT OR UPDATE ON booking_assignment
  FOR EACH ROW EXECUTE FUNCTION require_action_context();
CREATE TRIGGER booking_assignment_before_update BEFORE UPDATE ON booking_assignment
  FOR EACH ROW EXECUTE FUNCTION booking_assignment_before_update();
CREATE TRIGGER booking_assignment_no_delete BEFORE DELETE ON booking_assignment
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER booking_assignment_audit AFTER INSERT OR UPDATE ON booking_assignment
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
