CREATE TABLE ethereum_auth_challenges (
  challenge_id TEXT PRIMARY KEY NOT NULL,
  wallet TEXT NOT NULL CHECK (length(wallet) = 42 AND substr(wallet, 1, 2) = '0x' AND substr(wallet, 3) NOT GLOB '*[^0-9a-f]*'),
  chain_id INTEGER NOT NULL CHECK (chain_id IN (31337, 11155111)),
  drop_id TEXT NOT NULL CHECK (drop_id = '111k_devnet'),
  origin TEXT NOT NULL,
  message TEXT NOT NULL,
  issued_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  consumed_at_ms INTEGER
) STRICT;
CREATE INDEX ethereum_auth_challenges_expiry ON ethereum_auth_challenges(expires_at_ms);

CREATE TABLE ethereum_auth_sessions (
  session_id TEXT PRIMARY KEY NOT NULL,
  challenge_id TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL,
  wallet TEXT NOT NULL CHECK (length(wallet) = 42 AND substr(wallet, 1, 2) = '0x' AND substr(wallet, 3) NOT GLOB '*[^0-9a-f]*'),
  chain_id INTEGER NOT NULL CHECK (chain_id IN (31337, 11155111)),
  drop_id TEXT NOT NULL CHECK (drop_id = '111k_devnet'),
  origin TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX ethereum_auth_sessions_expiry ON ethereum_auth_sessions(expires_at_ms);

CREATE TABLE ethereum_profiles (
  wallet TEXT PRIMARY KEY NOT NULL CHECK (length(wallet) = 42 AND substr(wallet, 1, 2) = '0x' AND substr(wallet, 3) NOT GLOB '*[^0-9a-f]*'),
  email TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE ethereum_profile_addresses (
  wallet TEXT NOT NULL REFERENCES ethereum_profiles(wallet),
  address_id TEXT NOT NULL CHECK (length(address_id) = 20),
  address_json TEXT NOT NULL CHECK (json_valid(address_json)),
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (wallet, address_id)
) STRICT;
