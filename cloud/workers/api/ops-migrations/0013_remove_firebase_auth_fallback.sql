UPDATE anonymous_auth_control
SET
  firebase_fallback_enabled = 0,
  revision = revision + 1,
  updated_at_ms = MAX(updated_at_ms, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  firebase_disabled_at_ms = MAX(updated_at_ms, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
WHERE singleton = 1 AND firebase_fallback_enabled = 1;
