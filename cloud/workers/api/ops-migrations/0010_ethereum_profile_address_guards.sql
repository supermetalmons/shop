CREATE TRIGGER ethereum_profile_address_conflict_guard
BEFORE INSERT ON ethereum_profile_addresses
WHEN EXISTS (
  SELECT 1 FROM ethereum_profile_addresses
  WHERE wallet = NEW.wallet AND address_id = NEW.address_id
    AND NOT (
      json_extract(address_json, '$.id') IS json_extract(NEW.address_json, '$.id') AND
      json_extract(address_json, '$.encrypted') IS json_extract(NEW.address_json, '$.encrypted') AND
      json_extract(address_json, '$.country') IS json_extract(NEW.address_json, '$.country') AND
      json_extract(address_json, '$.countryCode') IS json_extract(NEW.address_json, '$.countryCode') AND
      json_extract(address_json, '$.hint') IS json_extract(NEW.address_json, '$.hint') AND
      json_extract(address_json, '$.email') IS json_extract(NEW.address_json, '$.email')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'profile address id conflict');
END;

CREATE TRIGGER ethereum_profile_address_idempotent_insert
BEFORE INSERT ON ethereum_profile_addresses
WHEN EXISTS (
  SELECT 1 FROM ethereum_profile_addresses
  WHERE wallet = NEW.wallet AND address_id = NEW.address_id
    AND json_extract(address_json, '$.id') IS json_extract(NEW.address_json, '$.id')
    AND json_extract(address_json, '$.encrypted') IS json_extract(NEW.address_json, '$.encrypted')
    AND json_extract(address_json, '$.country') IS json_extract(NEW.address_json, '$.country')
    AND json_extract(address_json, '$.countryCode') IS json_extract(NEW.address_json, '$.countryCode')
    AND json_extract(address_json, '$.hint') IS json_extract(NEW.address_json, '$.hint')
    AND json_extract(address_json, '$.email') IS json_extract(NEW.address_json, '$.email')
)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER ethereum_profile_address_update_guard
BEFORE UPDATE ON ethereum_profile_addresses
BEGIN
  SELECT RAISE(ABORT, 'profile addresses are immutable');
END;

CREATE TRIGGER ethereum_profile_address_delete_guard
BEFORE DELETE ON ethereum_profile_addresses
BEGIN
  SELECT RAISE(ABORT, 'profile addresses are immutable');
END;
