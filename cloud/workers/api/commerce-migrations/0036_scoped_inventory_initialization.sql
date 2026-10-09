CREATE TABLE commerce_inventory_initializations (
  drop_id TEXT PRIMARY KEY CHECK (length(drop_id) BETWEEN 1 AND 64)
    REFERENCES commerce_inventory_drops(drop_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  generation TEXT NOT NULL CHECK (length(generation) = 36),
  lease_token TEXT NOT NULL CHECK (length(lease_token) = 36),
  authority_revision INTEGER NOT NULL CHECK (authority_revision >= 1),
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  catalog_sha256 TEXT NOT NULL CHECK (length(catalog_sha256) = 64 AND catalog_sha256 NOT GLOB '*[^0-9a-f]*'),
  preorder_snapshot_sha256 TEXT NOT NULL CHECK (length(preorder_snapshot_sha256) = 64 AND preorder_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
  source_preorder_id TEXT NOT NULL CHECK (length(source_preorder_id) BETWEEN 1 AND 80),
  source_cluster TEXT NOT NULL CHECK (source_cluster IN ('devnet', 'mainnet-beta')),
  source_collection TEXT NOT NULL CHECK (length(source_collection) BETWEEN 32 AND 44),
  drop_family TEXT NOT NULL CHECK (drop_family = 'mi_note_cards'),
  items_per_box INTEGER NOT NULL CHECK (items_per_box = 2),
  pack_count INTEGER NOT NULL CHECK (pack_count BETWEEN 1 AND 32767),
  max_dude_id INTEGER NOT NULL CHECK (max_dude_id BETWEEN pack_count * items_per_box AND 65535),
  excluded_card_ids_json TEXT NOT NULL CHECK (json_valid(excluded_card_ids_json) AND json_type(excluded_card_ids_json) = 'array'),
  eligible_card_ids_json TEXT NOT NULL CHECK (json_valid(eligible_card_ids_json) AND json_type(eligible_card_ids_json) = 'array'
    AND json_array_length(eligible_card_ids_json) = pack_count * items_per_box),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms BETWEEN created_at_ms AND 9007199254740991)
) STRICT;

CREATE TRIGGER commerce_inventory_initialization_insert_guard
BEFORE INSERT ON commerce_inventory_initializations
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM commerce_authority_control AS authority
    JOIN commerce_authority_control_lease AS lease ON lease.singleton = authority.singleton
    WHERE authority.singleton = 1 AND authority.authority_state = 'd1' AND authority.paused_at_ms IS NULL
      AND authority.dude_inventory_mode = 'rows' AND authority.revision = NEW.authority_revision
      AND lease.lease_token = NEW.lease_token
      AND lease.expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ) THEN RAISE(ABORT, 'new inventory requires active authority and its coordination lease') END);
  SELECT (CASE WHEN NEW.completed_at_ms IS NOT NULL OR
    NEW.created_at_ms <> CAST(strftime('%s', 'now') AS INTEGER) * 1000 OR
    EXISTS (SELECT 1 FROM commerce_inventory_drops WHERE drop_id = NEW.drop_id) OR
    EXISTS (SELECT 1 FROM commerce_documents WHERE drop_id = NEW.drop_id) OR
    EXISTS (SELECT 1 FROM commerce_documents
      WHERE document_kind = 'claim_code' AND json_extract(document_json, '$.dropId') = NEW.drop_id) OR
    EXISTS (SELECT 1 FROM commerce_document_path_revisions
      WHERE substr(document_path, 1, length('drops/' || NEW.drop_id || '/')) = 'drops/' || NEW.drop_id || '/') OR
    EXISTS (SELECT 1 FROM commerce_wipe_guards)
    THEN RAISE(ABORT, 'online initialization requires a new drop without public commerce history') END);
  SELECT (CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.eligible_card_ids_json)
    WHERE type <> 'integer' OR value < 1 OR value > NEW.max_dude_id
      OR (key > 0 AND value <= json_extract(NEW.eligible_card_ids_json, '$[' || (key - 1) || ']'))
  ) OR EXISTS (
    SELECT 1 FROM json_each(NEW.excluded_card_ids_json)
    WHERE type <> 'integer' OR value < 1 OR value > NEW.max_dude_id
      OR (key > 0 AND value <= json_extract(NEW.excluded_card_ids_json, '$[' || (key - 1) || ']'))
  ) OR EXISTS (
    SELECT 1 FROM json_each(NEW.eligible_card_ids_json) AS eligible
    JOIN json_each(NEW.excluded_card_ids_json) AS excluded ON excluded.value = eligible.value
  ) THEN RAISE(ABORT, 'new inventory manifest card IDs are invalid') END);
  SELECT (CASE WHEN EXISTS (
    SELECT 1 FROM commerce_preorder_orders
    WHERE cluster = NEW.source_cluster AND collection = NEW.source_collection
      AND (preorder_id <> NEW.source_preorder_id OR status IN ('prepared', 'submitted'))
  ) OR (SELECT COUNT(*) FROM commerce_preorder_claims
    WHERE cluster = NEW.source_cluster AND collection = NEW.source_collection) <> json_array_length(NEW.excluded_card_ids_json)
  OR EXISTS (
    SELECT 1 FROM commerce_preorder_claims AS claim
    LEFT JOIN commerce_preorder_orders AS preorder ON preorder.order_id = claim.order_id
    WHERE claim.cluster = NEW.source_cluster AND claim.collection = NEW.source_collection AND (
      preorder.order_id IS NULL OR preorder.status <> 'succeeded' OR preorder.preorder_id <> NEW.source_preorder_id
      OR preorder.cluster <> claim.cluster OR preorder.collection <> claim.collection
      OR NOT EXISTS (SELECT 1 FROM json_each(NEW.excluded_card_ids_json) WHERE value = claim.card_id)
      OR NOT EXISTS (SELECT 1 FROM json_each(preorder.card_ids_json) WHERE value = claim.card_id)
    )
  ) OR EXISTS (
    SELECT 1 FROM commerce_preorder_orders AS preorder JOIN json_each(preorder.card_ids_json) AS card
    WHERE preorder.cluster = NEW.source_cluster AND preorder.collection = NEW.source_collection
      AND preorder.status = 'succeeded' AND NOT EXISTS (
        SELECT 1 FROM commerce_preorder_claims AS claim
        WHERE claim.cluster = preorder.cluster AND claim.collection = preorder.collection
          AND claim.order_id = preorder.order_id AND claim.card_id = card.value
      )
  ) THEN RAISE(ABORT, 'preorder exclusions changed or contain unresolved orders') END);
END;

CREATE TRIGGER commerce_inventory_initialization_update_guard
BEFORE UPDATE ON commerce_inventory_initializations
BEGIN
  SELECT (CASE WHEN OLD.completed_at_ms IS NOT NULL OR
    NEW.completed_at_ms IS NULL OR NEW.completed_at_ms <> CAST(strftime('%s', 'now') AS INTEGER) * 1000 OR
    NEW.drop_id IS NOT OLD.drop_id OR NEW.generation IS NOT OLD.generation OR NEW.lease_token IS NOT OLD.lease_token OR
    NEW.authority_revision IS NOT OLD.authority_revision OR NEW.manifest_sha256 IS NOT OLD.manifest_sha256 OR
    NEW.catalog_sha256 IS NOT OLD.catalog_sha256 OR NEW.preorder_snapshot_sha256 IS NOT OLD.preorder_snapshot_sha256 OR
    NEW.source_preorder_id IS NOT OLD.source_preorder_id OR NEW.source_cluster IS NOT OLD.source_cluster OR
    NEW.source_collection IS NOT OLD.source_collection OR NEW.drop_family IS NOT OLD.drop_family OR
    NEW.items_per_box IS NOT OLD.items_per_box OR NEW.pack_count IS NOT OLD.pack_count OR NEW.max_dude_id IS NOT OLD.max_dude_id OR
    NEW.excluded_card_ids_json IS NOT OLD.excluded_card_ids_json OR NEW.eligible_card_ids_json IS NOT OLD.eligible_card_ids_json OR
    NEW.created_at_ms IS NOT OLD.created_at_ms OR NOT EXISTS (
      SELECT 1 FROM commerce_inventory_drops AS inventory
      JOIN commerce_authority_control AS authority ON authority.singleton = 1
      JOIN commerce_authority_control_lease AS lease ON lease.singleton = authority.singleton
      WHERE inventory.drop_id = NEW.drop_id AND inventory.generation = NEW.generation AND inventory.ready = 1
        AND authority.authority_state = 'd1' AND authority.dude_inventory_mode = 'rows'
        AND authority.revision = NEW.authority_revision AND lease.lease_token = NEW.lease_token
        AND lease.expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
    ) THEN RAISE(ABORT, 'inventory initialization record is immutable') END);
END;

CREATE TRIGGER commerce_inventory_initialization_delete_guard
BEFORE DELETE ON commerce_inventory_initializations
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM commerce_authority_control AS authority
    JOIN commerce_authority_control_lease AS lease ON lease.singleton = authority.singleton
    WHERE authority.singleton = 1 AND authority.authority_state = 'paused' AND authority.paused_at_ms IS NOT NULL
      AND lease.expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ) THEN RAISE(ABORT, 'commerce inventory maintenance is not ready') END);
END;

DROP TRIGGER commerce_inventory_drop_insert_guard;
CREATE TRIGGER commerce_inventory_drop_insert_guard
BEFORE INSERT ON commerce_inventory_drops
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM commerce_authority_control AS authority
    JOIN commerce_authority_control_lease AS lease ON lease.singleton = authority.singleton
    WHERE authority.singleton = 1 AND lease.expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000 AND (
      (authority.authority_state = 'paused' AND authority.paused_at_ms IS NOT NULL) OR
      (authority.authority_state = 'd1' AND authority.paused_at_ms IS NULL AND authority.dude_inventory_mode = 'rows' AND EXISTS (
        SELECT 1 FROM commerce_inventory_initializations AS initialization
        WHERE initialization.drop_id = NEW.drop_id AND initialization.generation = NEW.generation
          AND initialization.lease_token = lease.lease_token AND initialization.authority_revision = authority.revision
          AND initialization.completed_at_ms IS NULL AND initialization.drop_family = NEW.drop_family
          AND initialization.items_per_box = NEW.items_per_box AND initialization.max_dude_id = NEW.max_dude_id
          AND initialization.created_at_ms = NEW.initialized_at_ms
      ))
    )
  ) THEN RAISE(ABORT, 'commerce inventory maintenance is not ready') END);
  SELECT (CASE WHEN NEW.ready <> 0
    THEN RAISE(ABORT, 'commerce inventory must be initialized before ready') END);
END;

DROP TRIGGER commerce_available_dude_insert_guard;
CREATE TRIGGER commerce_available_dude_insert_guard
BEFORE INSERT ON commerce_available_dudes
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM commerce_authority_control AS authority
    JOIN commerce_authority_control_lease AS lease ON lease.singleton = authority.singleton
    WHERE authority.singleton = 1 AND lease.expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000 AND (
      (authority.authority_state = 'paused' AND authority.paused_at_ms IS NOT NULL) OR
      (authority.authority_state = 'd1' AND authority.paused_at_ms IS NULL AND authority.dude_inventory_mode = 'rows' AND EXISTS (
        SELECT 1 FROM commerce_inventory_initializations AS initialization
        JOIN commerce_inventory_drops AS inventory ON inventory.drop_id = initialization.drop_id
        WHERE initialization.drop_id = NEW.drop_id AND initialization.generation = inventory.generation
          AND initialization.lease_token = lease.lease_token AND initialization.authority_revision = authority.revision
          AND initialization.completed_at_ms IS NULL AND inventory.ready = 0
          AND json_extract(initialization.eligible_card_ids_json, '$[' || NEW.pool_position || ']') = NEW.dude_id
      ))
    )
  ) THEN RAISE(ABORT, 'commerce inventory maintenance is not ready') END);
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM commerce_inventory_drops
    WHERE drop_id = NEW.drop_id AND ready = 0 AND NEW.dude_id <= max_dude_id
  ) OR EXISTS (
    SELECT 1 FROM commerce_documents
    WHERE document_path = 'drops/' || NEW.drop_id || '/dudeAssignments/' || NEW.dude_id
      AND document_kind = 'dude_assignment' AND drop_id = NEW.drop_id AND document_id = CAST(NEW.dude_id AS TEXT)
  ) THEN RAISE(ABORT, 'commerce inventory item is invalid or already assigned') END);
END;

DROP TRIGGER commerce_inventory_drop_update_guard;
CREATE TRIGGER commerce_inventory_drop_update_guard
BEFORE UPDATE ON commerce_inventory_drops
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM commerce_authority_control AS authority
    JOIN commerce_authority_control_lease AS lease ON lease.singleton = authority.singleton
    WHERE authority.singleton = 1 AND lease.expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000 AND (
      (authority.authority_state = 'paused' AND authority.paused_at_ms IS NOT NULL) OR
      (authority.authority_state = 'd1' AND authority.paused_at_ms IS NULL AND authority.dude_inventory_mode = 'rows' AND EXISTS (
        SELECT 1 FROM commerce_inventory_initializations AS initialization
        WHERE initialization.drop_id = NEW.drop_id AND initialization.generation = NEW.generation
          AND initialization.lease_token = lease.lease_token AND initialization.authority_revision = authority.revision
          AND initialization.completed_at_ms IS NULL
          AND (SELECT COUNT(*) FROM commerce_available_dudes WHERE drop_id = NEW.drop_id) = json_array_length(initialization.eligible_card_ids_json)
          AND NOT EXISTS (
            SELECT 1 FROM json_each(initialization.eligible_card_ids_json) AS expected
            LEFT JOIN commerce_available_dudes AS available
              ON available.drop_id = NEW.drop_id AND available.dude_id = expected.value AND available.pool_position = expected.key
            WHERE available.dude_id IS NULL
          )
      ))
    )
  ) THEN RAISE(ABORT, 'commerce inventory maintenance is not ready') END);
  SELECT (CASE WHEN OLD.ready = 1 OR NEW.ready <> 1 OR
    NEW.drop_id IS NOT OLD.drop_id OR NEW.generation IS NOT OLD.generation OR
    NEW.drop_family IS NOT OLD.drop_family OR NEW.items_per_box IS NOT OLD.items_per_box OR
    NEW.max_dude_id IS NOT OLD.max_dude_id OR NEW.initialized_at_ms IS NOT OLD.initialized_at_ms
    THEN RAISE(ABORT, 'commerce inventory metadata is immutable') END);
END;

CREATE TRIGGER commerce_inventory_initialization_apply
AFTER INSERT ON commerce_inventory_initializations
BEGIN
  INSERT INTO commerce_inventory_drops (
    drop_id, generation, ready, drop_family, items_per_box, max_dude_id, initialized_at_ms
  ) VALUES (NEW.drop_id, NEW.generation, 0, NEW.drop_family, NEW.items_per_box, NEW.max_dude_id, NEW.created_at_ms);
  INSERT INTO commerce_available_dudes (drop_id, dude_id, pool_position)
    SELECT NEW.drop_id, value, key FROM json_each(NEW.eligible_card_ids_json);
  UPDATE commerce_inventory_drops SET ready = 1 WHERE drop_id = NEW.drop_id AND generation = NEW.generation;
  UPDATE commerce_inventory_initializations SET completed_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
    WHERE drop_id = NEW.drop_id AND generation = NEW.generation;
END;
