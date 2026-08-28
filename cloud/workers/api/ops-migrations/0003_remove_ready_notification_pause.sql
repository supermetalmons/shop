CREATE TABLE worker_controls_without_ready_notification_pause (
  control_key TEXT NOT NULL PRIMARY KEY CHECK (control_key = 'ready_notifications'),
  cursor_path TEXT CHECK (
    cursor_path IS NULL OR
    (length(cursor_path) BETWEEN 1 AND 1500)
  ),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN created_at_ms AND 9007199254740991),
  cursor_updated_at_ms INTEGER CHECK (
    cursor_updated_at_ms IS NULL OR
    cursor_updated_at_ms BETWEEN created_at_ms AND updated_at_ms
  ),
  CHECK (
    (cursor_path IS NULL AND cursor_updated_at_ms IS NULL) OR
    (cursor_path IS NOT NULL AND cursor_updated_at_ms IS NOT NULL)
  )
) STRICT;

INSERT INTO worker_controls_without_ready_notification_pause (
  control_key,
  cursor_path,
  revision,
  created_at_ms,
  updated_at_ms,
  cursor_updated_at_ms
)
SELECT
  control_key,
  cursor_path,
  revision,
  created_at_ms,
  updated_at_ms,
  cursor_updated_at_ms
FROM worker_controls;

DROP TABLE worker_controls;

ALTER TABLE worker_controls_without_ready_notification_pause
RENAME TO worker_controls;
