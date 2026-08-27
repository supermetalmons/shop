PRAGMA foreign_keys = ON;

CREATE TABLE "commerce_authority_control" (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  authority_state TEXT NOT NULL CHECK (authority_state IN ('paused', 'd1')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  documents_revision INTEGER NOT NULL CHECK (documents_revision >= 0),
  paused_at_ms INTEGER CHECK (paused_at_ms IS NULL OR paused_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;

CREATE TABLE commerce_commit_guards (
  guard_id TEXT PRIMARY KEY,
  expectations_json TEXT NOT NULL CHECK (json_valid(expectations_json)),
  expected_documents_revision INTEGER CHECK (expected_documents_revision IS NULL OR expected_documents_revision >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
) STRICT;

CREATE TABLE commerce_documents (
  document_path TEXT PRIMARY KEY,
  document_kind TEXT NOT NULL CHECK (document_kind IN (
    'delivery_order',
    'stripe_checkout',
    'claim_code',
    'box_assignment',
    'dude_assignment',
    'dude_pool',
    'offchain_order',
    'admin_irl_redeem_request',
    'admin_irl_redeem_pack_marker',
    'admin_irl_redeem_receipt_marker'
  )),
  drop_id TEXT,
  document_id TEXT NOT NULL,
  document_json TEXT NOT NULL CHECK (json_valid(document_json) AND json_type(document_json) = 'object'),
  version INTEGER NOT NULL CHECK (version >= 1),
  create_time TEXT NOT NULL,
  update_time TEXT NOT NULL,
  owner TEXT GENERATED ALWAYS AS (json_extract(document_json, '$.owner')) STORED,
  status TEXT GENERATED ALWAYS AS (json_extract(document_json, '$.status')) STORED,
  source TEXT GENERATED ALWAYS AS (json_extract(document_json, '$.source')) STORED,
  fulfillment_status TEXT GENERATED ALWAYS AS (json_extract(document_json, '$.fulfillmentStatus')) STORED,
  fulfillment_processor TEXT GENERATED ALWAYS AS (json_extract(document_json, '$.fulfillmentProcessor')) STORED,
  manual_refund_review_required INTEGER GENERATED ALWAYS AS (
    COALESCE(json_extract(document_json, '$.manualRefundReviewRequired'), 0)
  ) STORED,
  irl_claim_code TEXT GENERATED ALWAYS AS (json_extract(document_json, '$.irlClaimCode')) STORED,
  pack_projection_state TEXT GENERATED ALWAYS AS (json_extract(document_json, '$.packStatusProjectionState')) STORED,
  pack_projection_next_attempt_ms INTEGER GENERATED ALWAYS AS (
    CAST(json_extract(document_json, '$.packStatusProjectionNextAttemptAtMs') AS INTEGER)
  ) STORED,
  buyer_notification_state TEXT GENERATED ALWAYS AS (json_extract(document_json, '$.buyerOrderReceivedEmailState')) STORED,
  shipper_notification_state TEXT GENERATED ALWAYS AS (json_extract(document_json, '$.shipperReadyToShipEmailState')) STORED
, processed_at_seconds INTEGER
  CHECK (processed_at_seconds IS NULL OR processed_at_seconds >= 0), processed_at_nanos INTEGER
  CHECK (processed_at_nanos IS NULL OR processed_at_nanos BETWEEN 0 AND 999999999)) STRICT;

CREATE TABLE commerce_wipe_guards (
  guard_id TEXT PRIMARY KEY,
  expectations_json TEXT NOT NULL CHECK (json_valid(expectations_json)),
  expected_documents_revision INTEGER NOT NULL CHECK (expected_documents_revision >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
) STRICT;

CREATE INDEX commerce_delivery_orders_buyer_notifications_pending
  ON commerce_documents (document_path)
  WHERE
    document_kind = 'delivery_order' AND
    status = 'ready_to_ship' AND
    buyer_notification_state = 'pending';

CREATE INDEX commerce_delivery_orders_shipper_notifications_pending
  ON commerce_documents (document_path)
  WHERE
    document_kind = 'delivery_order' AND
    status = 'ready_to_ship' AND
    shipper_notification_state = 'pending';

CREATE INDEX commerce_documents_assignment_claim
  ON commerce_documents (document_kind, irl_claim_code, document_path);

CREATE INDEX commerce_documents_claim_code
  ON commerce_documents (document_kind, drop_id, document_path);

CREATE INDEX commerce_documents_delivery_drop_status
  ON commerce_documents (document_kind, drop_id, status, document_path);

CREATE INDEX commerce_documents_delivery_owner_path
  ON commerce_documents (owner, document_path)
  WHERE document_kind = 'delivery_order';

CREATE INDEX commerce_documents_delivery_owner_status
  ON commerce_documents (document_kind, owner, status, document_path);

CREATE INDEX commerce_documents_drop_processed_cursor
  ON commerce_documents (
    document_kind,
    drop_id,
    status,
    processed_at_seconds DESC,
    processed_at_nanos DESC,
    document_path DESC
  );

CREATE INDEX commerce_documents_fulfillment_status
  ON commerce_documents (document_kind, fulfillment_status, document_path);

CREATE INDEX commerce_documents_kind_path
  ON commerce_documents (document_kind, document_path);

CREATE INDEX commerce_documents_manual_review
  ON commerce_documents (document_kind, drop_id, manual_refund_review_required, document_path);

CREATE INDEX commerce_documents_owner_processed_cursor
  ON commerce_documents (
    document_kind,
    owner,
    status,
    processed_at_seconds DESC,
    processed_at_nanos DESC,
    document_path DESC
  );

CREATE INDEX commerce_documents_pack_projection
  ON commerce_documents (
    document_kind,
    drop_id,
    pack_projection_state,
    pack_projection_next_attempt_ms,
    document_path
  );

CREATE INDEX commerce_stripe_checkouts_reconciliation_due
  ON commerce_documents (
    CAST(json_extract(document_json, '$.updatedAt') AS INTEGER),
    document_path
  )
  WHERE
    document_kind = 'stripe_checkout' AND
    fulfillment_processor = 'cloudflare_queue_v1' AND
    status IN ('fulfillment_pending', 'processing');

INSERT INTO commerce_authority_control (
  singleton,
  authority_state,
  revision,
  documents_revision,
  paused_at_ms,
  updated_at_ms
) VALUES (1, 'd1', 1, 0, NULL, 0);

CREATE TRIGGER commerce_authority_delete_guard
BEFORE DELETE ON commerce_authority_control
BEGIN
  SELECT RAISE(ABORT, 'commerce authority control cannot be deleted');
END;

CREATE TRIGGER commerce_authority_revision_guard
BEFORE UPDATE OF authority_state ON commerce_authority_control
WHEN NEW.authority_state <> OLD.authority_state AND NEW.revision <> OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'commerce authority revision conflict');
END;

CREATE TRIGGER commerce_authority_transition_guard
BEFORE UPDATE OF authority_state ON commerce_authority_control
WHEN NOT (
  NEW.authority_state = OLD.authority_state OR
  (OLD.authority_state = 'd1' AND NEW.authority_state = 'paused') OR
  (OLD.authority_state = 'paused' AND NEW.authority_state = 'd1')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid commerce authority transition');
END;

CREATE TRIGGER commerce_commit_guard_validate
BEFORE INSERT ON commerce_commit_guards
BEGIN
  SELECT (CASE WHEN (
    SELECT authority_state FROM commerce_authority_control WHERE singleton = 1
  ) <> 'd1' THEN RAISE(ABORT, 'commerce authority is not d1') END);

  SELECT (CASE WHEN NEW.expected_documents_revision IS NOT NULL AND NEW.expected_documents_revision <> (
    SELECT documents_revision FROM commerce_authority_control WHERE singleton = 1
  ) THEN RAISE(ABORT, 'commerce transaction conflict') END);

  SELECT (CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.expectations_json) AS expectation
    LEFT JOIN commerce_documents AS document
      ON document.document_path = json_extract(expectation.value, '$.path')
    WHERE COALESCE(document.version, -1) <> CAST(json_extract(expectation.value, '$.version') AS INTEGER)
  ) THEN RAISE(ABORT, 'commerce transaction conflict') END);
END;

CREATE TRIGGER commerce_documents_delete_authority_guard
BEFORE DELETE ON commerce_documents
WHEN (SELECT authority_state FROM commerce_authority_control WHERE singleton = 1) NOT IN ('paused', 'd1')
BEGIN
  SELECT RAISE(ABORT, 'commerce authority is invalid');
END;

CREATE TRIGGER commerce_documents_identity_insert_guard
BEFORE INSERT ON commerce_documents
WHEN json_type(NEW.document_json, '$.uid') IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'commerce document contains noncanonical identity data');
END;

CREATE TRIGGER commerce_documents_identity_update_guard
BEFORE UPDATE OF document_json ON commerce_documents
WHEN json_type(NEW.document_json, '$.uid') IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'commerce document contains noncanonical identity data');
END;

CREATE TRIGGER commerce_documents_insert_authority_guard
BEFORE INSERT ON commerce_documents
WHEN (SELECT authority_state FROM commerce_authority_control WHERE singleton = 1) <> 'd1'
BEGIN
  SELECT RAISE(ABORT, 'commerce authority is not d1');
END;

CREATE TRIGGER commerce_documents_update_authority_guard
BEFORE UPDATE ON commerce_documents
WHEN (SELECT authority_state FROM commerce_authority_control WHERE singleton = 1) <> 'd1'
BEGIN
  SELECT RAISE(ABORT, 'commerce authority is not d1');
END;

CREATE TRIGGER commerce_wipe_guard_validate
BEFORE INSERT ON commerce_wipe_guards
BEGIN
  SELECT (CASE WHEN (
    SELECT authority_state FROM commerce_authority_control WHERE singleton = 1
  ) <> 'paused' THEN RAISE(ABORT, 'commerce authority is not paused') END);

  SELECT (CASE WHEN NEW.expected_documents_revision <> (
    SELECT documents_revision FROM commerce_authority_control WHERE singleton = 1
  ) THEN RAISE(ABORT, 'commerce wipe conflict') END);

  SELECT (CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.expectations_json) AS expectation
    LEFT JOIN commerce_documents AS document
      ON document.document_path = json_extract(expectation.value, '$.path')
    WHERE COALESCE(document.version, -1) <> CAST(json_extract(expectation.value, '$.version') AS INTEGER)
  ) THEN RAISE(ABORT, 'commerce wipe conflict') END);
END;
