INSERT INTO worker_controls (
  control_key,
  cursor_path,
  revision,
  created_at_ms,
  updated_at_ms,
  cursor_updated_at_ms
) VALUES ('ready_notifications', NULL, 1, 0, 0, NULL)
ON CONFLICT(control_key) DO NOTHING;
