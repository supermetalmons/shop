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

CREATE TABLE reveal_submission_storage_control (
  singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
  paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
  storage_source TEXT NOT NULL CHECK (storage_source IN ('firestore', 'd1')),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (
    updated_at_ms BETWEEN created_at_ms AND 9007199254740991
  ),
  cutover_at_ms INTEGER CHECK (
    cutover_at_ms IS NULL OR
    cutover_at_ms BETWEEN created_at_ms AND updated_at_ms
  ),
  CHECK (
    (storage_source = 'firestore' AND cutover_at_ms IS NULL) OR
    (storage_source = 'd1' AND cutover_at_ms IS NOT NULL)
  )
) STRICT;

INSERT INTO reveal_submission_storage_control (
  singleton,
  paused,
  storage_source,
  revision,
  created_at_ms,
  updated_at_ms,
  cutover_at_ms
)
VALUES (1, 1, 'firestore', 1, 0, 0, NULL);

CREATE TRIGGER reveal_submission_storage_update_guard
BEFORE UPDATE ON reveal_submission_storage_control
WHEN
  NEW.singleton <> 1 OR
  NEW.revision <> OLD.revision + 1 OR
  NEW.updated_at_ms < OLD.updated_at_ms OR
  (OLD.storage_source = 'd1' AND NEW.storage_source <> 'd1') OR
  (OLD.storage_source = 'firestore' AND NEW.storage_source NOT IN ('firestore', 'd1')) OR
  (NEW.storage_source <> OLD.storage_source AND (OLD.paused <> 1 OR NEW.paused <> 1))
BEGIN
  SELECT RAISE(ABORT, 'invalid reveal-submission storage update');
END;

CREATE TRIGGER reveal_submission_storage_delete_guard
BEFORE DELETE ON reveal_submission_storage_control
BEGIN
  SELECT RAISE(ABORT, 'reveal-submission storage control is immutable');
END;

CREATE TRIGGER reveal_submission_storage_insert_guard
BEFORE INSERT ON reveal_submission_storage_control
BEGIN
  SELECT RAISE(ABORT, 'reveal-submission storage control is immutable');
END;
