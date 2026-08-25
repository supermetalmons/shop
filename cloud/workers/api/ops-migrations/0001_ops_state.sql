CREATE TABLE worker_controls (
  control_key TEXT NOT NULL PRIMARY KEY CHECK (control_key = 'ready_notifications'),
  paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
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

INSERT INTO worker_controls (
  control_key,
  paused,
  cursor_path,
  revision,
  created_at_ms,
  updated_at_ms,
  cursor_updated_at_ms
)
VALUES ('ready_notifications', 0, NULL, 1, 0, 0, NULL);

CREATE TABLE rate_limit_buckets (
  scope TEXT NOT NULL CHECK (scope IN ('caller', 'asset')),
  subject_hash TEXT NOT NULL CHECK (
    length(subject_hash) = 64 AND
    subject_hash NOT GLOB '*[^0-9a-f]*'
  ),
  schema_version INTEGER NOT NULL CHECK (schema_version BETWEEN 1 AND 9007199254740991),
  cluster TEXT,
  owner_wallet TEXT,
  receipt_asset_id TEXT,
  window_started_at_ms INTEGER NOT NULL CHECK (
    window_started_at_ms BETWEEN 0 AND 9007199254140991
  ),
  expires_at_ms INTEGER NOT NULL CHECK (
    expires_at_ms BETWEEN 600000 AND 9007199254740991 AND
    expires_at_ms = window_started_at_ms + 600000
  ),
  request_count INTEGER NOT NULL CHECK (request_count BETWEEN 1 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (
    updated_at_ms BETWEEN window_started_at_ms AND expires_at_ms
  ),
  PRIMARY KEY (scope, subject_hash),
  CHECK (
    (
      scope = 'caller' AND
      cluster IS NULL AND
      owner_wallet IS NULL AND
      receipt_asset_id IS NULL
    ) OR
    (
      scope = 'asset' AND
      cluster IS NOT NULL AND
      cluster IN ('devnet', 'testnet', 'mainnet-beta') AND
      length(cluster) > 0 AND
      owner_wallet IS NOT NULL AND
      length(owner_wallet) BETWEEN 1 AND 128 AND
      receipt_asset_id IS NOT NULL AND
      length(receipt_asset_id) BETWEEN 1 AND 128
    )
  )
) STRICT;

CREATE INDEX rate_limit_buckets_expires_at_ms
ON rate_limit_buckets (expires_at_ms);
