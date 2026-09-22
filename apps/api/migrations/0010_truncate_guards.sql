-- 0010 TRUNCATE bypasses row-level triggers, so history and financial tables also get
-- statement-level guards. Test databases are rebuilt with DROP SCHEMA, not TRUNCATE.

CREATE FUNCTION forbid_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% cannot be truncated', TG_TABLE_NAME USING ERRCODE = 'OT001';
END;
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'audit_log', 'booking', 'booking_status_history', 'booking_schedule_change',
    'booking_price_line', 'booking_rating', 'booking_assignment', 'worker_reservation',
    'booking_status_transition', 'payment', 'payment_event', 'refund', 'invoice',
    'credit_note', 'worker_earning', 'worker_payout', 'worker_verification',
    'worker_restriction', 'worker_presence_event', 'consent_record', 'user_role',
    'support_case', 'support_case_event', 'safety_incident', 'safety_incident_event',
    'price_rule', 'charge_rule', 'payout_rule', 'promotion', 'promotion_redemption', 'tax_rate'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate()',
      t || '_no_truncate', t);
  END LOOP;
END;
$$;
