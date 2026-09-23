-- 0026 Ending a person's sessions on every device (lost or stolen phone).
--
-- The account owner can sign out everywhere themselves; support can do it for them after
-- verifying who is calling. Revocation is protective (it only signs people out), so it is
-- granted to the teams people call, and every use is audited with a reason.

INSERT INTO permission (code, description, is_sensitive) VALUES
  ('account.sessions.revoke', 'Sign a customer or worker out of every device (lost or stolen phone)', true);

INSERT INTO role_permission (role_code, permission_code) VALUES
  ('CUSTOMER_SUPPORT', 'account.sessions.revoke'),
  ('OPERATIONS_HEAD', 'account.sessions.revoke'),
  ('WORKER_OPERATIONS', 'account.sessions.revoke'),
  ('SAFETY', 'account.sessions.revoke');
