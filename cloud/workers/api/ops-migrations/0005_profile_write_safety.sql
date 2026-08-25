DROP TRIGGER profile_address_conflict_guard;
DROP TRIGGER profile_address_idempotent_insert;

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

CREATE TRIGGER profile_address_delete_guard
BEFORE DELETE ON profile_addresses
BEGIN
  SELECT RAISE(ABORT, 'profile addresses are immutable');
END;

CREATE TRIGGER profile_delete_guard
BEFORE DELETE ON profiles
BEGIN
  SELECT RAISE(ABORT, 'profiles cannot be deleted');
END;
