CREATE TABLE commerce_authority_control_lease (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  lease_token TEXT NOT NULL CHECK (length(lease_token) = 36),
  acquired_at_ms INTEGER NOT NULL CHECK (acquired_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > acquired_at_ms)
) STRICT;
