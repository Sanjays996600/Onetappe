-- 0018 Permission to view platform health (jobs, queues, integrations, alerts).

INSERT INTO permission (code, description, is_sensitive) VALUES
  ('system.read', 'View platform health: background jobs, queues, integrations and alerts', false);

INSERT INTO role_permission (role_code, permission_code) VALUES
  ('SUPER_ADMIN', 'system.read'),
  ('OPERATIONS_HEAD', 'system.read'),
  ('AUDITOR', 'system.read');
