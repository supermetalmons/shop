import assert from 'node:assert/strict';
import test from 'node:test';
import { createNotificationEmailJobV1 } from '../../../../shared/notificationEmailJob.ts';
import {
  parseReceiptClaimFailureOutboxRecord,
  parseReceiptClaimFailureOutboxRow,
  parseReceiptClaimFailureSnapshot,
  type ReceiptClaimFailureSnapshot,
} from '../../../../shared/receiptClaimFailureOutbox.ts';
import { commerceKeys } from '../src/commerceRepository.ts';
import { createCommerceD1Harness, seedCommerceDocument } from './commerceD1Harness.ts';

const CODE = 'ABCDEF-1234567890';
const PATH = commerceKeys.claimCode(CODE).path;
const OPERATION = 'src-v1-123e4567-e89b-42d3-a456-426614174000';
const RECIPIENT = '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM';
const NOW = 1_800_000_000_000;
const LEGACY_EVENT = `legacy:${'a'.repeat(64)}`;

function fixture(t: test.TestContext, phase: string | null = 'pending') {
  const harness = createCommerceD1Harness();
  t.after(() => harness.database.close());
  const data = {
    namespace: 'stripe_receipt_v1', code: CODE, dropId: 'card_nft_2', deliveryId: 7, boxId: 16,
    status: 'processing', recipient: RECIPIENT, processingStartedAt: NOW - 1_000_000,
    ...(phase === null ? {} : { receiptClaimWorkflowV1: {
      operationId: OPERATION, generation: 1, phase, createdAtMs: NOW - 1_000_000, deadlineAtMs: NOW - 100_000,
      error: { code: 'unavailable', message: `Do not publish ${CODE}` },
      submission: { signature: '2'.repeat(88), signedTransactionBase64: 'private-signed-bytes' },
    } }),
  };
  seedCommerceDocument(harness, { key: commerceKeys.claimCode(CODE), data });
  const updateSource = (updates: Record<string, unknown>) => {
    const current = JSON.parse(String(harness.database.prepare('SELECT document_json FROM commerce_documents WHERE document_path = ?').get(PATH)!.document_json));
    harness.database.prepare('UPDATE commerce_documents SET document_json = ?, version = version + 1 WHERE document_path = ?')
      .run(JSON.stringify({ ...current, ...updates }), PATH);
  };
  const updateWorkflow = (updates: Record<string, unknown>) => {
    const current = JSON.parse(String(harness.database.prepare('SELECT document_json FROM commerce_documents WHERE document_path = ?').get(PATH)!.document_json));
    updateSource({ receiptClaimWorkflowV1: { ...current.receiptClaimWorkflowV1, ...updates } });
  };
  const rows = () => harness.database.prepare('SELECT * FROM commerce_receipt_claim_failure_outbox ORDER BY event_id')
    .all().map(parseReceiptClaimFailureOutboxRow);
  return { ...harness, data, updateSource, updateWorkflow, rows };
}

function snapshot(phase: ReceiptClaimFailureSnapshot['phase']): ReceiptClaimFailureSnapshot {
  return {
    version: 1, dropId: 'card_nft_2', deliveryId: 7, boxId: 16, recipient: RECIPIENT,
    operationId: phase === 'legacy_processing' ? null : OPERATION,
    generation: phase === 'legacy_processing' ? null : 1,
    phase, errorCode: phase === 'legacy_processing' ? 'legacy-processing' : 'deadline-exceeded',
    createdAtMs: NOW - 1_000_000, deadlineAtMs: phase === 'legacy_processing' ? null : NOW - 100_000,
    failedAtMs: NOW, processingStartedAtMs: NOW - 1_000_000, signature: null,
  };
}

function insert(f: ReturnType<typeof fixture>, event: ReceiptClaimFailureSnapshot, eventId = `${OPERATION}:g1`) {
  return f.database.prepare(`INSERT INTO commerce_receipt_claim_failure_outbox (
    event_id, claim_path, incident_kind, operation_id, workflow_generation, snapshot_json, state,
    revision, attempt_count, next_attempt_at_ms, claim_id, claim_expires_at_ms, retry_until_ms,
    created_at_ms, updated_at_ms, job_json, queued_at_ms, last_error_code
  ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 1, 0, ?, NULL, NULL, ?, ?, ?, NULL, NULL, NULL)
  ON CONFLICT(event_id) DO NOTHING`).run(eventId, PATH, event.operationId ? 'workflow' : 'legacy',
    event.operationId, event.generation, JSON.stringify(event), NOW, NOW + 21_600_000, NOW, NOW);
}

test('terminal failure capture is atomic, redacted, and immutable per Workflow generation', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.rows(), []);
  f.database.exec('BEGIN');
  f.updateWorkflow({ phase: 'failed' });
  assert.equal(f.rows().length, 1);
  f.database.exec('ROLLBACK');
  assert.deepEqual(f.rows(), []);
  f.updateWorkflow({ phase: 'manual_review' });
  const first = f.rows()[0];
  assert.equal(first.eventId, `${OPERATION}:g1`);
  assert.equal(first.snapshot.phase, 'manual_review');
  assert.equal(first.snapshot.errorCode, 'unavailable');
  assert.equal(first.snapshot.signature, '2'.repeat(88));
  assert.equal(first.state, 'pending');
  assert.equal(first.job, null);
  const publicSnapshot = JSON.stringify(first.snapshot);
  assert.ok(!publicSnapshot.includes(CODE));
  assert.ok(!publicSnapshot.includes(PATH));
  assert.ok(!publicSnapshot.includes('private-signed-bytes'));
  f.updateWorkflow({ phase: 'failed', error: { code: 'internal', message: 'changed' } });
  assert.deepEqual(f.rows(), [first]);
  f.updateWorkflow({ generation: 2, phase: 'pending' });
  assert.deepEqual(f.rows(), [first]);
  f.updateWorkflow({ phase: 'failed' });
  assert.equal(f.rows().length, 2);
  assert.deepEqual(f.rows()[0], first);
  assert.equal(f.rows()[1].eventId, `${OPERATION}:g2`);
});

test('terminal inserts are captured while unrelated claims and completed operations stay quiet', (t) => {
  const f = fixture(t, 'failed');
  assert.equal(f.rows().length, 1);
  seedCommerceDocument(f, { key: commerceKeys.claimCode('ZZZZZZ-1234567890'), data: {
    ...f.data, namespace: 'irl_v2', receiptClaimWorkflowV1: { ...f.data.receiptClaimWorkflowV1!, operationId: OPERATION.replace('4000', '4001') },
  } });
  assert.equal(f.rows().length, 1);
  f.updateWorkflow({ phase: 'complete' });
  assert.equal(f.rows().length, 1);
});

test('an overdue incident and a later terminal failure share one frozen event', (t) => {
  const f = fixture(t);
  insert(f, snapshot('overdue'));
  const overdue = f.rows()[0];
  f.updateWorkflow({ phase: 'failed' });
  assert.deepEqual(f.rows(), [overdue]);
});

test('terminal capture normalizes untrusted error and signature text', (t) => {
  const f = fixture(t);
  f.updateWorkflow({ phase: 'failed', error: { code: CODE, message: PATH },
    submission: { signature: `claim-secret:${CODE}`, signedTransactionBase64: 'private-bytes' } });
  const captured = f.rows()[0].snapshot;
  assert.equal(captured.errorCode, 'internal');
  assert.equal(captured.signature, null);
  assert.ok(!JSON.stringify(captured).includes(CODE));
});

test('legacy discovery deduplicates and rejects a source that has been adopted or changed', (t) => {
  const f = fixture(t, null);
  insert(f, snapshot('legacy_processing'), LEGACY_EVENT);
  const first = f.rows()[0];
  insert(f, snapshot('legacy_processing'), LEGACY_EVENT);
  assert.deepEqual(f.rows(), [first]);
  f.updateSource({ processingStartedAt: NOW });
  assert.throws(() => insert(f, snapshot('legacy_processing'), `legacy:${'b'.repeat(64)}`), /source changed/);
  f.updateSource({ processingStartedAt: NOW - 1_000_000,
    receiptClaimWorkflowV1: { operationId: OPERATION, generation: 1, phase: 'pending' } });
  assert.throws(() => insert(f, snapshot('legacy_processing'), `legacy:${'b'.repeat(64)}`), /source changed/);
});

test('publication identity, payload, and terminal state cannot be reset or replaced', (t) => {
  const f = fixture(t, 'failed');
  const event = f.rows()[0];
  const job = createNotificationEmailJobV1({
    kind: 'receipt_claim_manual_review', idempotencyKey: `receipt_claim_failure:${event.eventId}`,
    recipients: ['development@support.mons.shop'], subject: 'Receipt claim failed', text: 'Review pack 16', html: '<p>Review pack 16</p>',
    context: { dropId: 'card_nft_2', deliveryId: 7 },
  });
  f.database.prepare('UPDATE commerce_receipt_claim_failure_outbox SET job_json = ?, revision = revision + 1 WHERE event_id = ?')
    .run(JSON.stringify(job), event.eventId);
  assert.throws(() => f.database.prepare('UPDATE commerce_receipt_claim_failure_outbox SET snapshot_json = ?, revision = revision + 1 WHERE event_id = ?')
    .run(JSON.stringify({ ...event.snapshot, recipient: '1'.repeat(32) }), event.eventId), /immutable/);
  assert.throws(() => f.database.prepare('UPDATE commerce_receipt_claim_failure_outbox SET job_json = ?, revision = revision + 1 WHERE event_id = ?')
    .run(JSON.stringify({ ...job, text: 'Changed payload' }), event.eventId), /immutable/);
  f.database.prepare(`UPDATE commerce_receipt_claim_failure_outbox SET state = 'queued', queued_at_ms = ?, next_attempt_at_ms = NULL,
    revision = revision + 1 WHERE event_id = ?`).run(event.updatedAtMs, event.eventId);
  const queued = f.rows()[0];
  assert.deepEqual(queued.job, job);
  assert.throws(() => f.database.prepare(`UPDATE commerce_receipt_claim_failure_outbox SET state = 'pending', queued_at_ms = NULL,
    next_attempt_at_ms = ?, revision = revision + 1 WHERE event_id = ?`).run(event.updatedAtMs, event.eventId), /immutable/);
  assert.throws(() => f.database.prepare('DELETE FROM commerce_receipt_claim_failure_outbox WHERE event_id = ?')
    .run(event.eventId), /requires maintenance/);
});

test('authority pause blocks failure outbox insertion and publication mutations', (t) => {
  const f = fixture(t, 'failed');
  const event = f.rows()[0];
  f.database.exec(`INSERT INTO commerce_authority_control_lease (singleton, lease_token, acquired_at_ms, expires_at_ms)
    VALUES (1, '00000000-0000-4000-8000-000000000099', CAST(strftime('%s', 'now') AS INTEGER) * 1000,
      CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 60000)`);
  f.database.exec(`UPDATE commerce_authority_control SET authority_state = 'paused', revision = revision + 1,
    paused_at_ms = NULL, updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE singleton = 1`);
  assert.throws(() => f.database.prepare('UPDATE commerce_receipt_claim_failure_outbox SET revision = revision + 1 WHERE event_id = ?')
    .run(event.eventId), /unavailable/);
  assert.throws(() => insert(f, snapshot('failed')), /unavailable/);
  assert.deepEqual(f.rows(), [event]);
});

test('snapshot validation rejects secrets, invalid identities, and malformed timing', (t) => {
  const f = fixture(t, 'failed');
  const valid = snapshot('failed');
  assert.deepEqual(parseReceiptClaimFailureSnapshot(valid), valid);
  for (const invalid of [
    { ...valid, code: CODE }, { ...valid, claimPath: PATH }, { ...valid, signedTransaction: 'private' },
    { ...valid, errorCode: CODE }, { ...valid, recipient: CODE }, { ...valid, signature: CODE },
    { ...valid, createdAtMs: Number.NaN }, { ...valid, failedAtMs: -1 }, { ...valid, generation: null },
  ]) assert.throws(() => parseReceiptClaimFailureSnapshot(invalid), /Invalid/);
  assert.throws(() => parseReceiptClaimFailureOutboxRecord({ ...f.rows()[0], eventId: 'wrong' }), /Invalid/);
  assert.throws(() => f.database.prepare(`INSERT INTO commerce_receipt_claim_failure_outbox
    SELECT event_id || 'x', claim_path, incident_kind, operation_id, workflow_generation,
      json_set(snapshot_json, '$.code', ?), state, revision, attempt_count, next_attempt_at_ms, claim_id,
      claim_expires_at_ms, retry_until_ms, created_at_ms, updated_at_ms, job_json, queued_at_ms, last_error_code
    FROM commerce_receipt_claim_failure_outbox LIMIT 1`).run(CODE), /snapshot/);
});

test('failure discovery and due publication use bounded covering indexes', (t) => {
  const f = fixture(t);
  const queries = [
    ['commerce_receipt_claim_failure_outbox_due', `SELECT event_id FROM commerce_receipt_claim_failure_outbox
      WHERE state = 'pending' AND next_attempt_at_ms <= 0 ORDER BY next_attempt_at_ms, event_id LIMIT 8`],
    ['commerce_receipt_claim_failure_outbox_claim', `SELECT event_id FROM commerce_receipt_claim_failure_outbox
      WHERE claim_path = '${PATH}' AND incident_kind = 'legacy'`],
    ['commerce_receipt_claim_failure_legacy_scan', `SELECT document_path FROM commerce_documents INDEXED BY commerce_receipt_claim_failure_legacy_scan
      WHERE document_kind = 'claim_code' AND status = 'processing' AND json_extract(document_json, '$.namespace') = 'stripe_receipt_v1'
        AND json_type(document_json, '$.receiptClaimWorkflowV1') IS NULL AND json_extract(document_json, '$.processingStartedAt') <= 0
      ORDER BY json_extract(document_json, '$.processingStartedAt'), document_path LIMIT 8`],
    ['commerce_receipt_claim_failure_terminal_scan', `SELECT document_path FROM commerce_documents INDEXED BY commerce_receipt_claim_failure_terminal_scan
      WHERE document_kind = 'claim_code' AND status = 'processing' AND json_extract(document_json, '$.namespace') = 'stripe_receipt_v1'
        AND json_extract(document_json, '$.receiptClaimWorkflowV1.phase') IN ('failed', 'manual_review')
      ORDER BY json_extract(document_json, '$.receiptClaimWorkflowV1.operationId'), json_extract(document_json, '$.receiptClaimWorkflowV1.generation'), document_path LIMIT 8`],
    ['commerce_receipt_claim_failure_overdue_scan', `SELECT document_path FROM commerce_documents INDEXED BY commerce_receipt_claim_failure_overdue_scan
      WHERE document_kind = 'claim_code' AND status = 'processing' AND json_extract(document_json, '$.namespace') = 'stripe_receipt_v1'
        AND json_extract(document_json, '$.receiptClaimWorkflowV1.phase') = 'pending'
        AND json_extract(document_json, '$.receiptClaimWorkflowV1.deadlineAtMs') <= 0
      ORDER BY json_extract(document_json, '$.receiptClaimWorkflowV1.deadlineAtMs'), document_path LIMIT 8`],
  ];
  for (const [index, sql] of queries) {
    const details = f.database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((row) => String(row.detail)).join('\n');
    assert.match(details, new RegExp(index));
    assert.doesNotMatch(details, /USE TEMP B-TREE/);
  }
});
