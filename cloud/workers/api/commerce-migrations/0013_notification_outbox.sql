CREATE TABLE commerce_notification_outbox_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  storage_mode TEXT NOT NULL DEFAULT 'legacy' CHECK (storage_mode IN ('legacy', 'table')),
  preparation_state TEXT NOT NULL DEFAULT 'idle' CHECK (preparation_state IN ('idle', 'preparing', 'ready')),
  source_documents_revision INTEGER CHECK (source_documents_revision IS NULL OR source_documents_revision BETWEEN 0 AND 9007199254740991),
  prepared_at_ms INTEGER CHECK (prepared_at_ms IS NULL OR prepared_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK (storage_mode <> 'table' OR preparation_state = 'ready'),
  CHECK (preparation_state <> 'ready' OR (source_documents_revision IS NOT NULL AND prepared_at_ms IS NOT NULL))
) STRICT;

INSERT INTO commerce_notification_outbox_control (singleton) VALUES (1);

CREATE TABLE commerce_notification_outbox (
  parent_path TEXT NOT NULL REFERENCES commerce_documents(document_path) ON DELETE CASCADE,
  family TEXT NOT NULL CHECK (family IN ('ready', 'stripe_terminal', 'shipped')),
  drop_id TEXT NOT NULL CHECK (length(drop_id) BETWEEN 1 AND 64),
  generation TEXT NOT NULL CHECK (length(generation) = 36),
  outcome TEXT CHECK (
    (family = 'stripe_terminal' AND outcome IS NOT NULL AND outcome IN ('fulfilled', 'manual_review')) OR
    (family <> 'stripe_terminal' AND outcome IS NULL)
  ),
  state TEXT NOT NULL CHECK (state IN ('pending', 'queued', 'failed', 'cancelled')),
  entries_json TEXT NOT NULL CHECK (
    json_valid(entries_json) AND json_type(entries_json) = 'array'
    AND json_array_length(entries_json) BETWEEN 1 AND 2 AND length(CAST(entries_json AS BLOB)) <= 204800
  ),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  attempt_count INTEGER NOT NULL CHECK (attempt_count BETWEEN 0 AND 9007199254740991),
  next_attempt_at_ms INTEGER CHECK (next_attempt_at_ms IS NULL OR next_attempt_at_ms BETWEEN 0 AND 9007199254740991),
  claim_id TEXT CHECK (claim_id IS NULL OR length(claim_id) = 36),
  claim_expires_at_ms INTEGER CHECK (claim_expires_at_ms IS NULL OR claim_expires_at_ms BETWEEN 0 AND 9007199254740991),
  retry_until_ms INTEGER NOT NULL CHECK (retry_until_ms BETWEEN 0 AND 9007199254740991),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN created_at_ms AND 9007199254740991),
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 256),
  PRIMARY KEY (parent_path, family),
  CHECK ((state = 'pending') = (next_attempt_at_ms IS NOT NULL)),
  CHECK (claim_id IS NOT NULL OR claim_expires_at_ms IS NULL),
  CHECK (state = 'failed' OR ((claim_id IS NULL) = (claim_expires_at_ms IS NULL))),
  CHECK (state NOT IN ('queued', 'cancelled') OR claim_id IS NULL),
  CHECK (state <> 'pending' OR claim_expires_at_ms IS NULL OR claim_expires_at_ms = next_attempt_at_ms)
) STRICT;

CREATE INDEX commerce_notification_outbox_due
ON commerce_notification_outbox (next_attempt_at_ms, parent_path, family) WHERE state = 'pending';

CREATE INDEX commerce_notification_outbox_family_due
ON commerce_notification_outbox (family, next_attempt_at_ms, parent_path) WHERE state = 'pending';

CREATE INDEX commerce_notification_outbox_drop
ON commerce_notification_outbox (drop_id, parent_path, family);

CREATE INDEX commerce_notification_outbox_pending_path
ON commerce_notification_outbox (family, parent_path) WHERE state = 'pending';

CREATE TABLE commerce_notification_outbox_pending_owners (
  parent_path TEXT NOT NULL,
  family TEXT NOT NULL,
  owner TEXT NOT NULL,
  PRIMARY KEY (parent_path, family),
  FOREIGN KEY (parent_path, family) REFERENCES commerce_notification_outbox(parent_path, family) ON DELETE CASCADE
) STRICT;

CREATE INDEX commerce_notification_outbox_pending_owner_path
ON commerce_notification_outbox_pending_owners (owner, family, parent_path);

CREATE TRIGGER commerce_notification_outbox_pending_owner_insert
AFTER INSERT ON commerce_notification_outbox
WHEN NEW.state = 'pending'
BEGIN
  INSERT INTO commerce_notification_outbox_pending_owners (parent_path, family, owner)
  SELECT NEW.parent_path, NEW.family, document.owner
  FROM commerce_documents AS document
  WHERE document.document_path = NEW.parent_path AND document.owner IS NOT NULL
    AND (NEW.family <> 'ready' OR document.status = 'ready_to_ship');
END;

CREATE TRIGGER commerce_notification_outbox_pending_owner_state
AFTER UPDATE OF state ON commerce_notification_outbox
WHEN NEW.state IS NOT OLD.state
BEGIN
  DELETE FROM commerce_notification_outbox_pending_owners
  WHERE parent_path = NEW.parent_path AND family = NEW.family;
  INSERT INTO commerce_notification_outbox_pending_owners (parent_path, family, owner)
  SELECT NEW.parent_path, NEW.family, document.owner
  FROM commerce_documents AS document
  WHERE document.document_path = NEW.parent_path AND document.owner IS NOT NULL
    AND NEW.state = 'pending' AND (NEW.family <> 'ready' OR document.status = 'ready_to_ship');
END;

CREATE TRIGGER commerce_notification_outbox_pending_owner_source
AFTER UPDATE OF document_json ON commerce_documents
WHEN NEW.owner IS NOT OLD.owner OR NEW.status IS NOT OLD.status
BEGIN
  DELETE FROM commerce_notification_outbox_pending_owners WHERE parent_path = NEW.document_path;
  INSERT INTO commerce_notification_outbox_pending_owners (parent_path, family, owner)
  SELECT outbox.parent_path, outbox.family, NEW.owner
  FROM commerce_notification_outbox AS outbox
  WHERE outbox.parent_path = NEW.document_path AND outbox.state = 'pending' AND NEW.owner IS NOT NULL
    AND (outbox.family <> 'ready' OR NEW.status = 'ready_to_ship');
END;

CREATE TABLE commerce_notification_outbox_stripe_due (
  parent_path TEXT NOT NULL,
  family TEXT NOT NULL DEFAULT 'stripe_terminal' CHECK (family = 'stripe_terminal'),
  next_attempt_at_ms INTEGER NOT NULL CHECK (next_attempt_at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (parent_path, family),
  FOREIGN KEY (parent_path, family) REFERENCES commerce_notification_outbox(parent_path, family) ON DELETE CASCADE
) STRICT;

CREATE INDEX commerce_notification_outbox_stripe_due_at
ON commerce_notification_outbox_stripe_due (next_attempt_at_ms, parent_path);

CREATE TRIGGER commerce_notification_outbox_stripe_due_insert
AFTER INSERT ON commerce_notification_outbox
WHEN NEW.family = 'stripe_terminal' AND NEW.state = 'pending'
BEGIN
  INSERT INTO commerce_notification_outbox_stripe_due (parent_path, family, next_attempt_at_ms)
  SELECT NEW.parent_path, NEW.family, NEW.next_attempt_at_ms
  FROM commerce_documents AS document
  WHERE document.document_path = NEW.parent_path AND document.document_kind = 'stripe_checkout'
    AND ((NEW.outcome = 'fulfilled' AND document.status = 'fulfilled') OR
      (NEW.outcome = 'manual_review' AND document.status = 'fulfillment_failed' AND document.manual_refund_review_required = 1));
END;

CREATE TRIGGER commerce_notification_outbox_stripe_due_state
AFTER UPDATE OF state, outcome, next_attempt_at_ms ON commerce_notification_outbox
WHEN NEW.family = 'stripe_terminal' AND
  (NEW.state IS NOT OLD.state OR NEW.outcome IS NOT OLD.outcome OR NEW.next_attempt_at_ms IS NOT OLD.next_attempt_at_ms)
BEGIN
  DELETE FROM commerce_notification_outbox_stripe_due WHERE parent_path = NEW.parent_path AND family = NEW.family;
  INSERT INTO commerce_notification_outbox_stripe_due (parent_path, family, next_attempt_at_ms)
  SELECT NEW.parent_path, NEW.family, NEW.next_attempt_at_ms
  FROM commerce_documents AS document
  WHERE document.document_path = NEW.parent_path AND document.document_kind = 'stripe_checkout' AND NEW.state = 'pending'
    AND ((NEW.outcome = 'fulfilled' AND document.status = 'fulfilled') OR
      (NEW.outcome = 'manual_review' AND document.status = 'fulfillment_failed' AND document.manual_refund_review_required = 1));
END;

CREATE TRIGGER commerce_notification_outbox_stripe_due_source
AFTER UPDATE OF document_json, document_kind ON commerce_documents
WHEN (NEW.document_kind = 'stripe_checkout' OR OLD.document_kind = 'stripe_checkout') AND
  (NEW.status IS NOT OLD.status OR NEW.manual_refund_review_required IS NOT OLD.manual_refund_review_required OR
    NEW.document_kind IS NOT OLD.document_kind)
BEGIN
  DELETE FROM commerce_notification_outbox_stripe_due WHERE parent_path = NEW.document_path;
  INSERT INTO commerce_notification_outbox_stripe_due (parent_path, family, next_attempt_at_ms)
  SELECT outbox.parent_path, outbox.family, outbox.next_attempt_at_ms
  FROM commerce_notification_outbox AS outbox
  WHERE outbox.parent_path = NEW.document_path AND outbox.family = 'stripe_terminal' AND outbox.state = 'pending'
    AND NEW.document_kind = 'stripe_checkout'
    AND ((outbox.outcome = 'fulfilled' AND NEW.status = 'fulfilled') OR
      (outbox.outcome = 'manual_review' AND NEW.status = 'fulfillment_failed' AND NEW.manual_refund_review_required = 1));
END;

CREATE TRIGGER commerce_notification_outbox_control_delete_guard
BEFORE DELETE ON commerce_notification_outbox_control
BEGIN
  SELECT RAISE(ABORT, 'notification outbox control cannot be deleted');
END;

CREATE TRIGGER commerce_notification_outbox_control_insert_guard
BEFORE INSERT ON commerce_notification_outbox_control
BEGIN
  SELECT RAISE(ABORT, 'notification outbox control cannot be inserted');
END;

CREATE TRIGGER commerce_notification_outbox_control_update_guard
BEFORE UPDATE ON commerce_notification_outbox_control
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM commerce_authority_control AS authority
    JOIN commerce_authority_control_lease AS lease ON lease.singleton = authority.singleton
    WHERE authority.singleton = 1 AND authority.authority_state = 'paused'
      AND authority.paused_at_ms IS NOT NULL
      AND lease.expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
  )
    THEN RAISE(ABORT, 'notification outbox maintenance is not ready') END);
  SELECT (CASE WHEN NEW.singleton <> OLD.singleton OR OLD.storage_mode = 'table'
    THEN RAISE(ABORT, 'notification outbox activation is irreversible') END);
  SELECT (CASE WHEN NEW.storage_mode = 'table' AND (
    OLD.preparation_state <> 'ready' OR NEW.preparation_state <> 'ready'
    OR NEW.source_documents_revision IS NOT OLD.source_documents_revision
    OR NEW.prepared_at_ms IS NOT OLD.prepared_at_ms
    OR NEW.source_documents_revision <> (SELECT documents_revision FROM commerce_authority_control WHERE singleton = 1)
  ) THEN RAISE(ABORT, 'notification outbox preparation is incomplete') END);
  SELECT (CASE WHEN NEW.storage_mode = 'legacy' AND NOT (
    NEW.preparation_state = 'preparing' OR
    (OLD.preparation_state = 'preparing' AND NEW.preparation_state = 'ready'
      AND NEW.source_documents_revision = (SELECT documents_revision FROM commerce_authority_control WHERE singleton = 1))
  ) THEN RAISE(ABORT, 'invalid notification outbox preparation transition') END);
END;

CREATE TRIGGER commerce_notification_outbox_resume_guard
BEFORE UPDATE OF authority_state ON commerce_authority_control
WHEN NEW.authority_state = 'd1' AND EXISTS (
  SELECT 1 FROM commerce_notification_outbox_control
  WHERE storage_mode = 'legacy' AND preparation_state <> 'idle'
)
BEGIN
  SELECT RAISE(ABORT, 'notification outbox cutover is incomplete');
END;

CREATE TRIGGER commerce_notification_outbox_insert_guard
BEFORE INSERT ON commerce_notification_outbox
BEGIN
  SELECT (CASE WHEN NOT (
    EXISTS (SELECT 1 FROM commerce_authority_control AS authority
      CROSS JOIN commerce_notification_outbox_control AS control
      WHERE authority.singleton = 1 AND control.singleton = 1
        AND authority.authority_state = 'd1' AND control.storage_mode = 'table')
    OR (EXISTS (
    SELECT 1 FROM commerce_authority_control AS authority
    JOIN commerce_authority_control_lease AS lease ON lease.singleton = authority.singleton
    WHERE authority.singleton = 1 AND authority.authority_state = 'paused'
      AND authority.paused_at_ms IS NOT NULL
      AND lease.expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ) AND EXISTS (
      SELECT 1 FROM commerce_notification_outbox_control WHERE storage_mode = 'legacy' AND preparation_state = 'preparing'
    ))
  ) THEN RAISE(ABORT, 'notification outbox is unavailable') END);
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM commerce_documents
    WHERE document_path = NEW.parent_path AND drop_id = NEW.drop_id
      AND document_kind = (CASE WHEN NEW.family = 'stripe_terminal' THEN 'stripe_checkout' ELSE 'delivery_order' END)
  ) THEN RAISE(ABORT, 'notification outbox parent mismatch') END);
  SELECT (CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.entries_json) AS entry
    WHERE json_type(entry.value) IS NOT 'object'
      OR json_type(entry.value, '$.kind') IS NOT 'text'
      OR json_extract(entry.value, '$.kind') NOT IN (
        (CASE WHEN NEW.family = 'shipped' THEN 'buyer_order_shipped'
          WHEN NEW.outcome = 'manual_review' THEN 'stripe_checkout_manual_review' ELSE 'buyer_order_received' END),
        (CASE WHEN NEW.family = 'shipped' THEN 'buyer_order_shipped'
          WHEN NEW.outcome = 'manual_review' THEN 'stripe_checkout_manual_review' ELSE 'shipper_ready_to_ship' END)
      )
      OR json_type(entry.value, '$.jobId') IS NOT 'text'
      OR length(json_extract(entry.value, '$.jobId')) <> 36
      OR json_type(entry.value, '$.idempotencyKey') IS NOT 'text'
      OR length(json_extract(entry.value, '$.idempotencyKey')) NOT BETWEEN 1 AND 256
      OR json_type(entry.value, '$.state') IS NOT 'text'
      OR json_extract(entry.value, '$.state') NOT IN ('pending', 'queued', 'failed')
      OR (json_type(entry.value, '$.payload') IS NOT NULL AND json_type(entry.value, '$.payload') IS NOT 'object')
      OR ((NEW.state = 'cancelled' OR json_extract(entry.value, '$.state') = 'queued')
        AND json_type(entry.value, '$.payload') IS NOT NULL)
  ) OR (SELECT COUNT(DISTINCT json_extract(value, '$.kind')) FROM json_each(NEW.entries_json)) <>
    json_array_length(NEW.entries_json)
  THEN RAISE(ABORT, 'invalid notification outbox entries') END);
  SELECT (CASE WHEN NEW.state <> 'cancelled' AND NEW.state <> (CASE
    WHEN EXISTS (SELECT 1 FROM json_each(NEW.entries_json) WHERE json_extract(value, '$.state') = 'pending') THEN 'pending'
    WHEN EXISTS (SELECT 1 FROM json_each(NEW.entries_json) WHERE json_extract(value, '$.state') = 'failed') THEN 'failed'
    ELSE 'queued' END)
  THEN RAISE(ABORT, 'invalid notification outbox state') END);

END;

CREATE TRIGGER commerce_notification_outbox_update_guard
BEFORE UPDATE ON commerce_notification_outbox
BEGIN
  SELECT (CASE WHEN NOT (
    EXISTS (SELECT 1 FROM commerce_authority_control AS authority
      CROSS JOIN commerce_notification_outbox_control AS control
      WHERE authority.singleton = 1 AND control.singleton = 1
        AND authority.authority_state = 'd1' AND control.storage_mode = 'table')
    OR (EXISTS (
    SELECT 1 FROM commerce_authority_control AS authority
    JOIN commerce_authority_control_lease AS lease ON lease.singleton = authority.singleton
    WHERE authority.singleton = 1 AND authority.authority_state = 'paused'
      AND authority.paused_at_ms IS NOT NULL
      AND lease.expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ) AND EXISTS (
      SELECT 1 FROM commerce_notification_outbox_control WHERE storage_mode = 'legacy' AND preparation_state = 'preparing'
    ))
  ) THEN RAISE(ABORT, 'notification outbox is unavailable') END);
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM commerce_documents
    WHERE document_path = NEW.parent_path AND drop_id = NEW.drop_id
      AND document_kind = (CASE WHEN NEW.family = 'stripe_terminal' THEN 'stripe_checkout' ELSE 'delivery_order' END)
  ) THEN RAISE(ABORT, 'notification outbox parent mismatch') END);
  SELECT (CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.entries_json) AS entry
    WHERE json_type(entry.value) IS NOT 'object'
      OR json_type(entry.value, '$.kind') IS NOT 'text'
      OR json_extract(entry.value, '$.kind') NOT IN (
        (CASE WHEN NEW.family = 'shipped' THEN 'buyer_order_shipped'
          WHEN NEW.outcome = 'manual_review' THEN 'stripe_checkout_manual_review' ELSE 'buyer_order_received' END),
        (CASE WHEN NEW.family = 'shipped' THEN 'buyer_order_shipped'
          WHEN NEW.outcome = 'manual_review' THEN 'stripe_checkout_manual_review' ELSE 'shipper_ready_to_ship' END)
      )
      OR json_type(entry.value, '$.jobId') IS NOT 'text'
      OR length(json_extract(entry.value, '$.jobId')) <> 36
      OR json_type(entry.value, '$.idempotencyKey') IS NOT 'text'
      OR length(json_extract(entry.value, '$.idempotencyKey')) NOT BETWEEN 1 AND 256
      OR json_type(entry.value, '$.state') IS NOT 'text'
      OR json_extract(entry.value, '$.state') NOT IN ('pending', 'queued', 'failed')
      OR (json_type(entry.value, '$.payload') IS NOT NULL AND json_type(entry.value, '$.payload') IS NOT 'object')
      OR ((NEW.state = 'cancelled' OR json_extract(entry.value, '$.state') = 'queued')
        AND json_type(entry.value, '$.payload') IS NOT NULL)
  ) OR (SELECT COUNT(DISTINCT json_extract(value, '$.kind')) FROM json_each(NEW.entries_json)) <>
    json_array_length(NEW.entries_json)
  THEN RAISE(ABORT, 'invalid notification outbox entries') END);
  SELECT (CASE WHEN NEW.state <> 'cancelled' AND NEW.state <> (CASE
    WHEN EXISTS (SELECT 1 FROM json_each(NEW.entries_json) WHERE json_extract(value, '$.state') = 'pending') THEN 'pending'
    WHEN EXISTS (SELECT 1 FROM json_each(NEW.entries_json) WHERE json_extract(value, '$.state') = 'failed') THEN 'failed'
    ELSE 'queued' END)
  THEN RAISE(ABORT, 'invalid notification outbox state') END);
  SELECT (CASE WHEN NEW.parent_path IS NOT OLD.parent_path OR NEW.family IS NOT OLD.family
    OR NEW.drop_id IS NOT OLD.drop_id OR NEW.revision <> OLD.revision + 1
    OR NEW.updated_at_ms < OLD.updated_at_ms
    THEN RAISE(ABORT, 'notification outbox revision conflict') END);
  SELECT (CASE WHEN NEW.generation = OLD.generation AND (
    NEW.outcome IS NOT OLD.outcome OR NEW.created_at_ms <> OLD.created_at_ms
    OR json_array_length(NEW.entries_json) <> json_array_length(OLD.entries_json)
    OR EXISTS (
      SELECT 1 FROM json_each(OLD.entries_json) AS previous
      LEFT JOIN json_each(NEW.entries_json) AS current
        ON json_extract(current.value, '$.kind') = json_extract(previous.value, '$.kind')
      WHERE current.value IS NULL
        OR json_extract(current.value, '$.jobId') IS NOT json_extract(previous.value, '$.jobId')
        OR json_extract(current.value, '$.idempotencyKey') IS NOT json_extract(previous.value, '$.idempotencyKey')
        OR (json_extract(previous.value, '$.state') IN ('queued', 'failed')
          AND json_extract(current.value, '$.state') IS NOT json_extract(previous.value, '$.state'))
        OR (json_type(previous.value, '$.payload') IS NOT NULL
          AND json_type(current.value, '$.payload') IS NOT NULL
          AND json_extract(current.value, '$.payload') IS NOT json_extract(previous.value, '$.payload'))
        OR (json_type(previous.value, '$.payload') IS NOT NULL
          AND json_type(current.value, '$.payload') IS NULL
          AND json_extract(current.value, '$.state') = 'pending' AND NEW.state <> 'cancelled')
    )
  ) THEN RAISE(ABORT, 'notification outbox identity or payload is immutable') END);
END;

CREATE TRIGGER commerce_notification_outbox_delete_guard
BEFORE DELETE ON commerce_notification_outbox
WHEN NOT EXISTS (
    SELECT 1 FROM commerce_authority_control AS authority
    JOIN commerce_authority_control_lease AS lease ON lease.singleton = authority.singleton
    WHERE authority.singleton = 1 AND authority.authority_state = 'paused'
      AND authority.paused_at_ms IS NOT NULL
      AND lease.expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
  )
BEGIN
  SELECT RAISE(ABORT, 'notification outbox deletion requires maintenance');
END;

ALTER TABLE commerce_commit_guards
ADD COLUMN notification_outbox_expectations_json TEXT NOT NULL DEFAULT '[]'
CHECK (json_valid(notification_outbox_expectations_json) AND json_type(notification_outbox_expectations_json) = 'array');

CREATE TRIGGER commerce_commit_guard_notification_outbox_validate
BEFORE INSERT ON commerce_commit_guards
WHEN json_array_length(NEW.notification_outbox_expectations_json) > 0
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM commerce_notification_outbox_control WHERE singleton = 1 AND storage_mode = 'table'
  ) THEN RAISE(ABORT, 'notification outbox is unavailable') END);
  SELECT (CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.notification_outbox_expectations_json) AS expectation
    LEFT JOIN commerce_notification_outbox AS outbox
      ON outbox.parent_path = json_extract(expectation.value, '$.parentPath')
      AND outbox.family = json_extract(expectation.value, '$.family')
    WHERE json_type(expectation.value, '$.parentPath') IS NOT 'text'
      OR json_type(expectation.value, '$.family') IS NOT 'text'
      OR json_type(expectation.value, '$.revision') IS NOT 'integer'
      OR COALESCE(outbox.revision, -1) <> json_extract(expectation.value, '$.revision')
      OR outbox.generation IS NOT json_extract(expectation.value, '$.generation')
  ) THEN RAISE(ABORT, 'commerce transaction conflict: notification outbox changed') END);
END;

CREATE TRIGGER commerce_notification_legacy_insert_fence
BEFORE INSERT ON commerce_documents
WHEN (SELECT storage_mode FROM commerce_notification_outbox_control WHERE singleton = 1) = 'table'
  AND NOT EXISTS (SELECT 1 FROM commerce_documents WHERE document_path = NEW.document_path)
  AND (json_type(NEW.document_json, '$.buyerOrderReceivedEmailState') IS NOT NULL
    OR json_type(NEW.document_json, '$.buyerOrderReceivedEmailJobId') IS NOT NULL
    OR json_type(NEW.document_json, '$.buyerOrderReceivedEmailJob') IS NOT NULL
    OR json_type(NEW.document_json, '$.buyerOrderReceivedEmailIdempotencyKey') IS NOT NULL
    OR json_type(NEW.document_json, '$.buyerOrderReceivedEmailQueuedAt') IS NOT NULL
    OR json_type(NEW.document_json, '$.shipperReadyToShipEmailState') IS NOT NULL
    OR json_type(NEW.document_json, '$.shipperReadyToShipEmailJobId') IS NOT NULL
    OR json_type(NEW.document_json, '$.shipperReadyToShipEmailJob') IS NOT NULL
    OR json_type(NEW.document_json, '$.shipperReadyToShipEmailIdempotencyKey') IS NOT NULL
    OR json_type(NEW.document_json, '$.shipperReadyToShipEmailQueuedAt') IS NOT NULL
    OR json_type(NEW.document_json, '$.readyToShipNotificationRetryUntilMs') IS NOT NULL
    OR json_type(NEW.document_json, '$.readyToShipNotificationPublishAttemptCount') IS NOT NULL
    OR json_type(NEW.document_json, '$.readyToShipNotificationPublishClaimId') IS NOT NULL
    OR json_type(NEW.document_json, '$.readyToShipNotificationPublishClaimExpiresAtMs') IS NOT NULL
    OR json_type(NEW.document_json, '$.readyToShipNotificationFailedAt') IS NOT NULL
    OR json_type(NEW.document_json, '$.readyToShipNotificationLastErrorCode') IS NOT NULL
    OR json_type(NEW.document_json, '$.stripeTerminalNotification') IS NOT NULL
    OR json_type(NEW.document_json, '$.stripeTerminalNotificationState') IS NOT NULL
    OR json_type(NEW.document_json, '$.stripeTerminalNotificationNextAttemptAtMs') IS NOT NULL
    OR json_type(NEW.document_json, '$.stripeTerminalNotificationQueuedAt') IS NOT NULL
    OR json_type(NEW.document_json, '$.stripeTerminalNotificationLastError') IS NOT NULL
    OR json_type(NEW.document_json, '$.buyerOrderShippedEmailState') IS NOT NULL
    OR json_type(NEW.document_json, '$.buyerOrderShippedEmailJobId') IS NOT NULL
    OR json_type(NEW.document_json, '$.buyerOrderShippedEmailIdempotencyKey') IS NOT NULL
    OR json_type(NEW.document_json, '$.buyerOrderShippedEmailQueuedAt') IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'legacy notification writes are disabled');
END;

CREATE TRIGGER commerce_notification_legacy_update_fence
BEFORE UPDATE OF document_json ON commerce_documents
WHEN (SELECT storage_mode FROM commerce_notification_outbox_control WHERE singleton = 1) = 'table'
  AND (json_type(NEW.document_json, '$.buyerOrderReceivedEmailState') IS NOT json_type(OLD.document_json, '$.buyerOrderReceivedEmailState')
    OR json_extract(NEW.document_json, '$.buyerOrderReceivedEmailState') IS NOT json_extract(OLD.document_json, '$.buyerOrderReceivedEmailState')
    OR json_type(NEW.document_json, '$.buyerOrderReceivedEmailJobId') IS NOT json_type(OLD.document_json, '$.buyerOrderReceivedEmailJobId')
    OR json_extract(NEW.document_json, '$.buyerOrderReceivedEmailJobId') IS NOT json_extract(OLD.document_json, '$.buyerOrderReceivedEmailJobId')
    OR json_type(NEW.document_json, '$.buyerOrderReceivedEmailJob') IS NOT json_type(OLD.document_json, '$.buyerOrderReceivedEmailJob')
    OR json_extract(NEW.document_json, '$.buyerOrderReceivedEmailJob') IS NOT json_extract(OLD.document_json, '$.buyerOrderReceivedEmailJob')
    OR json_type(NEW.document_json, '$.buyerOrderReceivedEmailIdempotencyKey') IS NOT json_type(OLD.document_json, '$.buyerOrderReceivedEmailIdempotencyKey')
    OR json_extract(NEW.document_json, '$.buyerOrderReceivedEmailIdempotencyKey') IS NOT json_extract(OLD.document_json, '$.buyerOrderReceivedEmailIdempotencyKey')
    OR json_type(NEW.document_json, '$.buyerOrderReceivedEmailQueuedAt') IS NOT json_type(OLD.document_json, '$.buyerOrderReceivedEmailQueuedAt')
    OR json_extract(NEW.document_json, '$.buyerOrderReceivedEmailQueuedAt') IS NOT json_extract(OLD.document_json, '$.buyerOrderReceivedEmailQueuedAt')
    OR json_type(NEW.document_json, '$.shipperReadyToShipEmailState') IS NOT json_type(OLD.document_json, '$.shipperReadyToShipEmailState')
    OR json_extract(NEW.document_json, '$.shipperReadyToShipEmailState') IS NOT json_extract(OLD.document_json, '$.shipperReadyToShipEmailState')
    OR json_type(NEW.document_json, '$.shipperReadyToShipEmailJobId') IS NOT json_type(OLD.document_json, '$.shipperReadyToShipEmailJobId')
    OR json_extract(NEW.document_json, '$.shipperReadyToShipEmailJobId') IS NOT json_extract(OLD.document_json, '$.shipperReadyToShipEmailJobId')
    OR json_type(NEW.document_json, '$.shipperReadyToShipEmailJob') IS NOT json_type(OLD.document_json, '$.shipperReadyToShipEmailJob')
    OR json_extract(NEW.document_json, '$.shipperReadyToShipEmailJob') IS NOT json_extract(OLD.document_json, '$.shipperReadyToShipEmailJob')
    OR json_type(NEW.document_json, '$.shipperReadyToShipEmailIdempotencyKey') IS NOT json_type(OLD.document_json, '$.shipperReadyToShipEmailIdempotencyKey')
    OR json_extract(NEW.document_json, '$.shipperReadyToShipEmailIdempotencyKey') IS NOT json_extract(OLD.document_json, '$.shipperReadyToShipEmailIdempotencyKey')
    OR json_type(NEW.document_json, '$.shipperReadyToShipEmailQueuedAt') IS NOT json_type(OLD.document_json, '$.shipperReadyToShipEmailQueuedAt')
    OR json_extract(NEW.document_json, '$.shipperReadyToShipEmailQueuedAt') IS NOT json_extract(OLD.document_json, '$.shipperReadyToShipEmailQueuedAt')
    OR json_type(NEW.document_json, '$.readyToShipNotificationRetryUntilMs') IS NOT json_type(OLD.document_json, '$.readyToShipNotificationRetryUntilMs')
    OR json_extract(NEW.document_json, '$.readyToShipNotificationRetryUntilMs') IS NOT json_extract(OLD.document_json, '$.readyToShipNotificationRetryUntilMs')
    OR json_type(NEW.document_json, '$.readyToShipNotificationPublishAttemptCount') IS NOT json_type(OLD.document_json, '$.readyToShipNotificationPublishAttemptCount')
    OR json_extract(NEW.document_json, '$.readyToShipNotificationPublishAttemptCount') IS NOT json_extract(OLD.document_json, '$.readyToShipNotificationPublishAttemptCount')
    OR json_type(NEW.document_json, '$.readyToShipNotificationPublishClaimId') IS NOT json_type(OLD.document_json, '$.readyToShipNotificationPublishClaimId')
    OR json_extract(NEW.document_json, '$.readyToShipNotificationPublishClaimId') IS NOT json_extract(OLD.document_json, '$.readyToShipNotificationPublishClaimId')
    OR json_type(NEW.document_json, '$.readyToShipNotificationPublishClaimExpiresAtMs') IS NOT json_type(OLD.document_json, '$.readyToShipNotificationPublishClaimExpiresAtMs')
    OR json_extract(NEW.document_json, '$.readyToShipNotificationPublishClaimExpiresAtMs') IS NOT json_extract(OLD.document_json, '$.readyToShipNotificationPublishClaimExpiresAtMs')
    OR json_type(NEW.document_json, '$.readyToShipNotificationFailedAt') IS NOT json_type(OLD.document_json, '$.readyToShipNotificationFailedAt')
    OR json_extract(NEW.document_json, '$.readyToShipNotificationFailedAt') IS NOT json_extract(OLD.document_json, '$.readyToShipNotificationFailedAt')
    OR json_type(NEW.document_json, '$.readyToShipNotificationLastErrorCode') IS NOT json_type(OLD.document_json, '$.readyToShipNotificationLastErrorCode')
    OR json_extract(NEW.document_json, '$.readyToShipNotificationLastErrorCode') IS NOT json_extract(OLD.document_json, '$.readyToShipNotificationLastErrorCode')
    OR json_type(NEW.document_json, '$.stripeTerminalNotification') IS NOT json_type(OLD.document_json, '$.stripeTerminalNotification')
    OR json_extract(NEW.document_json, '$.stripeTerminalNotification') IS NOT json_extract(OLD.document_json, '$.stripeTerminalNotification')
    OR json_type(NEW.document_json, '$.stripeTerminalNotificationState') IS NOT json_type(OLD.document_json, '$.stripeTerminalNotificationState')
    OR json_extract(NEW.document_json, '$.stripeTerminalNotificationState') IS NOT json_extract(OLD.document_json, '$.stripeTerminalNotificationState')
    OR json_type(NEW.document_json, '$.stripeTerminalNotificationNextAttemptAtMs') IS NOT json_type(OLD.document_json, '$.stripeTerminalNotificationNextAttemptAtMs')
    OR json_extract(NEW.document_json, '$.stripeTerminalNotificationNextAttemptAtMs') IS NOT json_extract(OLD.document_json, '$.stripeTerminalNotificationNextAttemptAtMs')
    OR json_type(NEW.document_json, '$.stripeTerminalNotificationQueuedAt') IS NOT json_type(OLD.document_json, '$.stripeTerminalNotificationQueuedAt')
    OR json_extract(NEW.document_json, '$.stripeTerminalNotificationQueuedAt') IS NOT json_extract(OLD.document_json, '$.stripeTerminalNotificationQueuedAt')
    OR json_type(NEW.document_json, '$.stripeTerminalNotificationLastError') IS NOT json_type(OLD.document_json, '$.stripeTerminalNotificationLastError')
    OR json_extract(NEW.document_json, '$.stripeTerminalNotificationLastError') IS NOT json_extract(OLD.document_json, '$.stripeTerminalNotificationLastError')
    OR json_type(NEW.document_json, '$.buyerOrderShippedEmailState') IS NOT json_type(OLD.document_json, '$.buyerOrderShippedEmailState')
    OR json_extract(NEW.document_json, '$.buyerOrderShippedEmailState') IS NOT json_extract(OLD.document_json, '$.buyerOrderShippedEmailState')
    OR json_type(NEW.document_json, '$.buyerOrderShippedEmailJobId') IS NOT json_type(OLD.document_json, '$.buyerOrderShippedEmailJobId')
    OR json_extract(NEW.document_json, '$.buyerOrderShippedEmailJobId') IS NOT json_extract(OLD.document_json, '$.buyerOrderShippedEmailJobId')
    OR json_type(NEW.document_json, '$.buyerOrderShippedEmailIdempotencyKey') IS NOT json_type(OLD.document_json, '$.buyerOrderShippedEmailIdempotencyKey')
    OR json_extract(NEW.document_json, '$.buyerOrderShippedEmailIdempotencyKey') IS NOT json_extract(OLD.document_json, '$.buyerOrderShippedEmailIdempotencyKey')
    OR json_type(NEW.document_json, '$.buyerOrderShippedEmailQueuedAt') IS NOT json_type(OLD.document_json, '$.buyerOrderShippedEmailQueuedAt')
    OR json_extract(NEW.document_json, '$.buyerOrderShippedEmailQueuedAt') IS NOT json_extract(OLD.document_json, '$.buyerOrderShippedEmailQueuedAt'))
BEGIN
  SELECT RAISE(ABORT, 'legacy notification writes are disabled');
END;

PRAGMA optimize;
