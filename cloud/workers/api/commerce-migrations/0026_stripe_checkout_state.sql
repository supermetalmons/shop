CREATE TABLE commerce_stripe_checkout_state_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  storage_mode TEXT NOT NULL DEFAULT 'legacy' CHECK (storage_mode IN ('legacy', 'table')),
  preparation_state TEXT NOT NULL DEFAULT 'idle' CHECK (preparation_state IN ('idle', 'preparing', 'ready')),
  source_documents_revision INTEGER CHECK (source_documents_revision IS NULL OR source_documents_revision BETWEEN 0 AND 9007199254740991),
  prepared_at_ms INTEGER CHECK (prepared_at_ms IS NULL OR prepared_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK (storage_mode <> 'table' OR preparation_state = 'ready'),
  CHECK (preparation_state <> 'ready' OR (source_documents_revision IS NOT NULL AND prepared_at_ms IS NOT NULL))
) STRICT;

INSERT INTO commerce_stripe_checkout_state_control (singleton) VALUES (1);

CREATE TABLE commerce_stripe_checkout_state (
  document_path TEXT PRIMARY KEY REFERENCES commerce_documents(document_path) ON DELETE CASCADE,
  document_version INTEGER NOT NULL CHECK (document_version BETWEEN 1 AND 9007199254740991),
  status TEXT NOT NULL CHECK (status IN ('created', 'fulfillment_pending', 'processing', 'fulfilled', 'fulfillment_failed')),
  processing_attempt_id TEXT CHECK (processing_attempt_id IS NULL OR length(processing_attempt_id) BETWEEN 1 AND 128),
  processing_attempt_count INTEGER CHECK (processing_attempt_count IS NULL OR processing_attempt_count BETWEEN 0 AND 9007199254740991),
  processing_started_at_ms INTEGER CHECK (processing_started_at_ms IS NULL OR processing_started_at_ms BETWEEN 0 AND 9007199254740991),
  processing_lease_expires_at_ms INTEGER CHECK (processing_lease_expires_at_ms IS NULL OR processing_lease_expires_at_ms BETWEEN 0 AND 9007199254740991),
  last_retryable_fulfillment_attempt INTEGER CHECK (last_retryable_fulfillment_attempt IS NULL OR last_retryable_fulfillment_attempt BETWEEN 0 AND 9007199254740991),
  last_retryable_fulfillment_error_at_ms INTEGER CHECK (last_retryable_fulfillment_error_at_ms IS NULL OR last_retryable_fulfillment_error_at_ms BETWEEN 0 AND 9007199254740991),
  next_fulfillment_retry_at_ms INTEGER CHECK (next_fulfillment_retry_at_ms IS NULL OR next_fulfillment_retry_at_ms BETWEEN 0 AND 9007199254740991),
  fulfillment_queue_reenqueued_at_ms INTEGER CHECK (fulfillment_queue_reenqueued_at_ms IS NULL OR fulfillment_queue_reenqueued_at_ms BETWEEN 0 AND 9007199254740991),
  last_fulfillment_reconciliation_error_at_ms INTEGER CHECK (last_fulfillment_reconciliation_error_at_ms IS NULL OR last_fulfillment_reconciliation_error_at_ms BETWEEN 0 AND 9007199254740991),
  updated_at_ms INTEGER CHECK (updated_at_ms IS NULL OR updated_at_ms BETWEEN 0 AND 9007199254740991)
) STRICT;

CREATE INDEX commerce_stripe_checkout_state_reconciliation_due
ON commerce_stripe_checkout_state (updated_at_ms, document_path)
WHERE status IN ('fulfillment_pending', 'processing');

DROP INDEX commerce_stripe_checkouts_manual_review_cursor;
CREATE INDEX commerce_stripe_checkouts_manual_review_cursor
ON commerce_documents (
  drop_id, manual_review_sort_at_ms DESC,
  manual_review_session_id COLLATE BINARY DESC, document_path COLLATE BINARY DESC
)
WHERE document_kind = 'stripe_checkout' AND manual_refund_review_required = 1
  AND json_type(document_json, '$.manualRefundReviewRequired') = 'true';

ALTER TABLE commerce_commit_guards ADD COLUMN stripe_checkout_paths_json TEXT NOT NULL DEFAULT '[]'
CHECK (json_valid(stripe_checkout_paths_json) AND json_type(stripe_checkout_paths_json) = 'array');

CREATE TRIGGER commerce_stripe_checkout_control_insert_guard
BEFORE INSERT ON commerce_stripe_checkout_state_control
BEGIN
  SELECT RAISE(ABORT, 'stripe checkout state control cannot be inserted');
END;

CREATE TRIGGER commerce_stripe_checkout_control_delete_guard
BEFORE DELETE ON commerce_stripe_checkout_state_control
BEGIN
  SELECT RAISE(ABORT, 'stripe checkout state control cannot be deleted');
END;

CREATE TRIGGER commerce_stripe_checkout_control_update_guard
BEFORE UPDATE ON commerce_stripe_checkout_state_control
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM commerce_authority_control AS authority
    JOIN commerce_authority_control_lease AS lease ON lease.singleton = authority.singleton
    WHERE authority.singleton = 1 AND authority.authority_state = 'paused' AND authority.paused_at_ms IS NOT NULL
      AND lease.expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ) THEN RAISE(ABORT, 'stripe checkout state maintenance is not ready') END);
  SELECT (CASE WHEN NEW.singleton <> OLD.singleton OR OLD.storage_mode = 'table'
    THEN RAISE(ABORT, 'stripe checkout state activation is irreversible') END);
  SELECT (CASE WHEN NEW.storage_mode = 'legacy' AND NOT (
    NEW.preparation_state = 'preparing' OR
    (OLD.preparation_state = 'preparing' AND NEW.preparation_state = 'ready'
      AND NEW.source_documents_revision = (SELECT documents_revision FROM commerce_authority_control WHERE singleton = 1))
  ) THEN RAISE(ABORT, 'invalid stripe checkout state preparation transition') END);
  SELECT (CASE WHEN NEW.storage_mode = 'table' AND (
    OLD.preparation_state <> 'ready' OR NEW.preparation_state <> 'ready'
    OR NEW.source_documents_revision IS NOT OLD.source_documents_revision
    OR NEW.prepared_at_ms IS NOT OLD.prepared_at_ms
    OR NEW.source_documents_revision <> (SELECT documents_revision FROM commerce_authority_control WHERE singleton = 1)
    OR EXISTS (
      SELECT 1 FROM commerce_documents AS document LEFT JOIN commerce_stripe_checkout_state AS state
        ON state.document_path = document.document_path
      WHERE document.document_kind = 'stripe_checkout' AND (
        state.document_path IS NULL OR state.document_version <> document.version OR
        state.status IS NOT json_extract(document.document_json, '$.status') OR
        state.processing_attempt_id IS NOT json_extract(document.document_json, '$.processingAttemptId') OR
        state.processing_attempt_count IS NOT json_extract(document.document_json, '$.processingAttemptCount') OR
        state.processing_started_at_ms IS NOT json_extract(document.document_json, '$.processingStartedAt') OR
        state.processing_lease_expires_at_ms IS NOT json_extract(document.document_json, '$.processingLeaseExpiresAt') OR
        state.last_retryable_fulfillment_attempt IS NOT json_extract(document.document_json, '$.lastRetryableFulfillmentAttempt') OR
        state.last_retryable_fulfillment_error_at_ms IS NOT json_extract(document.document_json, '$.lastRetryableFulfillmentErrorAt') OR
        state.next_fulfillment_retry_at_ms IS NOT json_extract(document.document_json, '$.nextFulfillmentRetryAt') OR
        state.fulfillment_queue_reenqueued_at_ms IS NOT json_extract(document.document_json, '$.fulfillmentQueueReenqueuedAt') OR
        state.last_fulfillment_reconciliation_error_at_ms IS NOT json_extract(document.document_json, '$.lastFulfillmentReconciliationErrorAt') OR
        state.updated_at_ms IS NOT json_extract(document.document_json, '$.updatedAt')
      )
    ) OR EXISTS (
      SELECT 1 FROM commerce_stripe_checkout_state AS state LEFT JOIN commerce_documents AS document
        ON document.document_path = state.document_path
      WHERE document.document_kind IS NOT 'stripe_checkout'
    )
  ) THEN RAISE(ABORT, 'stripe checkout state preparation is incomplete') END);
END;

CREATE TRIGGER commerce_stripe_checkout_resume_guard
BEFORE UPDATE OF authority_state ON commerce_authority_control
WHEN NEW.authority_state = 'd1' AND EXISTS (
  SELECT 1 FROM commerce_stripe_checkout_state_control WHERE storage_mode = 'legacy' AND preparation_state <> 'idle'
)
BEGIN
  SELECT RAISE(ABORT, 'stripe checkout state cutover is incomplete');
END;

CREATE TRIGGER commerce_stripe_checkout_state_insert_guard
BEFORE INSERT ON commerce_stripe_checkout_state
BEGIN
  SELECT (CASE WHEN NOT ((EXISTS (SELECT 1 FROM commerce_authority_control AS authority
    JOIN commerce_stripe_checkout_state_control AS control ON control.singleton = authority.singleton
    WHERE authority.singleton = 1 AND authority.authority_state = 'd1' AND control.storage_mode = 'table')
    AND EXISTS (SELECT 1 FROM commerce_commit_guards AS guard, json_each(guard.stripe_checkout_paths_json) AS path
      WHERE path.value = NEW.document_path)) OR EXISTS (SELECT 1 FROM commerce_authority_control AS authority
    JOIN commerce_authority_control_lease AS lease ON lease.singleton = authority.singleton
    JOIN commerce_stripe_checkout_state_control AS control ON control.singleton = authority.singleton
    WHERE authority.singleton = 1 AND authority.authority_state = 'paused' AND authority.paused_at_ms IS NOT NULL
      AND lease.expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
      AND control.storage_mode = 'legacy' AND control.preparation_state = 'preparing'
      AND control.source_documents_revision = authority.documents_revision))
    THEN RAISE(ABORT, 'stripe checkout state is unavailable') END);
  SELECT (CASE WHEN NOT EXISTS (SELECT 1 FROM commerce_documents
    WHERE document_path = NEW.document_path AND document_kind = 'stripe_checkout' AND version = NEW.document_version)
    THEN RAISE(ABORT, 'commerce transaction conflict: stripe checkout parent changed') END);
END;

CREATE TRIGGER commerce_stripe_checkout_state_update_guard
BEFORE UPDATE ON commerce_stripe_checkout_state
BEGIN
  SELECT (CASE WHEN NOT ((EXISTS (SELECT 1 FROM commerce_authority_control AS authority
    JOIN commerce_stripe_checkout_state_control AS control ON control.singleton = authority.singleton
    WHERE authority.singleton = 1 AND authority.authority_state = 'd1' AND control.storage_mode = 'table')
    AND EXISTS (SELECT 1 FROM commerce_commit_guards AS guard, json_each(guard.stripe_checkout_paths_json) AS path
      WHERE path.value = NEW.document_path)) OR EXISTS (SELECT 1 FROM commerce_authority_control AS authority
    JOIN commerce_authority_control_lease AS lease ON lease.singleton = authority.singleton
    JOIN commerce_stripe_checkout_state_control AS control ON control.singleton = authority.singleton
    WHERE authority.singleton = 1 AND authority.authority_state = 'paused' AND authority.paused_at_ms IS NOT NULL
      AND lease.expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
      AND control.storage_mode = 'legacy' AND control.preparation_state = 'preparing'
      AND control.source_documents_revision = authority.documents_revision))
    THEN RAISE(ABORT, 'stripe checkout state is unavailable') END);
  SELECT (CASE WHEN NEW.document_path IS NOT OLD.document_path OR NOT EXISTS (SELECT 1 FROM commerce_documents
    WHERE document_path = NEW.document_path AND document_kind = 'stripe_checkout' AND version = NEW.document_version)
    OR ((SELECT storage_mode FROM commerce_stripe_checkout_state_control WHERE singleton = 1) = 'table'
      AND NEW.document_version <= OLD.document_version)
    THEN RAISE(ABORT, 'commerce transaction conflict: stripe checkout parent changed') END);
END;

CREATE TRIGGER commerce_stripe_checkout_state_delete_guard
BEFORE DELETE ON commerce_stripe_checkout_state
WHEN EXISTS (SELECT 1 FROM commerce_documents WHERE document_path = OLD.document_path) AND NOT EXISTS (SELECT 1 FROM commerce_authority_control AS authority
    JOIN commerce_authority_control_lease AS lease ON lease.singleton = authority.singleton
    JOIN commerce_stripe_checkout_state_control AS control ON control.singleton = authority.singleton
    WHERE authority.singleton = 1 AND authority.authority_state = 'paused' AND authority.paused_at_ms IS NOT NULL
      AND lease.expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
      AND control.storage_mode = 'legacy' AND control.preparation_state = 'preparing'
      AND control.source_documents_revision = authority.documents_revision)
BEGIN
  SELECT RAISE(ABORT, 'stripe checkout state requires parent deletion');
END;

CREATE TRIGGER commerce_stripe_checkout_parent_insert_guard
BEFORE INSERT ON commerce_documents
WHEN NEW.document_kind = 'stripe_checkout'
  AND (SELECT storage_mode FROM commerce_stripe_checkout_state_control WHERE singleton = 1) = 'table'
BEGIN
  SELECT (CASE WHEN NOT EXISTS (SELECT 1 FROM commerce_commit_guards AS guard, json_each(guard.stripe_checkout_paths_json) AS path
    WHERE path.value = NEW.document_path) THEN RAISE(ABORT, 'stripe checkout state is unavailable') END);
  SELECT (CASE WHEN NOT EXISTS (SELECT 1 FROM commerce_documents WHERE document_path = NEW.document_path)
    AND (json_type(NEW.document_json, '$.status') IS NOT NULL OR
    json_type(NEW.document_json, '$.processingAttemptId') IS NOT NULL OR
    json_type(NEW.document_json, '$.processingAttemptCount') IS NOT NULL OR
    json_type(NEW.document_json, '$.processingStartedAt') IS NOT NULL OR
    json_type(NEW.document_json, '$.processingLeaseExpiresAt') IS NOT NULL OR
    json_type(NEW.document_json, '$.lastRetryableFulfillmentAttempt') IS NOT NULL OR
    json_type(NEW.document_json, '$.lastRetryableFulfillmentErrorAt') IS NOT NULL OR
    json_type(NEW.document_json, '$.nextFulfillmentRetryAt') IS NOT NULL OR
    json_type(NEW.document_json, '$.fulfillmentQueueReenqueuedAt') IS NOT NULL OR
    json_type(NEW.document_json, '$.lastFulfillmentReconciliationErrorAt') IS NOT NULL OR
    json_type(NEW.document_json, '$.updatedAt') IS NOT NULL)
    THEN RAISE(ABORT, 'legacy stripe checkout state writes are disabled') END);
END;

CREATE TRIGGER commerce_stripe_checkout_parent_update_guard
BEFORE UPDATE ON commerce_documents
WHEN (OLD.document_kind = 'stripe_checkout' OR NEW.document_kind = 'stripe_checkout')
  AND (SELECT storage_mode FROM commerce_stripe_checkout_state_control WHERE singleton = 1) = 'table'
BEGIN
  SELECT (CASE WHEN NEW.document_kind IS NOT OLD.document_kind OR NEW.document_path IS NOT OLD.document_path
    OR NEW.drop_id IS NOT OLD.drop_id OR NEW.document_id IS NOT OLD.document_id
    THEN RAISE(ABORT, 'stripe checkout parent identity is immutable') END);
  SELECT (CASE WHEN NOT EXISTS (SELECT 1 FROM commerce_commit_guards AS guard, json_each(guard.stripe_checkout_paths_json) AS path
    WHERE path.value = NEW.document_path) THEN RAISE(ABORT, 'stripe checkout state is unavailable') END);
  SELECT (CASE WHEN json_type(NEW.document_json, '$.status') IS NOT json_type(OLD.document_json, '$.status') OR
    json_extract(NEW.document_json, '$.status') IS NOT json_extract(OLD.document_json, '$.status') OR
    json_type(NEW.document_json, '$.processingAttemptId') IS NOT json_type(OLD.document_json, '$.processingAttemptId') OR
    json_extract(NEW.document_json, '$.processingAttemptId') IS NOT json_extract(OLD.document_json, '$.processingAttemptId') OR
    json_type(NEW.document_json, '$.processingAttemptCount') IS NOT json_type(OLD.document_json, '$.processingAttemptCount') OR
    json_extract(NEW.document_json, '$.processingAttemptCount') IS NOT json_extract(OLD.document_json, '$.processingAttemptCount') OR
    json_type(NEW.document_json, '$.processingStartedAt') IS NOT json_type(OLD.document_json, '$.processingStartedAt') OR
    json_extract(NEW.document_json, '$.processingStartedAt') IS NOT json_extract(OLD.document_json, '$.processingStartedAt') OR
    json_type(NEW.document_json, '$.processingLeaseExpiresAt') IS NOT json_type(OLD.document_json, '$.processingLeaseExpiresAt') OR
    json_extract(NEW.document_json, '$.processingLeaseExpiresAt') IS NOT json_extract(OLD.document_json, '$.processingLeaseExpiresAt') OR
    json_type(NEW.document_json, '$.lastRetryableFulfillmentAttempt') IS NOT json_type(OLD.document_json, '$.lastRetryableFulfillmentAttempt') OR
    json_extract(NEW.document_json, '$.lastRetryableFulfillmentAttempt') IS NOT json_extract(OLD.document_json, '$.lastRetryableFulfillmentAttempt') OR
    json_type(NEW.document_json, '$.lastRetryableFulfillmentErrorAt') IS NOT json_type(OLD.document_json, '$.lastRetryableFulfillmentErrorAt') OR
    json_extract(NEW.document_json, '$.lastRetryableFulfillmentErrorAt') IS NOT json_extract(OLD.document_json, '$.lastRetryableFulfillmentErrorAt') OR
    json_type(NEW.document_json, '$.nextFulfillmentRetryAt') IS NOT json_type(OLD.document_json, '$.nextFulfillmentRetryAt') OR
    json_extract(NEW.document_json, '$.nextFulfillmentRetryAt') IS NOT json_extract(OLD.document_json, '$.nextFulfillmentRetryAt') OR
    json_type(NEW.document_json, '$.fulfillmentQueueReenqueuedAt') IS NOT json_type(OLD.document_json, '$.fulfillmentQueueReenqueuedAt') OR
    json_extract(NEW.document_json, '$.fulfillmentQueueReenqueuedAt') IS NOT json_extract(OLD.document_json, '$.fulfillmentQueueReenqueuedAt') OR
    json_type(NEW.document_json, '$.lastFulfillmentReconciliationErrorAt') IS NOT json_type(OLD.document_json, '$.lastFulfillmentReconciliationErrorAt') OR
    json_extract(NEW.document_json, '$.lastFulfillmentReconciliationErrorAt') IS NOT json_extract(OLD.document_json, '$.lastFulfillmentReconciliationErrorAt') OR
    json_type(NEW.document_json, '$.updatedAt') IS NOT json_type(OLD.document_json, '$.updatedAt') OR
    json_extract(NEW.document_json, '$.updatedAt') IS NOT json_extract(OLD.document_json, '$.updatedAt')
    THEN RAISE(ABORT, 'legacy stripe checkout state writes are disabled') END);
END;

CREATE TRIGGER commerce_commit_guard_stripe_checkout_validate
BEFORE INSERT ON commerce_commit_guards
WHEN json_array_length(NEW.stripe_checkout_paths_json) > 0
BEGIN
  SELECT (CASE WHEN NOT EXISTS (SELECT 1 FROM commerce_stripe_checkout_state_control WHERE singleton = 1 AND storage_mode = 'table')
    THEN RAISE(ABORT, 'stripe checkout state is unavailable') END);
  SELECT (CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.stripe_checkout_paths_json) WHERE type <> 'text')
    THEN RAISE(ABORT, 'invalid stripe checkout state commit paths') END);
END;

CREATE TRIGGER commerce_commit_guard_stripe_checkout_finish
BEFORE DELETE ON commerce_commit_guards
WHEN json_array_length(OLD.stripe_checkout_paths_json) > 0
BEGIN
  SELECT (CASE WHEN EXISTS (
    SELECT 1 FROM json_each(OLD.stripe_checkout_paths_json) AS path
    JOIN commerce_documents AS document ON document.document_path = path.value
    LEFT JOIN commerce_stripe_checkout_state AS state ON state.document_path = path.value
    WHERE document.document_kind <> 'stripe_checkout' OR state.document_path IS NULL OR state.document_version <> document.version
  ) THEN RAISE(ABORT, 'commerce transaction conflict: stripe checkout state commit is incomplete') END);
END;

DROP TRIGGER commerce_notification_outbox_stripe_due_insert;
CREATE TRIGGER commerce_notification_outbox_stripe_due_insert
AFTER INSERT ON commerce_notification_outbox
WHEN NEW.family = 'stripe_terminal' AND NEW.state = 'pending'
BEGIN
  INSERT INTO commerce_notification_outbox_stripe_due (parent_path, family, next_attempt_at_ms)
  SELECT NEW.parent_path, NEW.family, NEW.next_attempt_at_ms
  FROM commerce_documents AS document LEFT JOIN commerce_stripe_checkout_state AS state
    ON state.document_path = document.document_path
  WHERE document.document_path = NEW.parent_path AND document.document_kind = 'stripe_checkout'
    AND ((NEW.outcome = 'fulfilled' AND (CASE WHEN (SELECT storage_mode FROM commerce_stripe_checkout_state_control WHERE singleton = 1) = 'table' THEN state.status ELSE document.status END) = 'fulfilled') OR
      (NEW.outcome = 'manual_review' AND (CASE WHEN (SELECT storage_mode FROM commerce_stripe_checkout_state_control WHERE singleton = 1) = 'table' THEN state.status ELSE document.status END) = 'fulfillment_failed' AND document.manual_refund_review_required = 1));
END;

DROP TRIGGER commerce_notification_outbox_stripe_due_state;
CREATE TRIGGER commerce_notification_outbox_stripe_due_state
AFTER UPDATE OF state, outcome, next_attempt_at_ms ON commerce_notification_outbox
WHEN NEW.family = 'stripe_terminal' AND
  (NEW.state IS NOT OLD.state OR NEW.outcome IS NOT OLD.outcome OR NEW.next_attempt_at_ms IS NOT OLD.next_attempt_at_ms)
BEGIN
  DELETE FROM commerce_notification_outbox_stripe_due WHERE parent_path = NEW.parent_path AND family = NEW.family;
  INSERT INTO commerce_notification_outbox_stripe_due (parent_path, family, next_attempt_at_ms)
  SELECT NEW.parent_path, NEW.family, NEW.next_attempt_at_ms
  FROM commerce_documents AS document LEFT JOIN commerce_stripe_checkout_state AS state
    ON state.document_path = document.document_path
  WHERE document.document_path = NEW.parent_path AND document.document_kind = 'stripe_checkout' AND NEW.state = 'pending'
    AND ((NEW.outcome = 'fulfilled' AND (CASE WHEN (SELECT storage_mode FROM commerce_stripe_checkout_state_control WHERE singleton = 1) = 'table' THEN state.status ELSE document.status END) = 'fulfilled') OR
      (NEW.outcome = 'manual_review' AND (CASE WHEN (SELECT storage_mode FROM commerce_stripe_checkout_state_control WHERE singleton = 1) = 'table' THEN state.status ELSE document.status END) = 'fulfillment_failed' AND document.manual_refund_review_required = 1));
END;

DROP TRIGGER commerce_notification_outbox_stripe_due_source;
CREATE TRIGGER commerce_notification_outbox_stripe_due_source
AFTER UPDATE OF document_json, document_kind ON commerce_documents
WHEN (NEW.document_kind = 'stripe_checkout' OR OLD.document_kind = 'stripe_checkout') AND
  (NEW.status IS NOT OLD.status OR NEW.manual_refund_review_required IS NOT OLD.manual_refund_review_required OR
    NEW.document_kind IS NOT OLD.document_kind)
BEGIN
  DELETE FROM commerce_notification_outbox_stripe_due WHERE parent_path = NEW.document_path;
  INSERT INTO commerce_notification_outbox_stripe_due (parent_path, family, next_attempt_at_ms)
  SELECT outbox.parent_path, outbox.family, outbox.next_attempt_at_ms
  FROM commerce_notification_outbox AS outbox JOIN commerce_documents AS document ON document.document_path = outbox.parent_path
  LEFT JOIN commerce_stripe_checkout_state AS state ON state.document_path = document.document_path
  WHERE outbox.parent_path = NEW.document_path AND outbox.family = 'stripe_terminal' AND outbox.state = 'pending'
    AND document.document_kind = 'stripe_checkout' AND ((outbox.outcome = 'fulfilled' AND (CASE WHEN (SELECT storage_mode FROM commerce_stripe_checkout_state_control WHERE singleton = 1) = 'table' THEN state.status ELSE document.status END) = 'fulfilled') OR
      (outbox.outcome = 'manual_review' AND (CASE WHEN (SELECT storage_mode FROM commerce_stripe_checkout_state_control WHERE singleton = 1) = 'table' THEN state.status ELSE document.status END) = 'fulfillment_failed' AND document.manual_refund_review_required = 1));
END;

CREATE TRIGGER commerce_stripe_checkout_state_due_insert
AFTER INSERT ON commerce_stripe_checkout_state
WHEN (SELECT storage_mode FROM commerce_stripe_checkout_state_control WHERE singleton = 1) = 'table'
BEGIN
  DELETE FROM commerce_notification_outbox_stripe_due WHERE parent_path = NEW.document_path;
  INSERT INTO commerce_notification_outbox_stripe_due (parent_path, family, next_attempt_at_ms)
  SELECT outbox.parent_path, outbox.family, outbox.next_attempt_at_ms
  FROM commerce_notification_outbox AS outbox JOIN commerce_documents AS document ON document.document_path = outbox.parent_path
  WHERE outbox.parent_path = NEW.document_path AND outbox.family = 'stripe_terminal' AND outbox.state = 'pending'
    AND ((outbox.outcome = 'fulfilled' AND NEW.status = 'fulfilled') OR
      (outbox.outcome = 'manual_review' AND NEW.status = 'fulfillment_failed' AND document.manual_refund_review_required = 1));
END;

CREATE TRIGGER commerce_stripe_checkout_state_due_update
AFTER UPDATE OF status ON commerce_stripe_checkout_state
WHEN NEW.status IS NOT OLD.status AND (SELECT storage_mode FROM commerce_stripe_checkout_state_control WHERE singleton = 1) = 'table'
BEGIN
  DELETE FROM commerce_notification_outbox_stripe_due WHERE parent_path = NEW.document_path;
  INSERT INTO commerce_notification_outbox_stripe_due (parent_path, family, next_attempt_at_ms)
  SELECT outbox.parent_path, outbox.family, outbox.next_attempt_at_ms
  FROM commerce_notification_outbox AS outbox JOIN commerce_documents AS document ON document.document_path = outbox.parent_path
  WHERE outbox.parent_path = NEW.document_path AND outbox.family = 'stripe_terminal' AND outbox.state = 'pending'
    AND ((outbox.outcome = 'fulfilled' AND NEW.status = 'fulfilled') OR
      (outbox.outcome = 'manual_review' AND NEW.status = 'fulfillment_failed' AND document.manual_refund_review_required = 1));
END;

CREATE TRIGGER commerce_stripe_checkout_state_activate_due
AFTER UPDATE OF storage_mode ON commerce_stripe_checkout_state_control
WHEN NEW.storage_mode = 'table' AND OLD.storage_mode = 'legacy'
BEGIN
  DELETE FROM commerce_notification_outbox_stripe_due;
  INSERT INTO commerce_notification_outbox_stripe_due (parent_path, family, next_attempt_at_ms)
  SELECT outbox.parent_path, outbox.family, outbox.next_attempt_at_ms
  FROM commerce_notification_outbox AS outbox
  JOIN commerce_documents AS document ON document.document_path = outbox.parent_path
  JOIN commerce_stripe_checkout_state AS state ON state.document_path = document.document_path
  WHERE outbox.family = 'stripe_terminal' AND outbox.state = 'pending' AND document.document_kind = 'stripe_checkout'
    AND ((outbox.outcome = 'fulfilled' AND state.status = 'fulfilled') OR
      (outbox.outcome = 'manual_review' AND state.status = 'fulfillment_failed' AND document.manual_refund_review_required = 1));
END;

PRAGMA optimize;
