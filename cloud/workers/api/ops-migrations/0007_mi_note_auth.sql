CREATE TABLE mi_note_auth_challenges (
  challenge_id TEXT NOT NULL PRIMARY KEY CHECK (length(challenge_id) = 36),
  address TEXT NOT NULL CHECK (length(address) = 42 AND substr(address, 1, 2) = '0x' AND substr(address, 3) NOT GLOB '*[^0-9a-f]*'),
  preorder_id TEXT NOT NULL CHECK (preorder_id IN ('mi_note_cards', 'mi_note_cards_devnet')),
  origin TEXT NOT NULL CHECK (length(origin) BETWEEN 1 AND 512),
  chain_id INTEGER NOT NULL CHECK (chain_id BETWEEN 1 AND 9007199254740991),
  issued_at_ms INTEGER NOT NULL CHECK (issued_at_ms BETWEEN 0 AND 253402300799999),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms = issued_at_ms + 300000),
  consumed_at_ms INTEGER CHECK (consumed_at_ms IS NULL OR consumed_at_ms >= issued_at_ms)
) STRICT;

CREATE INDEX mi_note_auth_challenges_expires_at_ms
ON mi_note_auth_challenges (expires_at_ms, challenge_id);

CREATE TABLE mi_note_auth_sessions (
  session_id TEXT NOT NULL PRIMARY KEY CHECK (length(session_id) = 36),
  challenge_id TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL UNIQUE CHECK (length(secret_hash) = 64 AND secret_hash NOT GLOB '*[^0-9a-f]*'),
  address TEXT NOT NULL CHECK (length(address) = 42 AND substr(address, 1, 2) = '0x' AND substr(address, 3) NOT GLOB '*[^0-9a-f]*'),
  preorder_id TEXT NOT NULL CHECK (preorder_id IN ('mi_note_cards', 'mi_note_cards_devnet')),
  origin TEXT NOT NULL CHECK (length(origin) BETWEEN 1 AND 512),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 253402300799999),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms = created_at_ms + 3600000)
) STRICT;

CREATE INDEX mi_note_auth_sessions_expires_at_ms
ON mi_note_auth_sessions (expires_at_ms, session_id);
