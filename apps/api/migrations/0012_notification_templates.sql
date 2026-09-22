-- 0012 Initial notification templates (English and Hindi).
-- An event is sent on every channel that has an active template for it; operations can
-- change wording or channels later without code changes. Variables use {{name}}.
-- WhatsApp and SMS templates must additionally be registered with the provider (DLT/Meta)
-- before they are switched on in production; their provider_template_id is set then.

INSERT INTO notification_template (code, channel, locale, version, title, body) VALUES
  -- Customer
  ('BOOKING_CONFIRMED', 'PUSH', 'en', 1, 'Booking confirmed', 'Your {{serviceName}} on {{startTime}} is confirmed. Booking {{bookingCode}}.'),
  ('BOOKING_CONFIRMED', 'PUSH', 'hi', 1, 'बुकिंग पक्की हो गई', 'आपकी {{serviceName}} सेवा {{startTime}} के लिए पक्की हो गई है। बुकिंग {{bookingCode}}।'),
  ('BOOKING_CONFIRMED', 'SMS',  'en', 1, NULL, 'One Tappe: booking {{bookingCode}} for {{serviceName}} on {{startTime}} is confirmed.'),
  ('BOOKING_CONFIRMED', 'SMS',  'hi', 1, NULL, 'वन टैप्पे: {{serviceName}} के लिए बुकिंग {{bookingCode}}, {{startTime}} पक्की है।'),
  ('PAYMENT_SUCCESSFUL', 'PUSH', 'en', 1, 'Payment received', 'We received {{amount}} for booking {{bookingCode}}.'),
  ('PAYMENT_SUCCESSFUL', 'PUSH', 'hi', 1, 'भुगतान प्राप्त हुआ', 'बुकिंग {{bookingCode}} के लिए {{amount}} का भुगतान मिल गया है।'),
  ('WORKER_ASSIGNED', 'PUSH', 'en', 1, 'Professional assigned', '{{workerName}} will do your {{serviceName}} on {{startTime}}.'),
  ('WORKER_ASSIGNED', 'PUSH', 'hi', 1, 'सहायक तय हो गए', '{{workerName}} {{startTime}} पर आपकी {{serviceName}} सेवा करेंगे।'),
  ('WORKER_EN_ROUTE', 'PUSH', 'en', 1, 'On the way', '{{workerName}} is on the way for booking {{bookingCode}}.'),
  ('WORKER_EN_ROUTE', 'PUSH', 'hi', 1, 'रास्ते में', '{{workerName}} बुकिंग {{bookingCode}} के लिए रास्ते में हैं।'),
  ('WORKER_ARRIVED', 'PUSH', 'en', 1, 'Professional has arrived', '{{workerName}} has arrived. Check their ID, then share your start code from the app.'),
  ('WORKER_ARRIVED', 'PUSH', 'hi', 1, 'सहायक पहुँच गए', '{{workerName}} पहुँच गए हैं। उनका पहचान पत्र देखें, फिर ऐप से स्टार्ट कोड बताएँ।'),
  ('SERVICE_STARTED', 'PUSH', 'en', 1, 'Service started', 'Your {{serviceName}} has started.'),
  ('SERVICE_STARTED', 'PUSH', 'hi', 1, 'सेवा शुरू हुई', 'आपकी {{serviceName}} सेवा शुरू हो गई है।'),
  ('SERVICE_COMPLETED', 'PUSH', 'en', 1, 'Service completed', 'Your {{serviceName}} is complete. Please rate your experience.'),
  ('SERVICE_COMPLETED', 'PUSH', 'hi', 1, 'सेवा पूरी हुई', 'आपकी {{serviceName}} सेवा पूरी हो गई है। कृपया अपना अनुभव बताएँ।'),
  ('BOOKING_RESCHEDULED', 'PUSH', 'en', 1, 'Booking rescheduled', 'Booking {{bookingCode}} is now on {{startTime}}.'),
  ('BOOKING_RESCHEDULED', 'PUSH', 'hi', 1, 'बुकिंग का समय बदला', 'बुकिंग {{bookingCode}} अब {{startTime}} पर है।'),
  ('BOOKING_CANCELLED', 'PUSH', 'en', 1, 'Booking cancelled', 'Booking {{bookingCode}} has been cancelled.'),
  ('BOOKING_CANCELLED', 'PUSH', 'hi', 1, 'बुकिंग रद्द', 'बुकिंग {{bookingCode}} रद्द कर दी गई है।'),
  ('BOOKING_CANCELLED', 'SMS',  'en', 1, NULL, 'One Tappe: booking {{bookingCode}} has been cancelled.'),
  ('BOOKING_CANCELLED', 'SMS',  'hi', 1, NULL, 'वन टैप्पे: बुकिंग {{bookingCode}} रद्द कर दी गई है।'),
  ('NO_WORKER_AVAILABLE', 'PUSH', 'en', 1, 'We are finding a professional', 'We are still arranging a professional for booking {{bookingCode}}. Our team will contact you.'),
  ('NO_WORKER_AVAILABLE', 'PUSH', 'hi', 1, 'सहायक खोजे जा रहे हैं', 'बुकिंग {{bookingCode}} के लिए सहायक की व्यवस्था की जा रही है। हमारी टीम आपसे संपर्क करेगी।'),
  ('REFUND_INITIATED', 'PUSH', 'en', 1, 'Refund initiated', 'A refund of {{amount}} for booking {{bookingCode}} has been initiated.'),
  ('REFUND_INITIATED', 'PUSH', 'hi', 1, 'रिफंड शुरू', 'बुकिंग {{bookingCode}} के लिए {{amount}} का रिफंड शुरू कर दिया गया है।'),
  ('REFUND_COMPLETED', 'PUSH', 'en', 1, 'Refund completed', 'Your refund of {{amount}} for booking {{bookingCode}} is complete.'),
  ('REFUND_COMPLETED', 'PUSH', 'hi', 1, 'रिफंड पूरा', 'बुकिंग {{bookingCode}} के लिए {{amount}} का रिफंड पूरा हो गया है।'),
  ('REFUND_COMPLETED', 'SMS',  'en', 1, NULL, 'One Tappe: refund of {{amount}} for booking {{bookingCode}} is complete.'),
  ('REFUND_COMPLETED', 'SMS',  'hi', 1, NULL, 'वन टैप्पे: बुकिंग {{bookingCode}} का {{amount}} रिफंड पूरा हुआ।'),
  -- Worker
  ('JOB_OFFER', 'PUSH', 'en', 1, 'New job request', '{{serviceName}} in {{locality}} on {{startTime}}. Respond within {{minutes}} minutes.'),
  ('JOB_OFFER', 'PUSH', 'hi', 1, 'नया काम', '{{locality}} में {{startTime}} पर {{serviceName}}। {{minutes}} मिनट में जवाब दें।'),
  ('JOB_CANCELLED', 'PUSH', 'en', 1, 'Job cancelled', 'Booking {{bookingCode}} on {{startTime}} was cancelled.'),
  ('JOB_CANCELLED', 'PUSH', 'hi', 1, 'काम रद्द', '{{startTime}} की बुकिंग {{bookingCode}} रद्द कर दी गई है।');

-- Every push message is also kept in the in-app inbox.
INSERT INTO notification_template (code, channel, locale, version, title, body)
SELECT code, 'IN_APP', locale, version, title, body FROM notification_template WHERE channel = 'PUSH';
