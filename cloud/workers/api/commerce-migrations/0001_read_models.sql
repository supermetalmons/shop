CREATE TABLE commerce_read_model_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  read_source TEXT NOT NULL CHECK (read_source IN ('firestore', 'dual', 'd1')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  dual_started_at_ms INTEGER CHECK (dual_started_at_ms IS NULL OR dual_started_at_ms >= 0),
  dual_started_cycle INTEGER CHECK (dual_started_cycle IS NULL OR dual_started_cycle >= 0),
  mismatch_count INTEGER NOT NULL CHECK (mismatch_count >= 0),
  last_mismatch_at_ms INTEGER CHECK (last_mismatch_at_ms IS NULL OR last_mismatch_at_ms >= 0),
  last_verified_at_ms INTEGER CHECK (last_verified_at_ms IS NULL OR last_verified_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;

INSERT INTO commerce_read_model_control (
  singleton,
  read_source,
  revision,
  dual_started_at_ms,
  dual_started_cycle,
  mismatch_count,
  last_mismatch_at_ms,
  last_verified_at_ms,
  updated_at_ms
) VALUES (1, 'firestore', 1, NULL, NULL, 0, NULL, NULL, 0);

CREATE TABLE commerce_read_model_reconciliation (
  document_kind TEXT PRIMARY KEY CHECK (document_kind IN ('delivery_order', 'stripe_checkout')),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  cursor_path TEXT,
  lease_id TEXT,
  lease_expires_at_ms INTEGER CHECK (lease_expires_at_ms IS NULL OR lease_expires_at_ms >= 0),
  cycle_started_at_ms INTEGER NOT NULL CHECK (cycle_started_at_ms >= 0),
  completed_cycles INTEGER NOT NULL CHECK (completed_cycles >= 0),
  last_completed_at_ms INTEGER CHECK (last_completed_at_ms IS NULL OR last_completed_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  CHECK ((lease_id IS NULL) = (lease_expires_at_ms IS NULL))
) STRICT;

INSERT INTO commerce_read_model_reconciliation (
  document_kind,
  generation,
  cursor_path,
  lease_id,
  lease_expires_at_ms,
  cycle_started_at_ms,
  completed_cycles,
  last_completed_at_ms,
  updated_at_ms
) VALUES
  ('delivery_order', 1, NULL, NULL, NULL, 0, 0, NULL, 0),
  ('stripe_checkout', 1, NULL, NULL, NULL, 0, 0, NULL, 0);

CREATE TABLE delivery_order_read_models (
  drop_id TEXT NOT NULL CHECK (length(drop_id) BETWEEN 1 AND 64),
  delivery_id INTEGER NOT NULL CHECK (delivery_id > 0),
  document_id TEXT NOT NULL,
  document_path TEXT NOT NULL UNIQUE,
  fields_json TEXT NOT NULL CHECK (json_valid(fields_json)),
  owner TEXT,
  source TEXT,
  status TEXT,
  created_at_ms INTEGER CHECK (created_at_ms IS NULL OR created_at_ms >= 0),
  processing_at_ms INTEGER CHECK (processing_at_ms IS NULL OR processing_at_ms >= 0),
  processed_at_ms INTEGER CHECK (processed_at_ms IS NULL OR processed_at_ms >= 0),
  processed_at_seconds INTEGER CHECK (processed_at_seconds IS NULL OR processed_at_seconds >= 0),
  processed_at_nanos INTEGER CHECK (processed_at_nanos IS NULL OR processed_at_nanos BETWEEN 0 AND 999999999),
  fulfillment_status TEXT,
  fulfillment_updated_at_ms INTEGER CHECK (fulfillment_updated_at_ms IS NULL OR fulfillment_updated_at_ms >= 0),
  source_create_time TEXT,
  source_update_time TEXT NOT NULL,
  source_update_seconds INTEGER NOT NULL CHECK (source_update_seconds >= 0),
  source_update_nanos INTEGER NOT NULL CHECK (source_update_nanos BETWEEN 0 AND 999999999),
  seen_generation INTEGER NOT NULL CHECK (seen_generation >= 1),
  projected_at_ms INTEGER NOT NULL CHECK (projected_at_ms >= 0),
  PRIMARY KEY (drop_id, delivery_id),
  CHECK ((processed_at_seconds IS NULL) = (processed_at_nanos IS NULL))
) STRICT;

CREATE INDEX delivery_order_read_models_owner_status_sort
  ON delivery_order_read_models (
    owner,
    status,
    processed_at_ms DESC,
    processing_at_ms DESC,
    created_at_ms DESC,
    drop_id,
    delivery_id
  );

CREATE INDEX delivery_order_read_models_document_path
  ON delivery_order_read_models (document_path);

CREATE INDEX delivery_order_read_models_fulfillment
  ON delivery_order_read_models (
    drop_id,
    status,
    processed_at_seconds DESC,
    processed_at_nanos DESC,
    document_path DESC
  );

CREATE TABLE stripe_checkout_read_models (
  drop_id TEXT NOT NULL CHECK (length(drop_id) BETWEEN 1 AND 64),
  session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 256),
  document_path TEXT NOT NULL UNIQUE,
  fields_json TEXT NOT NULL CHECK (json_valid(fields_json)),
  owner TEXT,
  status TEXT,
  manual_refund_review_required INTEGER NOT NULL CHECK (manual_refund_review_required IN (0, 1)),
  created_at_ms INTEGER CHECK (created_at_ms IS NULL OR created_at_ms >= 0),
  failed_at_ms INTEGER CHECK (failed_at_ms IS NULL OR failed_at_ms >= 0),
  source_create_time TEXT,
  source_update_time TEXT NOT NULL,
  source_update_seconds INTEGER NOT NULL CHECK (source_update_seconds >= 0),
  source_update_nanos INTEGER NOT NULL CHECK (source_update_nanos BETWEEN 0 AND 999999999),
  seen_generation INTEGER NOT NULL CHECK (seen_generation >= 1),
  projected_at_ms INTEGER NOT NULL CHECK (projected_at_ms >= 0),
  PRIMARY KEY (drop_id, session_id)
) STRICT;

CREATE INDEX stripe_checkout_read_models_manual_review
  ON stripe_checkout_read_models (
    drop_id,
    manual_refund_review_required,
    failed_at_ms DESC,
    created_at_ms DESC,
    session_id DESC
  );

CREATE INDEX stripe_checkout_read_models_document_path
  ON stripe_checkout_read_models (document_path);

CREATE TRIGGER commerce_read_model_control_delete_guard
BEFORE DELETE ON commerce_read_model_control
BEGIN
  SELECT RAISE(ABORT, 'commerce read-model control cannot be deleted');
END;

CREATE TRIGGER commerce_read_model_control_insert_guard
BEFORE INSERT ON commerce_read_model_control
WHEN EXISTS (SELECT 1 FROM commerce_read_model_control)
BEGIN
  SELECT RAISE(ABORT, 'commerce read-model control already exists');
END;
