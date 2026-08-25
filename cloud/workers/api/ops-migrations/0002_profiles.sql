CREATE TABLE profiles (
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
    created_at_ms BETWEEN 0 AND 9007199254740991
  ),
  updated_at_ms INTEGER NOT NULL CHECK (
    updated_at_ms BETWEEN created_at_ms AND 9007199254740991
  )
) STRICT;

CREATE TABLE profile_addresses (
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
    created_at_ms BETWEEN 0 AND 9007199254740991
  ),
  updated_at_ms INTEGER NOT NULL CHECK (
    updated_at_ms BETWEEN created_at_ms AND 9007199254740991
  ),
  PRIMARY KEY (wallet, address_id),
  FOREIGN KEY (wallet) REFERENCES profiles(wallet) ON DELETE CASCADE
) STRICT;

CREATE TABLE profile_storage_control (
  singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
  read_source TEXT NOT NULL CHECK (
    read_source IN ('firestore_fallback', 'd1')
  ),
  updated_at_ms INTEGER NOT NULL CHECK (
    updated_at_ms BETWEEN 0 AND 9007199254740991
  )
) STRICT;

INSERT INTO profile_storage_control (singleton, read_source, updated_at_ms)
VALUES (1, 'firestore_fallback', 0);

CREATE TRIGGER profile_storage_d1_irreversible
BEFORE UPDATE OF read_source ON profile_storage_control
WHEN OLD.read_source = 'd1' AND NEW.read_source <> 'd1'
BEGIN
  SELECT RAISE(ABORT, 'profile storage is permanently d1');
END;
