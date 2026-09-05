ALTER TABLE commerce_authority_control
ADD COLUMN dude_inventory_mode TEXT NOT NULL DEFAULT 'legacy'
  CHECK (dude_inventory_mode IN ('legacy', 'rows'));

CREATE TABLE commerce_inventory_drops (
  drop_id TEXT PRIMARY KEY CHECK (length(drop_id) BETWEEN 1 AND 64),
  generation TEXT NOT NULL CHECK (length(generation) = 36),
  ready INTEGER NOT NULL CHECK (ready IN (0, 1)),
  drop_family TEXT NOT NULL CHECK (length(drop_family) BETWEEN 1 AND 64),
  items_per_box INTEGER NOT NULL CHECK (items_per_box BETWEEN 1 AND 9007199254740991),
  max_dude_id INTEGER NOT NULL CHECK (max_dude_id BETWEEN items_per_box AND 9007199254740991),
  initialized_at_ms INTEGER NOT NULL CHECK (initialized_at_ms BETWEEN 0 AND 9007199254740991)
) STRICT;

CREATE TABLE commerce_available_dudes (
  drop_id TEXT NOT NULL REFERENCES commerce_inventory_drops(drop_id) ON DELETE CASCADE,
  dude_id INTEGER NOT NULL CHECK (dude_id BETWEEN 1 AND 9007199254740991),
  pool_position INTEGER NOT NULL CHECK (pool_position BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (drop_id, dude_id),
  UNIQUE (drop_id, pool_position)
) STRICT;

CREATE TRIGGER commerce_inventory_drop_insert_guard
BEFORE INSERT ON commerce_inventory_drops
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM commerce_authority_control AS authority
    JOIN commerce_authority_control_lease AS lease ON lease.singleton = authority.singleton
    WHERE authority.singleton = 1 AND authority.authority_state = 'paused'
      AND authority.paused_at_ms IS NOT NULL
      AND lease.expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ) THEN RAISE(ABORT, 'commerce inventory maintenance is not ready') END);
  SELECT (CASE WHEN NEW.ready <> 0
    THEN RAISE(ABORT, 'commerce inventory must be initialized before ready') END);
END;

CREATE TRIGGER commerce_inventory_drop_update_guard
BEFORE UPDATE ON commerce_inventory_drops
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM commerce_authority_control AS authority
    JOIN commerce_authority_control_lease AS lease ON lease.singleton = authority.singleton
    WHERE authority.singleton = 1 AND authority.authority_state = 'paused'
      AND authority.paused_at_ms IS NOT NULL
      AND lease.expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ) THEN RAISE(ABORT, 'commerce inventory maintenance is not ready') END);
  SELECT (CASE WHEN OLD.ready = 1 OR NEW.ready <> 1 OR
    NEW.drop_id IS NOT OLD.drop_id OR NEW.generation IS NOT OLD.generation OR
    NEW.drop_family IS NOT OLD.drop_family OR NEW.items_per_box IS NOT OLD.items_per_box OR
    NEW.max_dude_id IS NOT OLD.max_dude_id OR NEW.initialized_at_ms IS NOT OLD.initialized_at_ms
    THEN RAISE(ABORT, 'commerce inventory metadata is immutable') END);
END;

CREATE TRIGGER commerce_inventory_drop_delete_guard
BEFORE DELETE ON commerce_inventory_drops
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM commerce_authority_control AS authority
    JOIN commerce_authority_control_lease AS lease ON lease.singleton = authority.singleton
    WHERE authority.singleton = 1 AND authority.authority_state = 'paused'
      AND authority.paused_at_ms IS NOT NULL
      AND lease.expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ) THEN RAISE(ABORT, 'commerce inventory maintenance is not ready') END);
END;

CREATE TRIGGER commerce_available_dude_insert_guard
BEFORE INSERT ON commerce_available_dudes
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM commerce_authority_control AS authority
    JOIN commerce_authority_control_lease AS lease ON lease.singleton = authority.singleton
    WHERE authority.singleton = 1 AND authority.authority_state = 'paused'
      AND authority.paused_at_ms IS NOT NULL
      AND lease.expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ) THEN RAISE(ABORT, 'commerce inventory maintenance is not ready') END);
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM commerce_inventory_drops
    WHERE drop_id = NEW.drop_id AND ready = 0 AND NEW.dude_id <= max_dude_id
  ) OR EXISTS (
    SELECT 1 FROM commerce_documents
    WHERE document_path = 'drops/' || NEW.drop_id || '/dudeAssignments/' || NEW.dude_id
      AND document_kind = 'dude_assignment' AND drop_id = NEW.drop_id
      AND document_id = CAST(NEW.dude_id AS TEXT)
  ) THEN RAISE(ABORT, 'commerce inventory item is invalid or already assigned') END);
END;

CREATE TRIGGER commerce_available_dude_update_guard
BEFORE UPDATE ON commerce_available_dudes
BEGIN
  SELECT RAISE(ABORT, 'commerce inventory items are immutable');
END;

CREATE TRIGGER commerce_available_dude_delete_guard
BEFORE DELETE ON commerce_available_dudes
WHEN NOT EXISTS (
  SELECT 1 FROM commerce_authority_control AS authority
  JOIN commerce_authority_control_lease AS lease ON lease.singleton = authority.singleton
  WHERE authority.singleton = 1 AND authority.authority_state = 'paused'
    AND authority.paused_at_ms IS NOT NULL
    AND lease.expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
)
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM commerce_authority_control AS authority
    JOIN commerce_inventory_drops AS inventory ON inventory.drop_id = OLD.drop_id
    JOIN commerce_documents AS assignment
      ON assignment.document_path = 'drops/' || OLD.drop_id || '/dudeAssignments/' || OLD.dude_id
      AND assignment.document_kind = 'dude_assignment'
      AND assignment.drop_id = OLD.drop_id
      AND assignment.document_id = CAST(OLD.dude_id AS TEXT)
    WHERE authority.singleton = 1 AND authority.authority_state = 'd1'
      AND authority.dude_inventory_mode = 'rows' AND inventory.ready = 1
      AND json_extract(assignment.document_json, '$.inventoryGeneration') = inventory.generation
  ) THEN RAISE(ABORT, 'commerce inventory removal requires an assignment') END);
END;

CREATE TRIGGER commerce_dude_inventory_mode_guard
BEFORE UPDATE OF dude_inventory_mode ON commerce_authority_control
WHEN NEW.dude_inventory_mode IS NOT OLD.dude_inventory_mode
BEGIN
  SELECT (CASE WHEN OLD.dude_inventory_mode <> 'legacy' OR NEW.dude_inventory_mode <> 'rows'
    THEN RAISE(ABORT, 'commerce inventory mode cannot move backward') END);
  SELECT (CASE WHEN OLD.authority_state <> 'paused' OR OLD.paused_at_ms IS NULL OR
    NEW.authority_state <> 'paused' OR NEW.paused_at_ms IS NULL OR NOT EXISTS (
      SELECT 1 FROM commerce_authority_control_lease
      WHERE singleton = 1 AND expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
    ) THEN RAISE(ABORT, 'commerce inventory maintenance is not ready') END);
  SELECT (CASE WHEN EXISTS (SELECT 1 FROM commerce_inventory_drops WHERE ready <> 1) OR EXISTS (
    SELECT 1 FROM commerce_documents AS document
    LEFT JOIN commerce_inventory_drops AS inventory ON inventory.drop_id = document.drop_id
    WHERE document.document_kind IN ('dude_pool', 'dude_assignment', 'box_assignment')
      AND (inventory.drop_id IS NULL OR inventory.ready <> 1)
  ) OR EXISTS (
    SELECT 1 FROM commerce_available_dudes AS available
    JOIN commerce_documents AS assignment
      ON assignment.document_kind = 'dude_assignment'
      AND assignment.drop_id = available.drop_id
      AND assignment.document_id = CAST(available.dude_id AS TEXT)
  ) THEN RAISE(ABORT, 'commerce inventory initialization is incomplete') END);
END;

CREATE TRIGGER commerce_dude_inventory_resume_guard
BEFORE UPDATE OF authority_state ON commerce_authority_control
WHEN NEW.authority_state = 'd1'
  AND EXISTS (SELECT 1 FROM commerce_inventory_drops WHERE ready <> 1)
BEGIN
  SELECT RAISE(ABORT, 'commerce inventory initialization is incomplete');
END;

CREATE TRIGGER commerce_dude_pool_insert_fence
BEFORE INSERT ON commerce_documents
WHEN NEW.document_kind = 'dude_pool'
  AND (SELECT dude_inventory_mode FROM commerce_authority_control WHERE singleton = 1) = 'rows'
BEGIN
  SELECT RAISE(ABORT, 'legacy commerce inventory writes are disabled');
END;

CREATE TRIGGER commerce_dude_pool_update_fence
BEFORE UPDATE ON commerce_documents
WHEN (OLD.document_kind = 'dude_pool' OR NEW.document_kind = 'dude_pool')
  AND (SELECT dude_inventory_mode FROM commerce_authority_control WHERE singleton = 1) = 'rows'
BEGIN
  SELECT RAISE(ABORT, 'legacy commerce inventory writes are disabled');
END;

CREATE TRIGGER commerce_dude_assignment_inventory_guard
BEFORE INSERT ON commerce_documents
WHEN NEW.document_kind = 'dude_assignment'
  AND (SELECT dude_inventory_mode FROM commerce_authority_control WHERE singleton = 1) = 'rows'
BEGIN
  SELECT (CASE WHEN
    NEW.document_id <> CAST(CAST(NEW.document_id AS INTEGER) AS TEXT) OR
    json_type(NEW.document_json, '$.dudeId') IS NOT 'integer' OR
    json_extract(NEW.document_json, '$.dudeId') <> CAST(NEW.document_id AS INTEGER) OR
    json_type(NEW.document_json, '$.boxAssetId') IS NOT 'text' OR
    length(json_extract(NEW.document_json, '$.boxAssetId')) NOT BETWEEN 1 AND 128
    THEN RAISE(ABORT, 'commerce inventory assignment is invalid') END);
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM commerce_inventory_drops AS inventory
    JOIN commerce_available_dudes AS available ON available.drop_id = inventory.drop_id
    WHERE inventory.drop_id = NEW.drop_id AND inventory.ready = 1
      AND json_type(NEW.document_json, '$.inventoryGeneration') = 'text'
      AND json_extract(NEW.document_json, '$.inventoryGeneration') = inventory.generation
      AND available.dude_id = CAST(NEW.document_id AS INTEGER)
  ) THEN RAISE(ABORT, 'commerce transaction conflict: inventory item is unavailable') END);
END;

CREATE TRIGGER commerce_dude_assignment_consume_inventory
AFTER INSERT ON commerce_documents
WHEN NEW.document_kind = 'dude_assignment'
  AND (SELECT dude_inventory_mode FROM commerce_authority_control WHERE singleton = 1) = 'rows'
BEGIN
  DELETE FROM commerce_available_dudes
  WHERE drop_id = NEW.drop_id AND dude_id = CAST(NEW.document_id AS INTEGER);
END;

CREATE TRIGGER commerce_dude_assignment_update_guard
BEFORE UPDATE ON commerce_documents
WHEN (OLD.document_kind = 'dude_assignment' OR NEW.document_kind = 'dude_assignment')
  AND (SELECT dude_inventory_mode FROM commerce_authority_control WHERE singleton = 1) = 'rows'
  AND (
    NEW.document_kind IS NOT OLD.document_kind OR NEW.document_path IS NOT OLD.document_path OR
    NEW.drop_id IS NOT OLD.drop_id OR NEW.document_id IS NOT OLD.document_id OR
    json_extract(NEW.document_json, '$.dudeId') IS NOT json_extract(OLD.document_json, '$.dudeId') OR
    json_extract(NEW.document_json, '$.boxAssetId') IS NOT json_extract(OLD.document_json, '$.boxAssetId') OR
    json_extract(NEW.document_json, '$.inventoryGeneration') IS NOT json_extract(OLD.document_json, '$.inventoryGeneration')
  )
BEGIN
  SELECT RAISE(ABORT, 'commerce inventory assignment ownership is immutable');
END;

CREATE TRIGGER commerce_dude_assignment_delete_guard
BEFORE DELETE ON commerce_documents
WHEN OLD.document_kind = 'dude_assignment'
  AND (SELECT dude_inventory_mode FROM commerce_authority_control WHERE singleton = 1) = 'rows'
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM commerce_authority_control AS authority
    JOIN commerce_authority_control_lease AS lease ON lease.singleton = authority.singleton
    WHERE authority.singleton = 1 AND authority.authority_state = 'paused'
      AND authority.paused_at_ms IS NOT NULL
      AND lease.expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ) THEN RAISE(ABORT, 'commerce inventory maintenance is not ready') END);
END;

PRAGMA optimize;
