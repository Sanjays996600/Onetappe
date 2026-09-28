-- 0027 Indexes for query paths that scanned whole tables (engineering gate G7).
--
-- Each index serves a query the application actually runs; plans before and after, at a
-- synthetic volume (80k devices, 10k refunds, 400k gateway events, 1M notifications), are
-- in docs/15-foundation-hardening.md. Foreign keys that no query filters on were reviewed and
-- left without an index:
--   safety_incident(booking_id)  only joined from the incident to the booking's primary key;
--   worker_payout(worker_id)     no query yet (payouts are not built);
-- and referenced rows are never deleted (delete-forbidding triggers), so foreign-key checks
-- do not need them either.
--
-- These tables are small or empty before launch. The migration runner wraps each file in a
-- transaction, so CREATE INDEX CONCURRENTLY is not used; revisit that for large live tables.

-- Push recipients: every push notification looks up a person's active devices.
CREATE INDEX user_device_active_user_idx
  ON user_device (user_id)
  WHERE disabled_at IS NULL AND push_token IS NOT NULL;

-- Amount already refunded for a payment: every refund request and paid cancellation.
CREATE INDEX refund_payment_idx ON refund (payment_id);

-- Gateway events of a booking's payments: the booking trace and payment investigations.
CREATE INDEX payment_event_payment_idx
  ON payment_event (payment_id)
  WHERE payment_id IS NOT NULL;

-- Messages about a booking: the booking trace used by support and safety.
CREATE INDEX notification_booking_idx
  ON notification (booking_id)
  WHERE booking_id IS NOT NULL;
