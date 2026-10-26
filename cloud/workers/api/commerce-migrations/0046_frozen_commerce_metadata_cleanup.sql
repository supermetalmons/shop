CREATE TABLE commerce_frozen_metadata_cleanup_guard (
  allowed INTEGER NOT NULL CONSTRAINT frozen_commerce_metadata_requires_maintenance CHECK (allowed = 1),
  complete INTEGER NOT NULL DEFAULT 1 CONSTRAINT frozen_commerce_metadata_requires_valid_state CHECK (complete = 1)
) STRICT;

INSERT INTO commerce_frozen_metadata_cleanup_guard (allowed)
SELECT EXISTS (
  SELECT 1 FROM commerce_authority_control AS authority
  WHERE authority.singleton = 1
    AND NOT EXISTS (SELECT 1 FROM commerce_authority_control_lease)
    AND NOT EXISTS (SELECT 1 FROM commerce_commit_guards)
    AND NOT EXISTS (SELECT 1 FROM commerce_wipe_guards)
    AND (
      (authority.authority_state = 'paused' AND authority.paused_at_ms IS NOT NULL
        AND EXISTS (SELECT 1 FROM commerce_notification_outbox_control WHERE singleton = 1 AND storage_mode = 'table' AND preparation_state = 'ready')
        AND EXISTS (SELECT 1 FROM commerce_stripe_checkout_state_control WHERE singleton = 1 AND storage_mode = 'table' AND preparation_state = 'ready')
        AND EXISTS (SELECT 1 FROM commerce_pack_status_outbox_control WHERE singleton = 1 AND storage_mode = 'table' AND preparation_state = 'ready')
        AND EXISTS (SELECT 1 FROM commerce_delivery_recovery_control WHERE singleton = 1 AND storage_mode = 'table' AND preparation_state = 'ready')
      ) OR (
        authority.authority_state = 'paused' AND authority.revision = 2
        AND authority.documents_revision = 0 AND authority.paused_at_ms IS NULL
        AND authority.dude_inventory_mode = 'legacy'
        AND EXISTS (SELECT 1 FROM commerce_notification_outbox_control WHERE singleton = 1 AND storage_mode = 'legacy' AND preparation_state = 'idle'
          AND source_documents_revision IS NULL AND prepared_at_ms IS NULL)
        AND EXISTS (SELECT 1 FROM commerce_stripe_checkout_state_control WHERE singleton = 1 AND storage_mode = 'legacy' AND preparation_state = 'idle'
          AND source_documents_revision IS NULL AND prepared_at_ms IS NULL)
        AND EXISTS (SELECT 1 FROM commerce_pack_status_outbox_control WHERE singleton = 1 AND storage_mode = 'legacy' AND preparation_state = 'idle'
          AND source_documents_revision IS NULL AND prepared_at_ms IS NULL)
        AND EXISTS (SELECT 1 FROM commerce_delivery_recovery_control WHERE singleton = 1 AND storage_mode = 'legacy' AND preparation_state = 'idle'
          AND source_documents_revision IS NULL AND prepared_at_ms IS NULL)
        AND NOT EXISTS (SELECT 1 FROM commerce_documents)
        AND NOT EXISTS (SELECT 1 FROM commerce_document_path_revisions)
        AND NOT EXISTS (SELECT 1 FROM commerce_delivery_owner_revisions)
        AND NOT EXISTS (SELECT 1 FROM commerce_inventory_drops)
        AND NOT EXISTS (SELECT 1 FROM commerce_available_dudes)
        AND NOT EXISTS (SELECT 1 FROM commerce_inventory_initializations)
        AND NOT EXISTS (SELECT 1 FROM commerce_notification_outbox)
        AND NOT EXISTS (SELECT 1 FROM commerce_notification_outbox_pending_owners)
        AND NOT EXISTS (SELECT 1 FROM commerce_notification_outbox_stripe_due)
        AND NOT EXISTS (SELECT 1 FROM commerce_stripe_checkout_state)
        AND NOT EXISTS (SELECT 1 FROM commerce_pack_status_outbox)
        AND NOT EXISTS (SELECT 1 FROM commerce_delivery_recovery)
        AND NOT EXISTS (SELECT 1 FROM commerce_preorder_orders)
        AND NOT EXISTS (SELECT 1 FROM commerce_preorder_claims)
        AND NOT EXISTS (SELECT 1 FROM commerce_preorder_asset_lookup)
        AND NOT EXISTS (SELECT 1 FROM stripe_order_disputes)
        AND NOT EXISTS (SELECT 1 FROM commerce_receipt_claim_failure_outbox)
        AND NOT EXISTS (SELECT 1 FROM ethereum_delivery_quotes)
        AND NOT EXISTS (SELECT 1 FROM ethereum_crate_claims)
        AND NOT EXISTS (SELECT 1 FROM ethereum_reconciliation_cursor)
        AND NOT EXISTS (SELECT 1 FROM ethereum_delivery_checkouts)
        AND NOT EXISTS (SELECT 1 FROM ethereum_delivery_checkout_attempts)
        AND EXISTS (SELECT 1 FROM ethereum_111k_control WHERE singleton = 1 AND paused = 1 AND revision = 1
          AND chain_id IS NULL AND contract_address IS NULL AND reset_guard_id IS NULL AND last_reset_id IS NULL)
      )
    )
);

INSERT INTO commerce_frozen_metadata_cleanup_guard (allowed, complete)
SELECT 1, NOT EXISTS (
  WITH fields (field, family, kind) AS (VALUES
    ('buyerOrderReceivedEmailState', 'ready', 'delivery_order'),
    ('buyerOrderReceivedEmailJobId', 'ready', 'delivery_order'),
    ('buyerOrderReceivedEmailJob', 'ready', 'delivery_order'),
    ('buyerOrderReceivedEmailIdempotencyKey', 'ready', 'delivery_order'),
    ('buyerOrderReceivedEmailQueuedAt', 'ready', 'delivery_order'),
    ('shipperReadyToShipEmailState', 'ready', 'delivery_order'),
    ('shipperReadyToShipEmailJobId', 'ready', 'delivery_order'),
    ('shipperReadyToShipEmailJob', 'ready', 'delivery_order'),
    ('shipperReadyToShipEmailIdempotencyKey', 'ready', 'delivery_order'),
    ('shipperReadyToShipEmailQueuedAt', 'ready', 'delivery_order'),
    ('readyToShipNotificationRetryUntilMs', 'ready', 'delivery_order'),
    ('readyToShipNotificationPublishAttemptCount', 'ready', 'delivery_order'),
    ('readyToShipNotificationPublishClaimId', 'ready', 'delivery_order'),
    ('readyToShipNotificationPublishClaimExpiresAtMs', 'ready', 'delivery_order'),
    ('readyToShipNotificationFailedAt', 'ready', 'delivery_order'),
    ('readyToShipNotificationLastErrorCode', 'ready', 'delivery_order'),
    ('stripeTerminalNotification', 'stripe_terminal', 'stripe_checkout'),
    ('stripeTerminalNotificationState', 'stripe_terminal', 'stripe_checkout'),
    ('stripeTerminalNotificationNextAttemptAtMs', 'stripe_terminal', 'stripe_checkout'),
    ('stripeTerminalNotificationQueuedAt', 'stripe_terminal', 'stripe_checkout'),
    ('stripeTerminalNotificationLastError', 'stripe_terminal', 'stripe_checkout'),
    ('buyerOrderShippedEmailState', 'shipped', 'delivery_order'),
    ('buyerOrderShippedEmailJobId', 'shipped', 'delivery_order'),
    ('buyerOrderShippedEmailIdempotencyKey', 'shipped', 'delivery_order'),
    ('buyerOrderShippedEmailQueuedAt', 'shipped', 'delivery_order'))
  SELECT 1 FROM commerce_documents AS document JOIN fields
    ON json_type(document.document_json, '$.' || fields.field) IS NOT NULL
  LEFT JOIN commerce_notification_outbox AS outbox
    ON outbox.parent_path = document.document_path AND outbox.family = fields.family
  WHERE document.document_kind <> fields.kind OR outbox.parent_path IS NULL OR outbox.drop_id IS NOT document.drop_id
);

INSERT INTO commerce_frozen_metadata_cleanup_guard (allowed, complete)
SELECT 1, NOT EXISTS (
  SELECT 1 FROM commerce_documents AS document LEFT JOIN commerce_pack_status_outbox AS outbox
    ON outbox.parent_path = document.document_path
  WHERE (json_type(document.document_json, '$.packStatusProjectionState') IS NOT NULL
    OR json_type(document.document_json, '$.packStatusProjectionNextAttemptAtMs') IS NOT NULL
    OR json_type(document.document_json, '$.packStatusProjectionFailureCount') IS NOT NULL
    OR json_type(document.document_json, '$.packStatusProjectionCompletedAt') IS NOT NULL
    OR json_type(document.document_json, '$.packStatusProjectionFailedAt') IS NOT NULL
    OR json_type(document.document_json, '$.packStatusProjectionLastErrorCode') IS NOT NULL)
    AND (document.document_kind <> 'delivery_order' OR outbox.parent_path IS NULL OR outbox.drop_id IS NOT document.drop_id)
);

INSERT INTO commerce_frozen_metadata_cleanup_guard (allowed, complete)
SELECT 1, NOT EXISTS (
  SELECT 1 FROM commerce_documents AS document LEFT JOIN commerce_stripe_checkout_state AS state
    ON state.document_path = document.document_path
  WHERE document.document_kind = 'stripe_checkout'
    AND (state.document_path IS NULL OR state.document_version IS NOT document.version)
);

INSERT INTO commerce_frozen_metadata_cleanup_guard (allowed, complete)
SELECT 1, NOT EXISTS (
  SELECT 1 FROM commerce_stripe_checkout_state AS state LEFT JOIN commerce_documents AS document
    ON document.document_path = state.document_path
  WHERE document.document_kind IS NOT 'stripe_checkout' OR state.document_version IS NOT document.version
    OR state.document_path <> 'drops/' || document.drop_id || '/stripeCheckouts/' || document.document_id
);

INSERT INTO commerce_frozen_metadata_cleanup_guard (allowed, complete)
SELECT 1, NOT EXISTS (
  SELECT 1 FROM commerce_documents AS document LEFT JOIN commerce_delivery_recovery AS state
    ON state.parent_path = document.document_path
  WHERE document.document_kind = 'delivery_order' AND state.parent_path IS NULL
  UNION ALL
  SELECT 1 FROM commerce_delivery_recovery AS state LEFT JOIN commerce_documents AS document
    ON document.document_path = state.parent_path WHERE document.document_kind IS NOT 'delivery_order'
);

INSERT INTO commerce_frozen_metadata_cleanup_guard (allowed, complete)
SELECT 1, NOT EXISTS (
  SELECT 1 FROM commerce_pack_status_outbox AS outbox LEFT JOIN commerce_documents AS document
    ON document.document_path = outbox.parent_path
  WHERE document.document_kind IS NOT 'delivery_order' OR document.drop_id IS NOT outbox.drop_id
    OR outbox.parent_path <> 'drops/' || outbox.drop_id || '/deliveryOrders/' || document.document_id
    OR document.document_id = '' OR document.document_id GLOB '*[^!-~]*' OR instr(document.document_id, '/') > 0
    OR outbox.drop_id = '' OR outbox.drop_id GLOB '*[^!-~]*' OR instr(outbox.drop_id, '/') > 0
    OR NOT (typeof(outbox.generation) = 'text' AND length(outbox.generation) = 36
      AND length(CAST(outbox.generation AS BLOB)) = 36
      AND substr(outbox.generation, 9, 1) = '-' AND substr(outbox.generation, 14, 1) = '-'
      AND substr(outbox.generation, 19, 1) = '-' AND substr(outbox.generation, 24, 1) = '-'
      AND length(replace(outbox.generation, '-', '')) = 32
      AND lower(replace(outbox.generation, '-', '')) NOT GLOB '*[^0-9a-f]*'
      AND substr(outbox.generation, 15, 1) GLOB '4'
      AND lower(substr(outbox.generation, 20, 1)) GLOB '[89ab]')
);

INSERT INTO commerce_frozen_metadata_cleanup_guard (allowed, complete)
SELECT 1, NOT EXISTS (
  SELECT 1 FROM commerce_notification_outbox AS outbox LEFT JOIN commerce_documents AS document
    ON document.document_path = outbox.parent_path
  WHERE document.document_kind IS NOT CASE WHEN outbox.family = 'stripe_terminal' THEN 'stripe_checkout' ELSE 'delivery_order' END
    OR document.drop_id IS NOT outbox.drop_id OR length(outbox.parent_path) > 1500
    OR outbox.parent_path <> 'drops/' || outbox.drop_id || '/' ||
      CASE WHEN outbox.family = 'stripe_terminal' THEN 'stripeCheckouts/' ELSE 'deliveryOrders/' END || document.document_id
    OR document.document_id = '' OR instr(document.document_id, '/') > 0
    OR outbox.drop_id GLOB '*[^a-z0-9_-]*' OR substr(outbox.drop_id, 1, 1) NOT GLOB '[a-z0-9]'
    OR NOT (typeof(outbox.generation) = 'text' AND length(outbox.generation) = 36
      AND length(CAST(outbox.generation AS BLOB)) = 36
      AND substr(outbox.generation, 9, 1) = '-' AND substr(outbox.generation, 14, 1) = '-'
      AND substr(outbox.generation, 19, 1) = '-' AND substr(outbox.generation, 24, 1) = '-'
      AND length(replace(outbox.generation, '-', '')) = 32
      AND lower(replace(outbox.generation, '-', '')) NOT GLOB '*[^0-9a-f]*'
      AND substr(outbox.generation, 15, 1) GLOB '[1-8]'
      AND lower(substr(outbox.generation, 20, 1)) GLOB '[89ab]')
    OR (outbox.claim_id IS NOT NULL AND NOT (typeof(outbox.claim_id) = 'text' AND length(outbox.claim_id) = 36
      AND length(CAST(outbox.claim_id AS BLOB)) = 36
      AND substr(outbox.claim_id, 9, 1) = '-' AND substr(outbox.claim_id, 14, 1) = '-'
      AND substr(outbox.claim_id, 19, 1) = '-' AND substr(outbox.claim_id, 24, 1) = '-'
      AND length(replace(outbox.claim_id, '-', '')) = 32
      AND lower(replace(outbox.claim_id, '-', '')) NOT GLOB '*[^0-9a-f]*'
      AND substr(outbox.claim_id, 15, 1) GLOB '[1-8]'
      AND lower(substr(outbox.claim_id, 20, 1)) GLOB '[89ab]'))
    OR (outbox.state IN ('queued', 'cancelled') AND outbox.claim_id IS NOT NULL)
    OR (outbox.state = 'pending' AND outbox.claim_expires_at_ms IS NOT NULL
      AND outbox.next_attempt_at_ms IS NOT outbox.claim_expires_at_ms)
    OR (outbox.state <> 'cancelled' AND outbox.state <> CASE
      WHEN EXISTS (SELECT 1 FROM json_each(outbox.entries_json) WHERE json_extract(value, '$.state') = 'pending') THEN 'pending'
      WHEN EXISTS (SELECT 1 FROM json_each(outbox.entries_json) WHERE json_extract(value, '$.state') = 'failed') THEN 'failed'
      ELSE 'queued' END )
    OR (SELECT COUNT(DISTINCT json_extract(value, '$.kind')) FROM json_each(outbox.entries_json)) <> json_array_length(outbox.entries_json)
);

INSERT INTO commerce_frozen_metadata_cleanup_guard (allowed, complete)
SELECT 1, NOT EXISTS (
  SELECT 1 FROM commerce_notification_outbox AS outbox, json_each(outbox.entries_json) AS entry
  WHERE entry.type <> 'object'
    OR EXISTS (SELECT 1 FROM json_each(entry.value) WHERE key NOT IN ('kind', 'jobId', 'idempotencyKey', 'state', 'payload', 'queuedAtMs', 'errorCode'))
    OR json_type(entry.value, '$.kind') IS NOT 'text' OR json_extract(entry.value, '$.kind') NOT IN (
      CASE WHEN outbox.family = 'shipped' THEN 'buyer_order_shipped'
        WHEN outbox.outcome = 'manual_review' THEN 'stripe_checkout_manual_review' ELSE 'buyer_order_received' END ,
      CASE WHEN outbox.family = 'shipped' THEN 'buyer_order_shipped'
        WHEN outbox.outcome = 'manual_review' THEN 'stripe_checkout_manual_review' ELSE 'shipper_ready_to_ship' END )
    OR NOT (typeof(json_extract(entry.value, '$.jobId')) = 'text' AND length(json_extract(entry.value, '$.jobId')) = 36
      AND length(CAST(json_extract(entry.value, '$.jobId') AS BLOB)) = 36
      AND substr(json_extract(entry.value, '$.jobId'), 9, 1) = '-' AND substr(json_extract(entry.value, '$.jobId'), 14, 1) = '-'
      AND substr(json_extract(entry.value, '$.jobId'), 19, 1) = '-' AND substr(json_extract(entry.value, '$.jobId'), 24, 1) = '-'
      AND length(replace(json_extract(entry.value, '$.jobId'), '-', '')) = 32
      AND lower(replace(json_extract(entry.value, '$.jobId'), '-', '')) NOT GLOB '*[^0-9a-f]*'
      AND substr(json_extract(entry.value, '$.jobId'), 15, 1) GLOB '[1-8]'
      AND lower(substr(json_extract(entry.value, '$.jobId'), 20, 1)) GLOB '[89ab]')
    OR json_type(entry.value, '$.idempotencyKey') IS NOT 'text' OR length(json_extract(entry.value, '$.idempotencyKey')) NOT BETWEEN 1 AND 256
    OR json_extract(entry.value, '$.idempotencyKey') GLOB '*[^!-~]*'
    OR json_type(entry.value, '$.state') IS NOT 'text' OR json_extract(entry.value, '$.state') NOT IN ('pending', 'queued', 'failed')
    OR (json_type(entry.value, '$.queuedAtMs') IS NOT NULL AND (json_type(entry.value, '$.queuedAtMs') IS NOT 'integer' OR json_extract(entry.value, '$.queuedAtMs') NOT BETWEEN 0 AND 9007199254740991))
    OR (json_type(entry.value, '$.errorCode') IS NOT NULL AND (json_type(entry.value, '$.errorCode') IS NOT 'text' OR length(json_extract(entry.value, '$.errorCode')) NOT BETWEEN 1 AND 256))
    OR (json_type(entry.value, '$.payload') IS NOT NULL AND (json_type(entry.value, '$.payload') IS NOT 'object' OR outbox.state = 'cancelled' OR json_extract(entry.value, '$.state') = 'queued'))
);

INSERT INTO commerce_frozen_metadata_cleanup_guard (allowed, complete)
SELECT 1, NOT EXISTS (
  WITH payloads AS (
    SELECT outbox.drop_id, entry.value AS entry, json_extract(entry.value, '$.payload') AS payload
    FROM commerce_notification_outbox AS outbox, json_each(outbox.entries_json) AS entry
    WHERE json_type(entry.value, '$.payload') IS NOT NULL
  )
  SELECT 1 FROM payloads
  WHERE (SELECT COUNT(*) FROM json_each(payload)) <> 9
    OR EXISTS (SELECT 1 FROM json_each(payload) WHERE key NOT IN
      ('version', 'jobId', 'kind', 'idempotencyKey', 'recipients', 'subject', 'text', 'html', 'context'))
    OR json_extract(payload, '$.version') IS NOT 1
    OR json_extract(payload, '$.jobId') IS NOT json_extract(entry, '$.jobId')
    OR json_extract(payload, '$.kind') IS NOT json_extract(entry, '$.kind')
    OR json_extract(payload, '$.idempotencyKey') IS NOT json_extract(entry, '$.idempotencyKey')
    OR json_type(payload, '$.recipients') IS NOT 'array' OR json_array_length(payload, '$.recipients') NOT BETWEEN 1 AND 16
    OR (SELECT COUNT(DISTINCT lower(value)) FROM json_each(payload, '$.recipients')) <> json_array_length(payload, '$.recipients')
    OR json_type(payload, '$.subject') IS NOT 'text' OR length(json_extract(payload, '$.subject')) NOT BETWEEN 1 AND 512
    OR json_type(payload, '$.text') IS NOT 'text' OR length(CAST(json_extract(payload, '$.text') AS BLOB)) NOT BETWEEN 1 AND 32768
    OR json_type(payload, '$.html') IS NOT 'text' OR length(CAST(json_extract(payload, '$.html') AS BLOB)) NOT BETWEEN 1 AND 65536
    OR length(CAST(payload AS BLOB)) > 98304
    OR json_type(payload, '$.context') IS NOT 'object'
    OR EXISTS (SELECT 1 FROM json_each(payload, '$.context') WHERE key NOT IN ('dropId', 'deliveryId', 'sessionId'))
    OR json_extract(payload, '$.context.dropId') IS NOT drop_id OR drop_id GLOB '*[^a-z0-9_]*'
    OR CASE WHEN json_extract(payload, '$.kind') = 'stripe_checkout_manual_review'
      THEN json_type(payload, '$.context.deliveryId') IS NOT NULL
        OR json_type(payload, '$.context.sessionId') IS NOT 'text'
        OR length(json_extract(payload, '$.context.sessionId')) NOT BETWEEN 1 AND 255
        OR json_extract(payload, '$.context.sessionId') GLOB '*[^A-Za-z0-9_]*'
      ELSE json_type(payload, '$.context.sessionId') IS NOT NULL
        OR json_type(payload, '$.context.deliveryId') IS NOT 'integer'
        OR json_extract(payload, '$.context.deliveryId') NOT BETWEEN 1 AND 9007199254740991 END
);

INSERT INTO commerce_frozen_metadata_cleanup_guard (allowed, complete)
SELECT 1, NOT EXISTS (
  WITH RECURSIVE recipients AS (
    SELECT recipient.type, recipient.value AS email,
      substr(recipient.value, 1, instr(recipient.value, '@') - 1) AS local,
      substr(recipient.value, instr(recipient.value, '@') + 1) AS domain
    FROM commerce_notification_outbox AS outbox, json_each(outbox.entries_json) AS entry,
      json_each(entry.value, '$.payload.recipients') AS recipient
  ), domains (label, remaining) AS (
    SELECT '', domain FROM recipients
    UNION ALL
    SELECT CASE WHEN instr(remaining, '.') > 0 THEN substr(remaining, 1, instr(remaining, '.') - 1) ELSE remaining END ,
      CASE WHEN instr(remaining, '.') > 0 THEN substr(remaining, instr(remaining, '.') + 1) ELSE '' END
    FROM domains WHERE remaining <> ''
  )
  SELECT 1 FROM recipients
  WHERE type <> 'text' OR length(email) NOT BETWEEN 3 AND 254 OR instr(email, '@') < 2
    OR instr(domain, '@') > 0 OR instr(domain, '.') = 0 OR substr(domain, -1) = '.'
    OR local GLOB '*[^A-Za-z0-9_+''.-]*' OR substr(local, 1, 1) = '.' OR instr(local, '..') > 0
    OR substr(local, -1) NOT GLOB '[A-Za-z0-9_+-]'
  UNION ALL
  SELECT 1 FROM domains WHERE label <> '' AND
    ( CASE WHEN remaining = '' THEN length(label) < 2 OR label GLOB '*[^A-Za-z]*'
      ELSE substr(label, 1, 1) NOT GLOB '[A-Za-z0-9]' OR label GLOB '*[^A-Za-z0-9-]*' END )
  UNION ALL
  SELECT 1 FROM recipients WHERE domain GLOB '.*' OR instr(domain, '..') > 0
);

INSERT INTO commerce_frozen_metadata_cleanup_guard (allowed, complete)
SELECT 1, NOT EXISTS (
  SELECT 1 FROM commerce_notification_outbox WHERE (typeof(revision) <> 'integer' OR revision NOT BETWEEN 1 AND 9007199254740991)
    OR (typeof(attempt_count) <> 'integer' OR attempt_count NOT BETWEEN 0 AND 9007199254740991)
    OR (typeof(retry_until_ms) <> 'integer' OR retry_until_ms NOT BETWEEN 0 AND 9007199254740991)
    OR (typeof(created_at_ms) <> 'integer' OR created_at_ms NOT BETWEEN 0 AND 9007199254740991)
    OR (typeof(updated_at_ms) <> 'integer' OR updated_at_ms NOT BETWEEN 0 AND 9007199254740991)
    OR ((next_attempt_at_ms IS NOT NULL AND (typeof(next_attempt_at_ms) <> 'integer' OR next_attempt_at_ms NOT BETWEEN 0 AND 9007199254740991)))
    OR ((claim_expires_at_ms IS NOT NULL AND (typeof(claim_expires_at_ms) <> 'integer' OR claim_expires_at_ms NOT BETWEEN 0 AND 9007199254740991)))
    OR (updated_at_ms < created_at_ms)
    OR ((last_error_code IS NOT NULL AND (typeof(last_error_code) <> 'text' OR length(last_error_code) NOT BETWEEN 1 AND 256)))
    OR ((state = 'pending') <> (next_attempt_at_ms IS NOT NULL))
    OR (state NOT IN ('pending', 'queued', 'failed', 'cancelled'))
    OR ((claim_id IS NULL AND claim_expires_at_ms IS NOT NULL))
    OR ((state <> 'failed' AND (claim_id IS NULL) <> (claim_expires_at_ms IS NULL)))
    OR (json_type(entries_json) IS NOT 'array' OR json_array_length(entries_json) NOT BETWEEN 1 AND 2 OR length(CAST(entries_json AS BLOB)) > 204800)
);

INSERT INTO commerce_frozen_metadata_cleanup_guard (allowed, complete)
SELECT 1, NOT EXISTS (
  SELECT 1 FROM commerce_pack_status_outbox WHERE (typeof(revision) <> 'integer' OR revision NOT BETWEEN 1 AND 9007199254740991)
    OR (typeof(failure_count) <> 'integer' OR failure_count NOT BETWEEN 0 AND 9007199254740991)
    OR (typeof(created_at_ms) <> 'integer' OR created_at_ms NOT BETWEEN 0 AND 9007199254740991)
    OR (typeof(updated_at_ms) <> 'integer' OR updated_at_ms NOT BETWEEN 0 AND 9007199254740991)
    OR ((next_attempt_at_ms IS NOT NULL AND (typeof(next_attempt_at_ms) <> 'integer' OR next_attempt_at_ms NOT BETWEEN 0 AND 9007199254740991)))
    OR ((completed_at_ms IS NOT NULL AND (typeof(completed_at_ms) <> 'integer' OR completed_at_ms NOT BETWEEN 0 AND 9007199254740991)))
    OR ((failed_at_ms IS NOT NULL AND (typeof(failed_at_ms) <> 'integer' OR failed_at_ms NOT BETWEEN 0 AND 9007199254740991)))
    OR (updated_at_ms < created_at_ms)
    OR ((last_error_code IS NOT NULL AND (typeof(last_error_code) <> 'text' OR length(last_error_code) NOT BETWEEN 1 AND 256)))
    OR ((state = 'pending') <> (next_attempt_at_ms IS NOT NULL))
    OR (state NOT IN ('pending', 'completed', 'failed', 'cancelled'))
    OR ((state <> 'completed' AND completed_at_ms IS NOT NULL))
    OR ((state <> 'failed' AND failed_at_ms IS NOT NULL))
);

INSERT INTO commerce_frozen_metadata_cleanup_guard (allowed, complete)
SELECT 1, NOT EXISTS (
  SELECT 1 FROM commerce_stripe_checkout_state WHERE (typeof(document_version) <> 'integer' OR document_version NOT BETWEEN 1 AND 9007199254740991)
    OR ((processing_attempt_count IS NOT NULL AND (typeof(processing_attempt_count) <> 'integer' OR processing_attempt_count NOT BETWEEN 0 AND 9007199254740991)))
    OR ((processing_started_at_ms IS NOT NULL AND (typeof(processing_started_at_ms) <> 'integer' OR processing_started_at_ms NOT BETWEEN 0 AND 9007199254740991)))
    OR ((processing_lease_expires_at_ms IS NOT NULL AND (typeof(processing_lease_expires_at_ms) <> 'integer' OR processing_lease_expires_at_ms NOT BETWEEN 0 AND 9007199254740991)))
    OR ((last_retryable_fulfillment_attempt IS NOT NULL AND (typeof(last_retryable_fulfillment_attempt) <> 'integer' OR last_retryable_fulfillment_attempt NOT BETWEEN 0 AND 9007199254740991)))
    OR ((last_retryable_fulfillment_error_at_ms IS NOT NULL AND (typeof(last_retryable_fulfillment_error_at_ms) <> 'integer' OR last_retryable_fulfillment_error_at_ms NOT BETWEEN 0 AND 9007199254740991)))
    OR ((next_fulfillment_retry_at_ms IS NOT NULL AND (typeof(next_fulfillment_retry_at_ms) <> 'integer' OR next_fulfillment_retry_at_ms NOT BETWEEN 0 AND 9007199254740991)))
    OR ((fulfillment_queue_reenqueued_at_ms IS NOT NULL AND (typeof(fulfillment_queue_reenqueued_at_ms) <> 'integer' OR fulfillment_queue_reenqueued_at_ms NOT BETWEEN 0 AND 9007199254740991)))
    OR ((last_fulfillment_reconciliation_error_at_ms IS NOT NULL AND (typeof(last_fulfillment_reconciliation_error_at_ms) <> 'integer' OR last_fulfillment_reconciliation_error_at_ms NOT BETWEEN 0 AND 9007199254740991)))
    OR ((updated_at_ms IS NOT NULL AND (typeof(updated_at_ms) <> 'integer' OR updated_at_ms NOT BETWEEN 0 AND 9007199254740991)))
    OR (status NOT IN ('created', 'fulfillment_pending', 'processing', 'fulfilled', 'fulfillment_failed'))
    OR ((processing_attempt_id IS NOT NULL AND (typeof(processing_attempt_id) <> 'text' OR length(processing_attempt_id) NOT BETWEEN 1 AND 128)))
);

DROP TRIGGER commerce_documents_update_authority_guard;
DROP TRIGGER commerce_documents_version_update_guard;
DROP TRIGGER commerce_document_path_revision_update;
DROP TRIGGER commerce_delivery_recovery_parent_update_guard;
DROP TRIGGER commerce_notification_outbox_pending_owner_source;
DROP TRIGGER commerce_notification_outbox_stripe_due_source;
DROP TRIGGER commerce_notification_legacy_insert_fence;
DROP TRIGGER commerce_notification_legacy_update_fence;
DROP TRIGGER commerce_pack_status_legacy_insert_fence;
DROP TRIGGER commerce_pack_status_legacy_update_fence;
DROP TRIGGER commerce_stripe_checkout_parent_insert_guard;
DROP TRIGGER commerce_stripe_checkout_parent_update_guard;

UPDATE commerce_documents
SET document_json = json_remove(document_json,
  '$.buyerOrderReceivedEmailState',
  '$.buyerOrderReceivedEmailJobId',
  '$.buyerOrderReceivedEmailJob',
  '$.buyerOrderReceivedEmailIdempotencyKey',
  '$.buyerOrderReceivedEmailQueuedAt',
  '$.shipperReadyToShipEmailState',
  '$.shipperReadyToShipEmailJobId',
  '$.shipperReadyToShipEmailJob',
  '$.shipperReadyToShipEmailIdempotencyKey',
  '$.shipperReadyToShipEmailQueuedAt',
  '$.readyToShipNotificationRetryUntilMs',
  '$.readyToShipNotificationPublishAttemptCount',
  '$.readyToShipNotificationPublishClaimId',
  '$.readyToShipNotificationPublishClaimExpiresAtMs',
  '$.readyToShipNotificationFailedAt',
  '$.readyToShipNotificationLastErrorCode',
  '$.stripeTerminalNotification',
  '$.stripeTerminalNotificationState',
  '$.stripeTerminalNotificationNextAttemptAtMs',
  '$.stripeTerminalNotificationQueuedAt',
  '$.stripeTerminalNotificationLastError',
  '$.buyerOrderShippedEmailState',
  '$.buyerOrderShippedEmailJobId',
  '$.buyerOrderShippedEmailIdempotencyKey',
  '$.buyerOrderShippedEmailQueuedAt')
WHERE (json_type(document_json, '$.buyerOrderReceivedEmailState') IS NOT NULL
    OR json_type(document_json, '$.buyerOrderReceivedEmailJobId') IS NOT NULL
    OR json_type(document_json, '$.buyerOrderReceivedEmailJob') IS NOT NULL
    OR json_type(document_json, '$.buyerOrderReceivedEmailIdempotencyKey') IS NOT NULL
    OR json_type(document_json, '$.buyerOrderReceivedEmailQueuedAt') IS NOT NULL
    OR json_type(document_json, '$.shipperReadyToShipEmailState') IS NOT NULL
    OR json_type(document_json, '$.shipperReadyToShipEmailJobId') IS NOT NULL
    OR json_type(document_json, '$.shipperReadyToShipEmailJob') IS NOT NULL
    OR json_type(document_json, '$.shipperReadyToShipEmailIdempotencyKey') IS NOT NULL
    OR json_type(document_json, '$.shipperReadyToShipEmailQueuedAt') IS NOT NULL
    OR json_type(document_json, '$.readyToShipNotificationRetryUntilMs') IS NOT NULL
    OR json_type(document_json, '$.readyToShipNotificationPublishAttemptCount') IS NOT NULL
    OR json_type(document_json, '$.readyToShipNotificationPublishClaimId') IS NOT NULL
    OR json_type(document_json, '$.readyToShipNotificationPublishClaimExpiresAtMs') IS NOT NULL
    OR json_type(document_json, '$.readyToShipNotificationFailedAt') IS NOT NULL
    OR json_type(document_json, '$.readyToShipNotificationLastErrorCode') IS NOT NULL
    OR json_type(document_json, '$.stripeTerminalNotification') IS NOT NULL
    OR json_type(document_json, '$.stripeTerminalNotificationState') IS NOT NULL
    OR json_type(document_json, '$.stripeTerminalNotificationNextAttemptAtMs') IS NOT NULL
    OR json_type(document_json, '$.stripeTerminalNotificationQueuedAt') IS NOT NULL
    OR json_type(document_json, '$.stripeTerminalNotificationLastError') IS NOT NULL
    OR json_type(document_json, '$.buyerOrderShippedEmailState') IS NOT NULL
    OR json_type(document_json, '$.buyerOrderShippedEmailJobId') IS NOT NULL
    OR json_type(document_json, '$.buyerOrderShippedEmailIdempotencyKey') IS NOT NULL
    OR json_type(document_json, '$.buyerOrderShippedEmailQueuedAt') IS NOT NULL);

UPDATE commerce_documents
SET document_json = json_remove(document_json,
  '$.status',
  '$.processingAttemptId',
  '$.processingAttemptCount',
  '$.processingStartedAt',
  '$.processingLeaseExpiresAt',
  '$.lastRetryableFulfillmentAttempt',
  '$.lastRetryableFulfillmentErrorAt',
  '$.nextFulfillmentRetryAt',
  '$.fulfillmentQueueReenqueuedAt',
  '$.lastFulfillmentReconciliationErrorAt',
  '$.updatedAt')
WHERE document_kind = 'stripe_checkout' AND (json_type(document_json, '$.status') IS NOT NULL
    OR json_type(document_json, '$.processingAttemptId') IS NOT NULL
    OR json_type(document_json, '$.processingAttemptCount') IS NOT NULL
    OR json_type(document_json, '$.processingStartedAt') IS NOT NULL
    OR json_type(document_json, '$.processingLeaseExpiresAt') IS NOT NULL
    OR json_type(document_json, '$.lastRetryableFulfillmentAttempt') IS NOT NULL
    OR json_type(document_json, '$.lastRetryableFulfillmentErrorAt') IS NOT NULL
    OR json_type(document_json, '$.nextFulfillmentRetryAt') IS NOT NULL
    OR json_type(document_json, '$.fulfillmentQueueReenqueuedAt') IS NOT NULL
    OR json_type(document_json, '$.lastFulfillmentReconciliationErrorAt') IS NOT NULL
    OR json_type(document_json, '$.updatedAt') IS NOT NULL);

UPDATE commerce_documents
SET document_json = json_remove(document_json,
  '$.packStatusProjectionState',
  '$.packStatusProjectionNextAttemptAtMs',
  '$.packStatusProjectionFailureCount',
  '$.packStatusProjectionCompletedAt',
  '$.packStatusProjectionFailedAt',
  '$.packStatusProjectionLastErrorCode')
WHERE (json_type(document_json, '$.packStatusProjectionState') IS NOT NULL
    OR json_type(document_json, '$.packStatusProjectionNextAttemptAtMs') IS NOT NULL
    OR json_type(document_json, '$.packStatusProjectionFailureCount') IS NOT NULL
    OR json_type(document_json, '$.packStatusProjectionCompletedAt') IS NOT NULL
    OR json_type(document_json, '$.packStatusProjectionFailedAt') IS NOT NULL
    OR json_type(document_json, '$.packStatusProjectionLastErrorCode') IS NOT NULL);

CREATE TRIGGER commerce_documents_update_authority_guard
BEFORE UPDATE ON commerce_documents
WHEN (SELECT authority_state FROM commerce_authority_control WHERE singleton = 1) <> 'd1'
BEGIN
  SELECT RAISE(ABORT, 'commerce authority is not d1');
END;

CREATE TRIGGER commerce_documents_version_update_guard
AFTER UPDATE ON commerce_documents
WHEN NEW.version <= OLD.version
BEGIN
  SELECT RAISE(ABORT, 'commerce transaction conflict: commerce document version must increase');
END;

CREATE TRIGGER commerce_document_path_revision_update
AFTER UPDATE ON commerce_documents
BEGIN
  INSERT INTO commerce_document_path_revisions (document_path, revision)
  VALUES (
    NEW.document_path,
    (SELECT documents_revision + 1 FROM commerce_authority_control WHERE singleton = 1)
  )
  ON CONFLICT(document_path) DO UPDATE SET revision = excluded.revision
  WHERE commerce_document_path_revisions.revision < excluded.revision;
END;

CREATE TRIGGER commerce_delivery_recovery_parent_update_guard
BEFORE UPDATE ON commerce_documents
WHEN OLD.document_kind = 'delivery_order' OR NEW.document_kind = 'delivery_order'
BEGIN
  SELECT ( CASE WHEN json_type(NEW.document_json, '$.receiptRecovery') IS NOT NULL
    THEN RAISE(ABORT, 'legacy delivery recovery writes are disabled') END );
  SELECT ( CASE WHEN (SELECT storage_mode FROM commerce_delivery_recovery_control WHERE singleton = 1) = 'table'
    AND (NEW.document_path IS NOT OLD.document_path OR NEW.document_kind IS NOT OLD.document_kind)
    THEN RAISE(ABORT, 'delivery recovery parent identity is immutable') END );
  SELECT ( CASE WHEN (SELECT storage_mode FROM commerce_delivery_recovery_control WHERE singleton = 1) = 'table'
    AND NOT EXISTS (SELECT 1 FROM commerce_commit_guards AS guard, json_each(guard.delivery_recovery_paths_json) AS path
      WHERE path.value = NEW.document_path)
    THEN RAISE(ABORT, 'delivery recovery parent requires a guarded write') END );
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
    AND document.document_kind = 'stripe_checkout' AND ((outbox.outcome = 'fulfilled' AND ( CASE WHEN (SELECT storage_mode FROM commerce_stripe_checkout_state_control WHERE singleton = 1) = 'table' THEN state.status ELSE document.status END ) = 'fulfilled') OR
      (outbox.outcome = 'manual_review' AND ( CASE WHEN (SELECT storage_mode FROM commerce_stripe_checkout_state_control WHERE singleton = 1) = 'table' THEN state.status ELSE document.status END ) = 'fulfillment_failed' AND document.manual_refund_review_required = 1));
END;

CREATE TRIGGER commerce_notification_legacy_insert_fence
BEFORE INSERT ON commerce_documents
WHEN (json_type(NEW.document_json, '$.buyerOrderReceivedEmailState') IS NOT NULL
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
BEFORE UPDATE ON commerce_documents
WHEN (json_type(NEW.document_json, '$.buyerOrderReceivedEmailState') IS NOT NULL
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

CREATE TRIGGER commerce_pack_status_legacy_insert_fence
BEFORE INSERT ON commerce_documents
WHEN (json_type(NEW.document_json, '$.packStatusProjectionState') IS NOT NULL
    OR json_type(NEW.document_json, '$.packStatusProjectionNextAttemptAtMs') IS NOT NULL
    OR json_type(NEW.document_json, '$.packStatusProjectionFailureCount') IS NOT NULL
    OR json_type(NEW.document_json, '$.packStatusProjectionCompletedAt') IS NOT NULL
    OR json_type(NEW.document_json, '$.packStatusProjectionFailedAt') IS NOT NULL
    OR json_type(NEW.document_json, '$.packStatusProjectionLastErrorCode') IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'legacy pack-status projection writes are disabled');
END;

CREATE TRIGGER commerce_pack_status_legacy_update_fence
BEFORE UPDATE ON commerce_documents
WHEN (json_type(NEW.document_json, '$.packStatusProjectionState') IS NOT NULL
    OR json_type(NEW.document_json, '$.packStatusProjectionNextAttemptAtMs') IS NOT NULL
    OR json_type(NEW.document_json, '$.packStatusProjectionFailureCount') IS NOT NULL
    OR json_type(NEW.document_json, '$.packStatusProjectionCompletedAt') IS NOT NULL
    OR json_type(NEW.document_json, '$.packStatusProjectionFailedAt') IS NOT NULL
    OR json_type(NEW.document_json, '$.packStatusProjectionLastErrorCode') IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'legacy pack-status projection writes are disabled');
END;

CREATE TRIGGER commerce_stripe_checkout_parent_insert_guard
BEFORE INSERT ON commerce_documents
WHEN NEW.document_kind = 'stripe_checkout'
BEGIN
  SELECT ( CASE WHEN (json_type(NEW.document_json, '$.status') IS NOT NULL
    OR json_type(NEW.document_json, '$.processingAttemptId') IS NOT NULL
    OR json_type(NEW.document_json, '$.processingAttemptCount') IS NOT NULL
    OR json_type(NEW.document_json, '$.processingStartedAt') IS NOT NULL
    OR json_type(NEW.document_json, '$.processingLeaseExpiresAt') IS NOT NULL
    OR json_type(NEW.document_json, '$.lastRetryableFulfillmentAttempt') IS NOT NULL
    OR json_type(NEW.document_json, '$.lastRetryableFulfillmentErrorAt') IS NOT NULL
    OR json_type(NEW.document_json, '$.nextFulfillmentRetryAt') IS NOT NULL
    OR json_type(NEW.document_json, '$.fulfillmentQueueReenqueuedAt') IS NOT NULL
    OR json_type(NEW.document_json, '$.lastFulfillmentReconciliationErrorAt') IS NOT NULL
    OR json_type(NEW.document_json, '$.updatedAt') IS NOT NULL)
    THEN RAISE(ABORT, 'legacy stripe checkout state writes are disabled') END );
  SELECT ( CASE WHEN (SELECT storage_mode FROM commerce_stripe_checkout_state_control WHERE singleton = 1) = 'table'
    AND NOT EXISTS (SELECT 1 FROM commerce_commit_guards AS guard, json_each(guard.stripe_checkout_paths_json) AS path
      WHERE path.value = NEW.document_path) THEN RAISE(ABORT, 'stripe checkout state is unavailable') END );
END;

CREATE TRIGGER commerce_stripe_checkout_parent_update_guard
BEFORE UPDATE ON commerce_documents
WHEN OLD.document_kind = 'stripe_checkout' OR NEW.document_kind = 'stripe_checkout'
BEGIN
  SELECT ( CASE WHEN (json_type(NEW.document_json, '$.status') IS NOT NULL
    OR json_type(NEW.document_json, '$.processingAttemptId') IS NOT NULL
    OR json_type(NEW.document_json, '$.processingAttemptCount') IS NOT NULL
    OR json_type(NEW.document_json, '$.processingStartedAt') IS NOT NULL
    OR json_type(NEW.document_json, '$.processingLeaseExpiresAt') IS NOT NULL
    OR json_type(NEW.document_json, '$.lastRetryableFulfillmentAttempt') IS NOT NULL
    OR json_type(NEW.document_json, '$.lastRetryableFulfillmentErrorAt') IS NOT NULL
    OR json_type(NEW.document_json, '$.nextFulfillmentRetryAt') IS NOT NULL
    OR json_type(NEW.document_json, '$.fulfillmentQueueReenqueuedAt') IS NOT NULL
    OR json_type(NEW.document_json, '$.lastFulfillmentReconciliationErrorAt') IS NOT NULL
    OR json_type(NEW.document_json, '$.updatedAt') IS NOT NULL)
    THEN RAISE(ABORT, 'legacy stripe checkout state writes are disabled') END );
  SELECT ( CASE WHEN (SELECT storage_mode FROM commerce_stripe_checkout_state_control WHERE singleton = 1) = 'table'
    AND (NEW.document_kind IS NOT OLD.document_kind OR NEW.document_path IS NOT OLD.document_path
      OR NEW.drop_id IS NOT OLD.drop_id OR NEW.document_id IS NOT OLD.document_id)
    THEN RAISE(ABORT, 'stripe checkout parent identity is immutable') END );
  SELECT ( CASE WHEN (SELECT storage_mode FROM commerce_stripe_checkout_state_control WHERE singleton = 1) = 'table'
    AND NOT EXISTS (SELECT 1 FROM commerce_commit_guards AS guard, json_each(guard.stripe_checkout_paths_json) AS path
      WHERE path.value = NEW.document_path) THEN RAISE(ABORT, 'stripe checkout state is unavailable') END );
END;

INSERT INTO commerce_frozen_metadata_cleanup_guard (allowed, complete)
SELECT 1, NOT EXISTS (
  SELECT 1 FROM commerce_documents AS document WHERE (json_type(document.document_json, '$.buyerOrderReceivedEmailState') IS NOT NULL
    OR json_type(document.document_json, '$.buyerOrderReceivedEmailJobId') IS NOT NULL
    OR json_type(document.document_json, '$.buyerOrderReceivedEmailJob') IS NOT NULL
    OR json_type(document.document_json, '$.buyerOrderReceivedEmailIdempotencyKey') IS NOT NULL
    OR json_type(document.document_json, '$.buyerOrderReceivedEmailQueuedAt') IS NOT NULL
    OR json_type(document.document_json, '$.shipperReadyToShipEmailState') IS NOT NULL
    OR json_type(document.document_json, '$.shipperReadyToShipEmailJobId') IS NOT NULL
    OR json_type(document.document_json, '$.shipperReadyToShipEmailJob') IS NOT NULL
    OR json_type(document.document_json, '$.shipperReadyToShipEmailIdempotencyKey') IS NOT NULL
    OR json_type(document.document_json, '$.shipperReadyToShipEmailQueuedAt') IS NOT NULL
    OR json_type(document.document_json, '$.readyToShipNotificationRetryUntilMs') IS NOT NULL
    OR json_type(document.document_json, '$.readyToShipNotificationPublishAttemptCount') IS NOT NULL
    OR json_type(document.document_json, '$.readyToShipNotificationPublishClaimId') IS NOT NULL
    OR json_type(document.document_json, '$.readyToShipNotificationPublishClaimExpiresAtMs') IS NOT NULL
    OR json_type(document.document_json, '$.readyToShipNotificationFailedAt') IS NOT NULL
    OR json_type(document.document_json, '$.readyToShipNotificationLastErrorCode') IS NOT NULL
    OR json_type(document.document_json, '$.stripeTerminalNotification') IS NOT NULL
    OR json_type(document.document_json, '$.stripeTerminalNotificationState') IS NOT NULL
    OR json_type(document.document_json, '$.stripeTerminalNotificationNextAttemptAtMs') IS NOT NULL
    OR json_type(document.document_json, '$.stripeTerminalNotificationQueuedAt') IS NOT NULL
    OR json_type(document.document_json, '$.stripeTerminalNotificationLastError') IS NOT NULL
    OR json_type(document.document_json, '$.buyerOrderShippedEmailState') IS NOT NULL
    OR json_type(document.document_json, '$.buyerOrderShippedEmailJobId') IS NOT NULL
    OR json_type(document.document_json, '$.buyerOrderShippedEmailIdempotencyKey') IS NOT NULL
    OR json_type(document.document_json, '$.buyerOrderShippedEmailQueuedAt') IS NOT NULL
    OR json_type(document.document_json, '$.packStatusProjectionState') IS NOT NULL
    OR json_type(document.document_json, '$.packStatusProjectionNextAttemptAtMs') IS NOT NULL
    OR json_type(document.document_json, '$.packStatusProjectionFailureCount') IS NOT NULL
    OR json_type(document.document_json, '$.packStatusProjectionCompletedAt') IS NOT NULL
    OR json_type(document.document_json, '$.packStatusProjectionFailedAt') IS NOT NULL
    OR json_type(document.document_json, '$.packStatusProjectionLastErrorCode') IS NOT NULL)
    OR (document.document_kind = 'stripe_checkout' AND (json_type(document.document_json, '$.status') IS NOT NULL
    OR json_type(document.document_json, '$.processingAttemptId') IS NOT NULL
    OR json_type(document.document_json, '$.processingAttemptCount') IS NOT NULL
    OR json_type(document.document_json, '$.processingStartedAt') IS NOT NULL
    OR json_type(document.document_json, '$.processingLeaseExpiresAt') IS NOT NULL
    OR json_type(document.document_json, '$.lastRetryableFulfillmentAttempt') IS NOT NULL
    OR json_type(document.document_json, '$.lastRetryableFulfillmentErrorAt') IS NOT NULL
    OR json_type(document.document_json, '$.nextFulfillmentRetryAt') IS NOT NULL
    OR json_type(document.document_json, '$.fulfillmentQueueReenqueuedAt') IS NOT NULL
    OR json_type(document.document_json, '$.lastFulfillmentReconciliationErrorAt') IS NOT NULL
    OR json_type(document.document_json, '$.updatedAt') IS NOT NULL))
);

DROP TABLE commerce_frozen_metadata_cleanup_guard;
