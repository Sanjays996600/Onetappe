-- 0014 OTP delivery outcome.
--
-- A code whose SMS the provider did not accept is recorded as FAILED and can never be
-- used. It still counts towards the hourly/daily request limits (abuse protection) but not
-- towards the resend cooldown, so the user can ask again straight away.

ALTER TABLE otp_challenge
  ADD COLUMN delivery_status     text NOT NULL DEFAULT 'PENDING'
                                 CHECK (delivery_status IN ('PENDING', 'SENT', 'FAILED')),
  ADD COLUMN delivery_reference  text,
  ADD COLUMN delivery_error      text CHECK (length(delivery_error) <= 300);

UPDATE otp_challenge SET delivery_status = 'SENT';
