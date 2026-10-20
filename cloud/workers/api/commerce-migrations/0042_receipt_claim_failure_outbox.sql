CREATE TABLE commerce_receipt_claim_failure_outbox (
  event_id TEXT PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 128),
  claim_path TEXT NOT NULL REFERENCES commerce_documents(document_path) ON DELETE CASCADE,
  incident_kind TEXT NOT NULL CHECK (incident_kind IN ('workflow', 'legacy')),
  operation_id TEXT,
  workflow_generation INTEGER CHECK (workflow_generation IS NULL OR workflow_generation BETWEEN 1 AND 9007199254740991),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json) AND json_type(snapshot_json) = 'object'
    AND length(CAST(snapshot_json AS BLOB)) <= 8192),
  state TEXT NOT NULL CHECK (state IN ('pending', 'queued', 'failed', 'cancelled')),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  attempt_count INTEGER NOT NULL CHECK (attempt_count BETWEEN 0 AND 9007199254740991),
  next_attempt_at_ms INTEGER CHECK (next_attempt_at_ms IS NULL OR next_attempt_at_ms BETWEEN 0 AND 9007199254740991),
  claim_id TEXT CHECK (claim_id IS NULL OR length(claim_id) = 36),
  claim_expires_at_ms INTEGER CHECK (claim_expires_at_ms IS NULL OR claim_expires_at_ms BETWEEN 0 AND 9007199254740991),
  retry_until_ms INTEGER NOT NULL CHECK (retry_until_ms BETWEEN 0 AND 9007199254740991),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN created_at_ms AND 9007199254740991),
  job_json TEXT CHECK (job_json IS NULL OR (json_valid(job_json) AND json_type(job_json) = 'object'
    AND length(CAST(job_json AS BLOB)) <= 98304)),
  queued_at_ms INTEGER CHECK (queued_at_ms IS NULL OR queued_at_ms BETWEEN 0 AND 9007199254740991),
  last_error_code TEXT CHECK (last_error_code IS NULL OR (length(last_error_code) BETWEEN 1 AND 128
    AND last_error_code NOT GLOB '*[^a-z0-9_-]*')),
  UNIQUE (claim_path, operation_id, workflow_generation),
  CHECK ((incident_kind = 'workflow' AND operation_id IS NOT NULL AND operation_id GLOB 'src-v1-*'
      AND length(operation_id) = 43 AND workflow_generation IS NOT NULL
      AND event_id = operation_id || ':g' || workflow_generation)
    OR (incident_kind = 'legacy' AND operation_id IS NULL AND workflow_generation IS NULL
      AND event_id GLOB 'legacy:*' AND length(event_id) = 71
      AND substr(event_id, 8) NOT GLOB '*[^0-9a-f]*')),
  CHECK ((state = 'pending') = (next_attempt_at_ms IS NOT NULL)),
  CHECK ((claim_id IS NULL) = (claim_expires_at_ms IS NULL)),
  CHECK (state = 'pending' OR claim_id IS NULL),
  CHECK (state <> 'pending' OR claim_expires_at_ms IS NULL OR next_attempt_at_ms = claim_expires_at_ms),
  CHECK ((state = 'queued') = (queued_at_ms IS NOT NULL)),
  CHECK (state <> 'queued' OR job_json IS NOT NULL)
) STRICT;

CREATE INDEX commerce_receipt_claim_failure_outbox_due
ON commerce_receipt_claim_failure_outbox (next_attempt_at_ms, event_id) WHERE state = 'pending';

CREATE INDEX commerce_receipt_claim_failure_outbox_claim
ON commerce_receipt_claim_failure_outbox (claim_path, incident_kind);

CREATE INDEX commerce_receipt_claim_failure_legacy_scan
ON commerce_documents (json_extract(document_json, '$.processingStartedAt'), document_path)
WHERE document_kind = 'claim_code' AND status = 'processing'
  AND json_extract(document_json, '$.namespace') = 'stripe_receipt_v1'
  AND json_type(document_json, '$.receiptClaimWorkflowV1') IS NULL;

CREATE INDEX commerce_receipt_claim_failure_terminal_scan
ON commerce_documents (json_extract(document_json, '$.receiptClaimWorkflowV1.operationId'),
  json_extract(document_json, '$.receiptClaimWorkflowV1.generation'), document_path)
WHERE document_kind = 'claim_code' AND status = 'processing'
  AND json_extract(document_json, '$.namespace') = 'stripe_receipt_v1'
  AND json_extract(document_json, '$.receiptClaimWorkflowV1.phase') IN ('failed', 'manual_review');

CREATE INDEX commerce_receipt_claim_failure_overdue_scan
ON commerce_documents (json_extract(document_json, '$.receiptClaimWorkflowV1.deadlineAtMs'), document_path)
WHERE document_kind = 'claim_code' AND status = 'processing'
  AND json_extract(document_json, '$.namespace') = 'stripe_receipt_v1'
  AND json_extract(document_json, '$.receiptClaimWorkflowV1.phase') = 'pending';

CREATE TRIGGER commerce_receipt_claim_failure_insert_guard
BEFORE INSERT ON commerce_receipt_claim_failure_outbox
BEGIN
  SELECT (CASE WHEN NOT EXISTS (SELECT 1 FROM commerce_authority_control
    WHERE singleton = 1 AND authority_state = 'd1')
    THEN RAISE(ABORT, 'receipt claim failure outbox is unavailable') END);
  SELECT (CASE WHEN NEW.state <> 'pending' OR NEW.revision <> 1 OR NEW.attempt_count <> 0
    OR NEW.claim_id IS NOT NULL OR NEW.job_json IS NOT NULL OR NEW.queued_at_ms IS NOT NULL
    OR NEW.next_attempt_at_ms <> NEW.created_at_ms OR NEW.updated_at_ms <> NEW.created_at_ms
    OR NEW.retry_until_ms < NEW.created_at_ms OR NEW.last_error_code IS NOT NULL
    THEN RAISE(ABORT, 'invalid initial receipt claim failure outbox') END);
  SELECT (CASE WHEN (SELECT COUNT(*) FROM json_each(NEW.snapshot_json)) <> 14
    OR (SELECT COUNT(DISTINCT key) FROM json_each(NEW.snapshot_json)) <> 14
    OR EXISTS (SELECT 1 FROM json_each(NEW.snapshot_json) WHERE key NOT IN (
      'version', 'dropId', 'deliveryId', 'boxId', 'recipient', 'operationId', 'generation', 'phase',
      'errorCode', 'createdAtMs', 'deadlineAtMs', 'failedAtMs', 'processingStartedAtMs', 'signature'))
    OR json_extract(NEW.snapshot_json, '$.version') IS NOT 1
    OR json_type(NEW.snapshot_json, '$.dropId') IS NOT 'text'
    OR length(json_extract(NEW.snapshot_json, '$.dropId')) NOT BETWEEN 1 AND 64
    OR json_extract(NEW.snapshot_json, '$.dropId') GLOB '*[^a-z0-9_]*'
    OR json_type(NEW.snapshot_json, '$.deliveryId') IS NOT 'integer'
    OR json_extract(NEW.snapshot_json, '$.deliveryId') NOT BETWEEN 1 AND 9007199254740991
    OR json_type(NEW.snapshot_json, '$.boxId') IS NOT 'integer'
    OR json_extract(NEW.snapshot_json, '$.boxId') NOT BETWEEN 1 AND 9007199254740991
    OR json_type(NEW.snapshot_json, '$.recipient') IS NOT 'text'
    OR length(json_extract(NEW.snapshot_json, '$.recipient')) NOT BETWEEN 32 AND 64
    OR json_extract(NEW.snapshot_json, '$.recipient') GLOB '*[^1-9A-HJ-NP-Za-km-z]*'
    OR json_extract(NEW.snapshot_json, '$.operationId') IS NOT NEW.operation_id
    OR json_extract(NEW.snapshot_json, '$.generation') IS NOT NEW.workflow_generation
    OR json_type(NEW.snapshot_json, '$.failedAtMs') IS NOT 'integer'
    OR json_extract(NEW.snapshot_json, '$.failedAtMs') NOT BETWEEN 0 AND 9007199254740991
    OR EXISTS (SELECT 1 FROM json_each(NEW.snapshot_json)
      WHERE key IN ('createdAtMs', 'deadlineAtMs', 'processingStartedAtMs')
        AND (type NOT IN ('null', 'integer') OR (type = 'integer' AND value NOT BETWEEN 0 AND 9007199254740991)))
    OR (json_type(NEW.snapshot_json, '$.errorCode') IS NOT 'null'
      AND json_extract(NEW.snapshot_json, '$.errorCode') NOT IN ('invalid-argument', 'unauthenticated', 'permission-denied',
        'not-found', 'aborted', 'failed-precondition', 'resource-exhausted', 'deadline-exceeded', 'unavailable', 'internal', 'legacy-processing'))
    OR (json_type(NEW.snapshot_json, '$.signature') IS NOT 'null' AND (
      json_type(NEW.snapshot_json, '$.signature') IS NOT 'text'
      OR length(json_extract(NEW.snapshot_json, '$.signature')) NOT BETWEEN 64 AND 128
      OR json_extract(NEW.snapshot_json, '$.signature') GLOB '*[^1-9A-HJ-NP-Za-km-z]*'))
    OR (NEW.incident_kind = 'legacy' AND json_extract(NEW.snapshot_json, '$.phase') IS NOT 'legacy_processing')
    OR (NEW.incident_kind = 'workflow' AND json_extract(NEW.snapshot_json, '$.phase') NOT IN ('failed', 'manual_review', 'overdue'))
    THEN RAISE(ABORT, 'invalid receipt claim failure snapshot') END);
  SELECT (CASE WHEN NOT EXISTS (SELECT 1 FROM commerce_documents AS source
    WHERE source.document_path = NEW.claim_path AND source.document_kind = 'claim_code' AND source.status = 'processing'
      AND json_extract(source.document_json, '$.namespace') = 'stripe_receipt_v1'
      AND json_extract(source.document_json, '$.dropId') = json_extract(NEW.snapshot_json, '$.dropId')
      AND json_extract(source.document_json, '$.deliveryId') = json_extract(NEW.snapshot_json, '$.deliveryId')
      AND json_extract(source.document_json, '$.boxId') = json_extract(NEW.snapshot_json, '$.boxId')
      AND json_extract(source.document_json, '$.recipient') = json_extract(NEW.snapshot_json, '$.recipient')
      AND ((NEW.incident_kind = 'legacy' AND json_type(source.document_json, '$.receiptClaimWorkflowV1') IS NULL
        AND json_extract(source.document_json, '$.processingStartedAt') IS json_extract(NEW.snapshot_json, '$.processingStartedAtMs'))
        OR (NEW.incident_kind = 'workflow'
          AND json_extract(source.document_json, '$.receiptClaimWorkflowV1.operationId') = NEW.operation_id
          AND json_extract(source.document_json, '$.receiptClaimWorkflowV1.generation') = NEW.workflow_generation
          AND (json_extract(source.document_json, '$.receiptClaimWorkflowV1.phase') IN ('failed', 'manual_review')
            OR (json_extract(source.document_json, '$.receiptClaimWorkflowV1.phase') = 'pending'
              AND json_extract(NEW.snapshot_json, '$.phase') = 'overdue')))))
    THEN RAISE(ABORT, 'receipt claim failure source changed') END);
END;

CREATE TRIGGER commerce_receipt_claim_failure_update_guard
BEFORE UPDATE ON commerce_receipt_claim_failure_outbox
BEGIN
  SELECT (CASE WHEN NOT EXISTS (SELECT 1 FROM commerce_authority_control
    WHERE singleton = 1 AND authority_state = 'd1')
    THEN RAISE(ABORT, 'receipt claim failure outbox is unavailable') END);
  SELECT (CASE WHEN NEW.event_id IS NOT OLD.event_id OR NEW.claim_path IS NOT OLD.claim_path
    OR NEW.incident_kind IS NOT OLD.incident_kind OR NEW.operation_id IS NOT OLD.operation_id
    OR NEW.workflow_generation IS NOT OLD.workflow_generation OR NEW.snapshot_json IS NOT OLD.snapshot_json
    OR NEW.created_at_ms IS NOT OLD.created_at_ms OR NEW.revision <> OLD.revision + 1
    OR NEW.updated_at_ms < OLD.updated_at_ms
    OR (OLD.state <> 'pending' AND NEW.state <> OLD.state)
    OR (OLD.job_json IS NOT NULL AND NEW.job_json IS NOT OLD.job_json)
    THEN RAISE(ABORT, 'receipt claim failure identity or payload is immutable') END);
  SELECT (CASE WHEN NEW.job_json IS NOT NULL AND (
    json_extract(NEW.job_json, '$.kind') IS NOT 'receipt_claim_manual_review'
    OR json_extract(NEW.job_json, '$.idempotencyKey') IS NOT 'receipt_claim_failure:' || NEW.event_id
    OR json_extract(NEW.job_json, '$.context.dropId') IS NOT json_extract(NEW.snapshot_json, '$.dropId')
    OR json_extract(NEW.job_json, '$.context.deliveryId') IS NOT json_extract(NEW.snapshot_json, '$.deliveryId')
    OR instr(NEW.job_json, substr(NEW.claim_path, 12)) > 0)
    THEN RAISE(ABORT, 'invalid receipt claim failure email identity') END);
END;

CREATE TRIGGER commerce_receipt_claim_failure_delete_guard
BEFORE DELETE ON commerce_receipt_claim_failure_outbox
WHEN NOT EXISTS (SELECT 1 FROM commerce_authority_control AS authority
  JOIN commerce_authority_control_lease AS lease ON lease.singleton = authority.singleton
  WHERE authority.singleton = 1 AND authority.authority_state = 'paused' AND authority.paused_at_ms IS NOT NULL
    AND lease.expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000)
BEGIN
  SELECT RAISE(ABORT, 'receipt claim failure deletion requires maintenance');
END;

CREATE TRIGGER commerce_receipt_claim_failure_capture_insert
AFTER INSERT ON commerce_documents
WHEN NEW.document_kind = 'claim_code' AND NEW.status = 'processing'
  AND json_extract(NEW.document_json, '$.namespace') = 'stripe_receipt_v1'
  AND json_extract(NEW.document_json, '$.receiptClaimWorkflowV1.phase') IN ('failed', 'manual_review')
BEGIN
  INSERT INTO commerce_receipt_claim_failure_outbox (
    event_id, claim_path, incident_kind, operation_id, workflow_generation, snapshot_json,
    state, revision, attempt_count, next_attempt_at_ms, claim_id, claim_expires_at_ms,
    retry_until_ms, created_at_ms, updated_at_ms, job_json, queued_at_ms, last_error_code
  ) VALUES (
    json_extract(NEW.document_json, '$.receiptClaimWorkflowV1.operationId') || ':g' || json_extract(NEW.document_json, '$.receiptClaimWorkflowV1.generation'), NEW.document_path, 'workflow',
    json_extract(NEW.document_json, '$.receiptClaimWorkflowV1.operationId'), json_extract(NEW.document_json, '$.receiptClaimWorkflowV1.generation'),
    json_object('version', 1, 'dropId', json_extract(NEW.document_json, '$.dropId'), 'deliveryId', json_extract(NEW.document_json, '$.deliveryId'),
      'boxId', json_extract(NEW.document_json, '$.boxId'), 'recipient', json_extract(NEW.document_json, '$.recipient'),
      'operationId', json_extract(NEW.document_json, '$.receiptClaimWorkflowV1.operationId'), 'generation', json_extract(NEW.document_json, '$.receiptClaimWorkflowV1.generation'), 'phase', json_extract(NEW.document_json, '$.receiptClaimWorkflowV1.phase'),
      'errorCode', CASE WHEN json_extract(NEW.document_json, '$.receiptClaimWorkflowV1.error.code') IN ('invalid-argument', 'unauthenticated', 'permission-denied', 'not-found',
        'aborted', 'failed-precondition', 'resource-exhausted', 'deadline-exceeded', 'unavailable', 'internal')
        THEN json_extract(NEW.document_json, '$.receiptClaimWorkflowV1.error.code') ELSE 'internal' END,
      'createdAtMs', CASE WHEN json_type(NEW.document_json, '$.receiptClaimWorkflowV1.createdAtMs') = 'integer' AND json_extract(NEW.document_json, '$.receiptClaimWorkflowV1.createdAtMs') BETWEEN 0 AND 9007199254740991 THEN json_extract(NEW.document_json, '$.receiptClaimWorkflowV1.createdAtMs') ELSE NULL END, 'deadlineAtMs', CASE WHEN json_type(NEW.document_json, '$.receiptClaimWorkflowV1.deadlineAtMs') = 'integer' AND json_extract(NEW.document_json, '$.receiptClaimWorkflowV1.deadlineAtMs') BETWEEN 0 AND 9007199254740991 THEN json_extract(NEW.document_json, '$.receiptClaimWorkflowV1.deadlineAtMs') ELSE NULL END, 'failedAtMs', (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
      'processingStartedAtMs', CASE WHEN json_type(NEW.document_json, '$.processingStartedAt') = 'integer'
        AND json_extract(NEW.document_json, '$.processingStartedAt') BETWEEN 0 AND 9007199254740991 THEN json_extract(NEW.document_json, '$.processingStartedAt') ELSE NULL END,
      'signature', CASE WHEN json_type(NEW.document_json, '$.receiptClaimWorkflowV1.submission.signature') = 'text'
        AND length(json_extract(NEW.document_json, '$.receiptClaimWorkflowV1.submission.signature')) BETWEEN 64 AND 128
        AND json_extract(NEW.document_json, '$.receiptClaimWorkflowV1.submission.signature') NOT GLOB '*[^1-9A-HJ-NP-Za-km-z]*'
        THEN json_extract(NEW.document_json, '$.receiptClaimWorkflowV1.submission.signature') ELSE NULL END),
    'pending', 1, 0, (CAST(strftime('%s', 'now') AS INTEGER) * 1000), NULL, NULL, (CAST(strftime('%s', 'now') AS INTEGER) * 1000) + 21600000,
    (CAST(strftime('%s', 'now') AS INTEGER) * 1000), (CAST(strftime('%s', 'now') AS INTEGER) * 1000), NULL, NULL, NULL
  ) ON CONFLICT(event_id) DO NOTHING;
END;

CREATE TRIGGER commerce_receipt_claim_failure_capture_update
AFTER UPDATE OF document_json, document_kind ON commerce_documents
WHEN NEW.document_kind = 'claim_code' AND NEW.status = 'processing'
  AND json_extract(NEW.document_json, '$.namespace') = 'stripe_receipt_v1'
  AND json_extract(NEW.document_json, '$.receiptClaimWorkflowV1.phase') IN ('failed', 'manual_review')
BEGIN
  INSERT INTO commerce_receipt_claim_failure_outbox (
    event_id, claim_path, incident_kind, operation_id, workflow_generation, snapshot_json,
    state, revision, attempt_count, next_attempt_at_ms, claim_id, claim_expires_at_ms,
    retry_until_ms, created_at_ms, updated_at_ms, job_json, queued_at_ms, last_error_code
  ) VALUES (
    json_extract(NEW.document_json, '$.receiptClaimWorkflowV1.operationId') || ':g' || json_extract(NEW.document_json, '$.receiptClaimWorkflowV1.generation'), NEW.document_path, 'workflow',
    json_extract(NEW.document_json, '$.receiptClaimWorkflowV1.operationId'), json_extract(NEW.document_json, '$.receiptClaimWorkflowV1.generation'),
    json_object('version', 1, 'dropId', json_extract(NEW.document_json, '$.dropId'), 'deliveryId', json_extract(NEW.document_json, '$.deliveryId'),
      'boxId', json_extract(NEW.document_json, '$.boxId'), 'recipient', json_extract(NEW.document_json, '$.recipient'),
      'operationId', json_extract(NEW.document_json, '$.receiptClaimWorkflowV1.operationId'), 'generation', json_extract(NEW.document_json, '$.receiptClaimWorkflowV1.generation'), 'phase', json_extract(NEW.document_json, '$.receiptClaimWorkflowV1.phase'),
      'errorCode', CASE WHEN json_extract(NEW.document_json, '$.receiptClaimWorkflowV1.error.code') IN ('invalid-argument', 'unauthenticated', 'permission-denied', 'not-found',
        'aborted', 'failed-precondition', 'resource-exhausted', 'deadline-exceeded', 'unavailable', 'internal')
        THEN json_extract(NEW.document_json, '$.receiptClaimWorkflowV1.error.code') ELSE 'internal' END,
      'createdAtMs', CASE WHEN json_type(NEW.document_json, '$.receiptClaimWorkflowV1.createdAtMs') = 'integer' AND json_extract(NEW.document_json, '$.receiptClaimWorkflowV1.createdAtMs') BETWEEN 0 AND 9007199254740991 THEN json_extract(NEW.document_json, '$.receiptClaimWorkflowV1.createdAtMs') ELSE NULL END, 'deadlineAtMs', CASE WHEN json_type(NEW.document_json, '$.receiptClaimWorkflowV1.deadlineAtMs') = 'integer' AND json_extract(NEW.document_json, '$.receiptClaimWorkflowV1.deadlineAtMs') BETWEEN 0 AND 9007199254740991 THEN json_extract(NEW.document_json, '$.receiptClaimWorkflowV1.deadlineAtMs') ELSE NULL END, 'failedAtMs', (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
      'processingStartedAtMs', CASE WHEN json_type(NEW.document_json, '$.processingStartedAt') = 'integer'
        AND json_extract(NEW.document_json, '$.processingStartedAt') BETWEEN 0 AND 9007199254740991 THEN json_extract(NEW.document_json, '$.processingStartedAt') ELSE NULL END,
      'signature', CASE WHEN json_type(NEW.document_json, '$.receiptClaimWorkflowV1.submission.signature') = 'text'
        AND length(json_extract(NEW.document_json, '$.receiptClaimWorkflowV1.submission.signature')) BETWEEN 64 AND 128
        AND json_extract(NEW.document_json, '$.receiptClaimWorkflowV1.submission.signature') NOT GLOB '*[^1-9A-HJ-NP-Za-km-z]*'
        THEN json_extract(NEW.document_json, '$.receiptClaimWorkflowV1.submission.signature') ELSE NULL END),
    'pending', 1, 0, (CAST(strftime('%s', 'now') AS INTEGER) * 1000), NULL, NULL, (CAST(strftime('%s', 'now') AS INTEGER) * 1000) + 21600000,
    (CAST(strftime('%s', 'now') AS INTEGER) * 1000), (CAST(strftime('%s', 'now') AS INTEGER) * 1000), NULL, NULL, NULL
  ) ON CONFLICT(event_id) DO NOTHING;
END;
