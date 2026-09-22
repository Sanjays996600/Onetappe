-- 0013 Duplicate captures and background-job leases.

-- A customer can end up paying twice (two checkout attempts both succeed). The second
-- capture is real money, so it is recorded, flagged as a duplicate and refunded; only
-- one non-duplicate capture per booking is allowed.
ALTER TABLE payment ADD COLUMN is_duplicate boolean NOT NULL DEFAULT false;
DROP INDEX payment_one_captured_per_booking_uq;
CREATE UNIQUE INDEX payment_one_captured_per_booking_uq ON payment (booking_id)
  WHERE status = 'CAPTURED' AND NOT is_duplicate;

-- Amount the gateway actually captured (normally equal to amount_paise).
ALTER TABLE payment ADD COLUMN captured_amount_paise bigint CHECK (captured_amount_paise > 0);

-- Only one worker process runs a given job at a time. A lease expires on its own if the
-- process dies, so a crashed worker never blocks a job permanently.
CREATE TABLE job_lease (
  job_name      text PRIMARY KEY,
  owner         text NOT NULL,
  locked_until  timestamptz NOT NULL
);
