PRAGMA foreign_keys = ON;

CREATE TABLE anonymous_auth_sessions (
  session_id TEXT NOT NULL PRIMARY KEY CHECK (
    length(session_id) = 36
  ),
  secret_hash TEXT NOT NULL UNIQUE CHECK (
    length(secret_hash) = 64 AND
    secret_hash = lower(secret_hash) AND
    secret_hash NOT GLOB '*[^0-9a-f]*'
  ),
  auth_subject TEXT NOT NULL UNIQUE CHECK (
    length(auth_subject) = 41 AND
    auth_subject GLOB 'anon:????????-????-4???-????-????????????'
  ),
  origin_hostname TEXT NOT NULL CHECK (
    length(origin_hostname) BETWEEN 1 AND 253 AND
    origin_hostname = lower(origin_hostname)
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

CREATE TABLE auth_wallet_bindings (
  auth_subject TEXT NOT NULL PRIMARY KEY CHECK (
    length(auth_subject) BETWEEN 1 AND 128
  ),
  wallet TEXT NOT NULL CHECK (
    length(wallet) BETWEEN 32 AND 64 AND
    wallet NOT GLOB '*[^A-Za-z0-9]*' AND
    wallet NOT GLOB '*[0OIl]*'
  ),
  updated_at_ms INTEGER NOT NULL CHECK (
    updated_at_ms BETWEEN 0 AND 253402300799999
  ),
  revision INTEGER NOT NULL CHECK (
    revision BETWEEN 1 AND 9007199254740991
  ),
  reconcile_lease_id TEXT CHECK (
    reconcile_lease_id IS NULL OR length(reconcile_lease_id) = 36
  ),
  reconcile_lease_expires_at_ms INTEGER CHECK (
    reconcile_lease_expires_at_ms IS NULL OR
    reconcile_lease_expires_at_ms BETWEEN 0 AND 253402300799999
  ),
  CHECK (
    (reconcile_lease_id IS NULL AND reconcile_lease_expires_at_ms IS NULL) OR
    (reconcile_lease_id IS NOT NULL AND reconcile_lease_expires_at_ms IS NOT NULL)
  )
) STRICT;

CREATE TABLE "profile_addresses" (
  wallet TEXT NOT NULL CHECK (
    length(wallet) BETWEEN 32 AND 64 AND
    wallet NOT GLOB '*[^A-Za-z0-9]*' AND
    wallet NOT GLOB '*[0OIl]*'
  ),
  address_id TEXT NOT NULL CHECK (
    length(address_id) = 20 AND
    address_id NOT GLOB '*[^A-Za-z0-9]*'
  ),
  encrypted TEXT NOT NULL CHECK (length(encrypted) <= 4096),
  country TEXT NOT NULL CHECK (length(country) <= 64),
  country_code TEXT CHECK (
    country_code IS NULL OR
    length(country_code) <= 32
  ),
  hint TEXT NOT NULL CHECK (length(hint) <= 256),
  email TEXT CHECK (
    email IS NULL OR
    length(email) BETWEEN 1 AND 254
  ),
  label TEXT CHECK (
    label IS NULL OR
    length(label) <= 256
  ),
  created_at_ms INTEGER NOT NULL CHECK (
    created_at_ms BETWEEN 0 AND 253402300799999
  ),
  updated_at_ms INTEGER NOT NULL CHECK (
    updated_at_ms BETWEEN created_at_ms AND 253402300799999
  ),
  PRIMARY KEY (wallet, address_id),
  FOREIGN KEY (wallet) REFERENCES "profiles"(wallet) ON DELETE CASCADE
) STRICT;

CREATE TABLE "profiles" (
  wallet TEXT NOT NULL PRIMARY KEY CHECK (
    length(wallet) BETWEEN 32 AND 64 AND
    wallet NOT GLOB '*[^A-Za-z0-9]*' AND
    wallet NOT GLOB '*[0OIl]*'
  ),
  email TEXT CHECK (
    email IS NULL OR
    length(email) BETWEEN 1 AND 254
  ),
  created_at_ms INTEGER NOT NULL CHECK (
    created_at_ms BETWEEN 0 AND 253402300799999
  ),
  updated_at_ms INTEGER NOT NULL CHECK (
    updated_at_ms BETWEEN created_at_ms AND 253402300799999
  )
) STRICT;

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

CREATE TABLE reveal_submission_storage_control (
  singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
  paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (
    updated_at_ms BETWEEN created_at_ms AND 9007199254740991
  )) STRICT;

CREATE TABLE reveal_submissions (
  drop_id TEXT NOT NULL CHECK (length(drop_id) BETWEEN 1 AND 64),
  box_asset_id TEXT NOT NULL CHECK (length(box_asset_id) BETWEEN 32 AND 64),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  owner_wallet TEXT NOT NULL CHECK (length(owner_wallet) BETWEEN 32 AND 64),
  signature TEXT NOT NULL CHECK (length(signature) BETWEEN 64 AND 128),
  recent_blockhash TEXT NOT NULL CHECK (length(recent_blockhash) BETWEEN 32 AND 64),
  blockhash_context_slot INTEGER NOT NULL CHECK (
    blockhash_context_slot BETWEEN 0 AND 9007199254740991
  ),
  dude_ids_json TEXT NOT NULL CHECK (
    length(dude_ids_json) BETWEEN 3 AND 1024 AND
    json_valid(dude_ids_json) AND
    json_type(dude_ids_json) = 'array'
  ),
  reservation_id TEXT NOT NULL CHECK (length(reservation_id) = 36),
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'failed')),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (
    updated_at_ms BETWEEN created_at_ms AND 9007199254740991
  ),
  confirmed_at_ms INTEGER CHECK (
    confirmed_at_ms IS NULL OR
    confirmed_at_ms BETWEEN created_at_ms AND updated_at_ms
  ),
  PRIMARY KEY (drop_id, box_asset_id),
  CHECK (
    (status = 'confirmed' AND confirmed_at_ms IS NOT NULL) OR
    (status <> 'confirmed' AND confirmed_at_ms IS NULL)
  )
) STRICT;

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

CREATE INDEX anonymous_auth_sessions_auth_subject
ON anonymous_auth_sessions (auth_subject);

CREATE INDEX anonymous_auth_sessions_expires_at_ms
ON anonymous_auth_sessions (expires_at_ms);

CREATE INDEX rate_limit_buckets_expires_at_ms
ON rate_limit_buckets (expires_at_ms);

CREATE INDEX reveal_submissions_status_created_at_ms
ON reveal_submissions (status, created_at_ms);

CREATE INDEX staff_auth_challenges_expires_at_ms
ON staff_auth_challenges (expires_at_ms);

CREATE INDEX staff_auth_sessions_expires_at_ms
ON staff_auth_sessions (expires_at_ms);

CREATE INDEX staff_auth_sessions_wallet
ON staff_auth_sessions (wallet);

INSERT INTO reveal_submission_storage_control (
  singleton,
  paused,
  revision,
  created_at_ms,
  updated_at_ms
) VALUES (1, 0, 1, 0, 0);

INSERT INTO worker_controls (
  control_key,
  paused,
  cursor_path,
  revision,
  created_at_ms,
  updated_at_ms,
  cursor_updated_at_ms
) VALUES ('ready_notifications', 0, NULL, 1, 0, 0, NULL);

CREATE TRIGGER profile_address_conflict_guard
BEFORE INSERT ON profile_addresses
WHEN EXISTS (
  SELECT 1
  FROM profile_addresses
  WHERE
    wallet = NEW.wallet AND
    address_id = NEW.address_id AND
    NOT (
      encrypted IS NEW.encrypted AND
      country IS NEW.country AND
      country_code IS NEW.country_code AND
      hint IS NEW.hint AND
      email IS NEW.email AND
      label IS NEW.label
    )
)
BEGIN
  SELECT RAISE(ABORT, 'profile address id conflict');
END;

CREATE TRIGGER profile_address_delete_guard
BEFORE DELETE ON profile_addresses
BEGIN
  SELECT RAISE(ABORT, 'profile addresses are immutable');
END;

CREATE TRIGGER profile_address_idempotent_insert
BEFORE INSERT ON profile_addresses
WHEN EXISTS (
  SELECT 1
  FROM profile_addresses
  WHERE
    wallet = NEW.wallet AND
    address_id = NEW.address_id AND
    encrypted IS NEW.encrypted AND
    country IS NEW.country AND
    country_code IS NEW.country_code AND
    hint IS NEW.hint AND
    email IS NEW.email AND
    label IS NEW.label
)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER profile_address_update_guard
BEFORE UPDATE ON profile_addresses
BEGIN
  SELECT RAISE(ABORT, 'profile addresses are immutable');
END;

CREATE TRIGGER profile_delete_guard
BEFORE DELETE ON profiles
BEGIN
  SELECT RAISE(ABORT, 'profiles cannot be deleted');
END;

CREATE TRIGGER reveal_submission_control_delete_guard
BEFORE DELETE ON reveal_submission_storage_control
BEGIN
  SELECT RAISE(ABORT, 'reveal-submission control is immutable');
END;

CREATE TRIGGER reveal_submission_control_insert_guard
BEFORE INSERT ON reveal_submission_storage_control
BEGIN
  SELECT RAISE(ABORT, 'reveal-submission control is immutable');
END;

CREATE TRIGGER reveal_submission_control_update_guard
    BEFORE UPDATE ON reveal_submission_storage_control
    WHEN
      NEW.singleton <> 1 OR
      NEW.revision <> OLD.revision + 1 OR
      NEW.created_at_ms <> OLD.created_at_ms OR
      NEW.updated_at_ms < OLD.updated_at_ms
    BEGIN
      SELECT RAISE(ABORT, 'invalid reveal-submission control update');
    END;
