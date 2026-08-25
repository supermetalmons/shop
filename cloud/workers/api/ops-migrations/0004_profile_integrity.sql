CREATE TABLE profiles_next (
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

INSERT INTO profiles_next (wallet, email, created_at_ms, updated_at_ms)
SELECT wallet, email, created_at_ms, updated_at_ms
FROM profiles;

CREATE TABLE profile_addresses_next (
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
  FOREIGN KEY (wallet) REFERENCES profiles_next(wallet) ON DELETE CASCADE
) STRICT;

INSERT INTO profile_addresses_next (
  wallet,
  address_id,
  encrypted,
  country,
  country_code,
  hint,
  email,
  label,
  created_at_ms,
  updated_at_ms
)
SELECT
  wallet,
  address_id,
  encrypted,
  country,
  country_code,
  hint,
  email,
  label,
  created_at_ms,
  updated_at_ms
FROM profile_addresses;

DROP TABLE profile_addresses;
DROP TABLE profiles;

ALTER TABLE profiles_next RENAME TO profiles;
ALTER TABLE profile_addresses_next RENAME TO profile_addresses;

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
      label IS NEW.label AND
      created_at_ms IS NEW.created_at_ms AND
      updated_at_ms IS NEW.updated_at_ms
    )
)
BEGIN
  SELECT RAISE(ABORT, 'profile address id conflict');
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
    label IS NEW.label AND
    created_at_ms IS NEW.created_at_ms AND
    updated_at_ms IS NEW.updated_at_ms
)
BEGIN
  SELECT RAISE(IGNORE);
END;
