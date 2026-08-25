CREATE TABLE staff_auth_challenges (
  challenge_id TEXT NOT NULL PRIMARY KEY CHECK (
    length(challenge_id) = 36
  ),
  wallet TEXT NOT NULL CHECK (
    length(wallet) BETWEEN 32 AND 64 AND
    wallet NOT GLOB '*[^A-Za-z0-9]*' AND
    wallet NOT GLOB '*[0OIl]*'
  ),
  origin_hostname TEXT NOT NULL CHECK (
    length(origin_hostname) BETWEEN 1 AND 253 AND
    origin_hostname = lower(origin_hostname)
  ),
  issued_at_ms INTEGER NOT NULL CHECK (
    issued_at_ms BETWEEN 0 AND 253402300799999
  ),
  expires_at_ms INTEGER NOT NULL CHECK (
    expires_at_ms BETWEEN issued_at_ms AND 253402300799999
  ),
  consumed_at_ms INTEGER CHECK (
    consumed_at_ms IS NULL OR
    consumed_at_ms BETWEEN issued_at_ms AND 253402300799999
  ),
  UNIQUE (wallet, origin_hostname)
) STRICT;

CREATE INDEX staff_auth_challenges_expires_at_ms
ON staff_auth_challenges (expires_at_ms);

CREATE TABLE staff_auth_sessions (
  session_id TEXT NOT NULL PRIMARY KEY CHECK (
    length(session_id) = 36
  ),
  challenge_id TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL UNIQUE CHECK (
    length(secret_hash) = 64 AND
    secret_hash = lower(secret_hash) AND
    secret_hash NOT GLOB '*[^0-9a-f]*'
  ),
  wallet TEXT NOT NULL CHECK (
    length(wallet) BETWEEN 32 AND 64 AND
    wallet NOT GLOB '*[^A-Za-z0-9]*' AND
    wallet NOT GLOB '*[0OIl]*'
  ),
  created_at_ms INTEGER NOT NULL CHECK (
    created_at_ms BETWEEN 0 AND 253402300799999
  ),
  refreshed_at_ms INTEGER NOT NULL CHECK (
    refreshed_at_ms BETWEEN created_at_ms AND 253402300799999
  ),
  expires_at_ms INTEGER NOT NULL CHECK (
    expires_at_ms BETWEEN refreshed_at_ms AND 253402300799999
  )
) STRICT;

CREATE INDEX staff_auth_sessions_expires_at_ms
ON staff_auth_sessions (expires_at_ms);

CREATE INDEX staff_auth_sessions_wallet
ON staff_auth_sessions (wallet);
