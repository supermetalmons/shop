import assert from 'node:assert/strict';
import test from 'node:test';
import { D1CommerceRepository, commerceKeys } from '../src/commerceRepository.js';
import { createCommerceD1Harness, seedCommerceDocument } from './commerceD1Harness.ts';
import {
  advanceReceiptClaimWorkflowGeneration,
  claimReceiptClaimWorkflowDispatch,
  completeReceiptClaimWorkflow,
  failReceiptClaimWorkflow,
  loadReceiptClaimWorkflow,
  persistReceiptClaimWorkflowSubmission,
  queryDueReceiptClaimWorkflows,
  reserveReceiptClaimWorkflow,
  settleReceiptClaimWorkflowLegacySubmissions,
  settleReceiptClaimWorkflowSubmission,
} from '../src/stripeReceiptClaimWorkflowStore.js';
import { parseReceiptClaimWorkflowState, type ReceiptClaimWorkflowSubmission } from '../src/stripeReceiptClaimWorkflowState.js';
import { receiptClaimWorkflowFailure } from '../src/stripeReceiptClaimWorkflowSupport.js';
import { runtimeForDrop } from '../src/stripeReceiptClaim.js';

const CODE = 'ABCDEF-1234567890';
const DROP = 'card_nft_2';
const RECIPIENT = '11111111111111111111111111111111';
const NOW = 1_800_000_000_000;

function setup(options: Parameters<typeof createCommerceD1Harness>[0] = {}, claimFields = {}, orderFields = {}) {
  const harness = createCommerceD1Harness(options);
  seedCommerceDocument(harness, { key: commerceKeys.claimCode(CODE), data: {
    namespace: 'stripe_receipt_v1', code: CODE, dropId: DROP, deliveryId: 7, boxId: 16, status: 'unclaimed', ...claimFields,
  } });
  seedCommerceDocument(harness, { key: commerceKeys.deliveryOrder(DROP, '7'), data: {
    dropId: DROP, deliveryId: 7, source: 'stripe_offchain', irlClaims: [],
    stripeReceiptClaim: { namespace: 'stripe_receipt_v1', code: CODE, boxId: 16, status: 'unclaimed' },
    ...orderFields,
  } });
  const context = { repository: new D1CommerceRepository(harness.db), signal: new AbortController().signal, nowMs: NOW };
  return { ...harness, context };
}

function legacyClaimedPack(claimFields = {}) {
  return setup({}, { status: 'claimed', recipient: RECIPIENT, receiptTxs: ['signature'], ...claimFields }, {
    irlClaims: [{ boxId: 16, boxAssetId: 'pack-asset', dudeIds: [46, 47, 48] }],
  });
}

test('legacy claimed packs recover three card receipts only after verifying their ownership', async (t) => {
  for (const validProof of [true, false]) {
    const fixture = legacyClaimedPack();
    t.after(() => fixture.database.close());
    const runtime = runtimeForDrop(DROP);
    const verified: string[] = [];
    const stored = await fixture.context.repository.get(commerceKeys.claimCode(CODE));
    const result = await reserveReceiptClaimWorkflow(fixture.context, CODE, RECIPIENT, NOW, {
      provider: { apiKey: 'test-key', signal: fixture.context.signal, providerFetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { id: string; method: string; params: { id: string; ownerAddress: string } };
        let result: unknown;
        if (request.method === 'searchAssets') {
          assert.equal(request.params.ownerAddress, RECIPIENT);
          result = { total: 3, limit: 1000, page: 1, items: [46, 47, 48].map((id) => ({
            id: `figure-${id}`, ownership: { owner: RECIPIENT },
            grouping: [{ group_key: 'collection', group_value: runtime.collectionMint.toBase58() }],
            content: { json_uri: `${runtime.config.metadataBase}/rf${id}.json` },
          })) };
        } else {
          assert.equal(request.method, 'getAssetProof');
          verified.push(request.params.id);
          result = { tree_id: validProof ? runtime.receiptsMerkleTree.toBase58() : RECIPIENT, root: RECIPIENT, proof: [] };
        }
        return Response.json({ jsonrpc: '2.0', id: request.id, result });
      } },
    });
    assert.deepEqual(result, { status: 'complete', result: {
      processed: true, dropId: DROP, deliveryId: 7, receiptTxs: ['signature'],
      ...(validProof ? { receiptKind: 'figure', receiptsTransferred: 3, figureIds: [46, 47, 48] }
        : { receiptKind: 'box', receiptsTransferred: 1 }),
    } });
    assert.deepEqual(verified.sort(), ['figure-46', 'figure-47', 'figure-48']);
    assert.deepEqual(await fixture.context.repository.get(commerceKeys.claimCode(CODE)), stored);
  }
});

test('legacy claimed packs remain complete when receipt enrichment fails', async (t) => {
  const fixture = legacyClaimedPack();
  t.after(() => fixture.database.close());
  let providerCalls = 0;
  const result = await reserveReceiptClaimWorkflow(fixture.context, CODE, RECIPIENT, NOW, {
    provider: { apiKey: 'test-key', signal: fixture.context.signal, providerFetch: async () => {
      providerCalls += 1;
      throw new Error('provider unavailable');
    } },
  });
  assert.ok(providerCalls > 0);
  assert.deepEqual(result, { status: 'complete', result: {
    processed: true, dropId: DROP, deliveryId: 7, receiptTxs: ['signature'], receiptKind: 'box', receiptsTransferred: 1,
  } });
});

test('stored legacy receipt metadata bypasses provider enrichment', async (t) => {
  const fixture = legacyClaimedPack({ receiptKind: 'figure', receiptsTransferred: 3, figureIds: [46, 47, 48] });
  t.after(() => fixture.database.close());
  let providerCalls = 0;
  const result = await reserveReceiptClaimWorkflow(fixture.context, CODE, RECIPIENT, NOW, {
    provider: { apiKey: 'test-key', signal: fixture.context.signal, providerFetch: async () => {
      providerCalls += 1;
      throw new Error('unexpected provider request');
    } },
  });
  assert.equal(providerCalls, 0);
  assert.deepEqual(result, { status: 'complete', result: {
    processed: true, dropId: DROP, deliveryId: 7, receiptTxs: ['signature'], receiptKind: 'figure', receiptsTransferred: 3,
    figureIds: [46, 47, 48],
  } });
});

function submission(signature = 'signature-one'): ReceiptClaimWorkflowSubmission {
  return {
    signature, signedTransactionBase64: 'dHJhbnNhY3Rpb24=', blockhash: 'blockhash', lastValidBlockHeight: 100, preparedAtMs: NOW,
    status: 'prepared', target: { flow: 'legacy_pack', receiptAssetId: 'asset', figureIds: [], dropId: DROP,
      network: 'devnet', programId: 'program', collectionMint: 'collection', receiptsMerkleTree: 'tree', adminWallet: 'admin' },
  };
}

async function legacyDirectFixture(options: Parameters<typeof createCommerceD1Harness>[0] = {}) {
  const rejected = { signature: 'legacy-rejected', submittedAtMs: NOW - 1000, lastValidBlockHeight: 100, status: 'not_landed' as const };
  const unresolved = { signature: 'legacy-unresolved', submittedAtMs: NOW, lastValidBlockHeight: 200, status: 'submitted' as const };
  const fixture = setup(options, {
    receiptKind: 'figure', receiptAssetId: 'receipt-asset', figureId: 16,
    receiptTxs: [rejected.signature, unresolved.signature],
    receiptTxSubmissions: [{ ...rejected, status: 'submitted' }, unresolved],
  });
  await fixture.context.repository.run(NOW, async (unit) => {
    const key = commerceKeys.deliveryOrder(DROP, '7');
    await unit.get(key);
    await unit.update(key, {
      'stripeReceiptClaim.receiptKind': 'figure', 'stripeReceiptClaim.receiptAssetId': 'receipt-asset', 'stripeReceiptClaim.figureId': 16,
    });
  });
  const reserved = await reserveReceiptClaimWorkflow(fixture.context, CODE, RECIPIENT, NOW);
  if (reserved.status !== 'pending') return assert.fail('Expected pending claim');
  return { ...fixture, snapshot: reserved.snapshot, rejected, unresolved };
}

test('legacy settlement preserves unresolved evidence and tolerates acknowledgement loss and replay', async (t) => {
  let loseNextCommit = false;
  const fixture = await legacyDirectFixture({ observeBatchAfterCommit: ({ statements }) => {
    if (loseNextCommit && statements.some(({ sql }) => sql.includes('INSERT INTO commerce_commit_guards'))) {
      loseNextCommit = false;
      throw new TypeError('commit acknowledgement lost');
    }
  } });
  t.after(() => fixture.database.close());
  loseNextCommit = true;
  const settled = await settleReceiptClaimWorkflowLegacySubmissions(fixture.context, fixture.snapshot, [fixture.rejected]);
  assert.equal(loseNextCommit, false);
  assert.deepEqual(settled.started.receiptTxs, [fixture.unresolved.signature]);
  assert.deepEqual(settled.started.receiptTxSubmissions, [fixture.rejected, fixture.unresolved]);
  assert.equal(settled.operation.recipient, RECIPIENT);
  const before = await fixture.context.repository.get(commerceKeys.claimCode(CODE));
  await settleReceiptClaimWorkflowLegacySubmissions(fixture.context, fixture.snapshot, [fixture.rejected]);
  const after = await fixture.context.repository.get(commerceKeys.claimCode(CODE));
  assert.equal(after?.version, before?.version);
});

test('legacy settlement rejects stale generations and altered submission identity', async (t) => {
  const fixture = await legacyDirectFixture();
  t.after(() => fixture.database.close());
  await assert.rejects(settleReceiptClaimWorkflowLegacySubmissions(fixture.context, fixture.snapshot,
    [{ ...fixture.rejected, lastValidBlockHeight: 101 }]), /submission changed/);
  await advanceReceiptClaimWorkflowGeneration(fixture.context, fixture.snapshot, NOW + 1);
  await assert.rejects(settleReceiptClaimWorkflowLegacySubmissions(fixture.context, fixture.snapshot, [fixture.rejected]), /execution changed/);
  const current = await loadReceiptClaimWorkflow(fixture.context, fixture.snapshot.operation.operationId);
  assert.deepEqual(current?.started.receiptTxs, [fixture.rejected.signature, fixture.unresolved.signature]);
  assert.equal(current?.started.receiptTxSubmissions[0].status, 'submitted');
});

test('legacy settlement cannot modify a terminal operation', async (t) => {
  const fixture = await legacyDirectFixture();
  t.after(() => fixture.database.close());
  await failReceiptClaimWorkflow(fixture.context, fixture.snapshot, { code: 'unavailable', message: 'Retry later.', retryable: true }, true);
  await assert.rejects(settleReceiptClaimWorkflowLegacySubmissions(fixture.context, fixture.snapshot, [fixture.rejected]), /no longer pending/);
  const current = await loadReceiptClaimWorkflow(fixture.context, fixture.snapshot.operation.operationId);
  assert.equal(current?.operation.phase, 'manual_review');
  assert.equal(current?.started.receiptTxSubmissions[0].status, 'submitted');
});

test('receipt claim reservations arbitrate recipients and retain one operation for duplicate starts', async (t) => {
  const fixture = setup();
  t.after(() => fixture.database.close());
  const [first, second] = await Promise.all([
    reserveReceiptClaimWorkflow(fixture.context, CODE, RECIPIENT, NOW),
    reserveReceiptClaimWorkflow(fixture.context, CODE, RECIPIENT, NOW),
  ]);
  assert.equal(first.status, 'pending');
  assert.equal(second.status, 'pending');
  if (first.status !== 'pending' || second.status !== 'pending') return;
  assert.equal(first.snapshot.operation.operationId, second.snapshot.operation.operationId);
  await assert.rejects(reserveReceiptClaimWorkflow(fixture.context, CODE, 'another-recipient', NOW), /original receiver/);
  const repeated = await reserveReceiptClaimWorkflow(fixture.context, CODE, RECIPIENT, NOW + 100_000, { allowNew: false });
  assert.equal(repeated.status, 'pending');
  assert.deepEqual(await queryDueReceiptClaimWorkflows(fixture.db, NOW), [first.snapshot.operation.operationId]);
});

test('concurrent different recipients cannot reserve separate receipt operations', async (t) => {
  const fixture = setup();
  t.after(() => fixture.database.close());
  const results = await Promise.allSettled([
    reserveReceiptClaimWorkflow(fixture.context, CODE, RECIPIENT, NOW),
    reserveReceiptClaimWorkflow(fixture.context, CODE, '22222222222222222222222222222222', NOW),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
});

test('receipt claim reservations and journals reconcile lost commit acknowledgements', async (t) => {
  let loseNextCommit = false;
  const fixture = setup({ observeBatchAfterCommit: ({ statements }) => {
    if (loseNextCommit && statements.some(({ sql }) => sql.includes('INSERT INTO commerce_commit_guards'))) {
      loseNextCommit = false;
      throw new TypeError('commit acknowledgement lost');
    }
  } });
  t.after(() => fixture.database.close());
  loseNextCommit = true;
  const reserved = await reserveReceiptClaimWorkflow(fixture.context, CODE, RECIPIENT, NOW);
  assert.equal(reserved.status, 'pending');
  if (reserved.status !== 'pending') return;
  loseNextCommit = true;
  await persistReceiptClaimWorkflowSubmission(fixture.context, reserved.snapshot, submission());
  const saved = await loadReceiptClaimWorkflow(fixture.context, reserved.snapshot.operation.operationId);
  assert.equal(saved?.operation.submission?.signature, 'signature-one');
});

test('receipt claim journal fences replaced generations and preserves settled evidence', async (t) => {
  const fixture = setup();
  t.after(() => fixture.database.close());
  const reserved = await reserveReceiptClaimWorkflow(fixture.context, CODE, RECIPIENT, NOW);
  if (reserved.status !== 'pending') return assert.fail();
  await persistReceiptClaimWorkflowSubmission(fixture.context, reserved.snapshot, submission());
  let current = await loadReceiptClaimWorkflow(fixture.context, reserved.snapshot.operation.operationId);
  assert.ok(current);
  await assert.rejects(persistReceiptClaimWorkflowSubmission(fixture.context, current, submission('signature-two')), /still resolving/);
  await settleReceiptClaimWorkflowSubmission(fixture.context, current, 'not_landed');
  current = await loadReceiptClaimWorkflow(fixture.context, current.operation.operationId);
  assert.ok(current);
  await persistReceiptClaimWorkflowSubmission(fixture.context, current, submission('signature-two'));
  current = await loadReceiptClaimWorkflow(fixture.context, current.operation.operationId);
  assert.ok(current);
  assert.equal(current.operation.submissionHistory[0].signature, 'signature-one');
  assert.equal(current.operation.submissionHistory[0].status, 'not_landed');
  const next = await advanceReceiptClaimWorkflowGeneration(fixture.context, current, NOW + 1);
  assert.equal(next?.operation.generation, 2);
  await assert.rejects(persistReceiptClaimWorkflowSubmission(fixture.context, current, submission('stale')), /execution changed/);
  await assert.rejects(completeReceiptClaimWorkflow(fixture.context, current, {
    processed: true, dropId: DROP, deliveryId: 7, receiptKind: 'box', receiptsTransferred: 1,
  }), /execution changed/);
});

test('journal deadline races remain retryable without persisting an expired transaction', async (t) => {
  for (const expiresDuring of ['preparation', 'persistence'] as const) {
    const fixture = setup();
    t.after(() => fixture.database.close());
    const reserved = await reserveReceiptClaimWorkflow(fixture.context, CODE, RECIPIENT, NOW);
    if (reserved.status !== 'pending') return assert.fail();
    const deadline = reserved.snapshot.operation.deadlineAtMs;
    const candidate = { ...submission(), preparedAtMs: expiresDuring === 'preparation' ? deadline : deadline - 1 };
    const context = { ...fixture.context, nowMs: expiresDuring === 'persistence' ? deadline : NOW };
    const error = await persistReceiptClaimWorkflowSubmission(context, reserved.snapshot, candidate).then(() => assert.fail('Expected deadline failure'), (error: unknown) => error);
    const failure = receiptClaimWorkflowFailure(error);
    assert.equal(failure.code, 'deadline-exceeded');
    assert.equal(failure.retryable, true);
    await failReceiptClaimWorkflow(context, reserved.snapshot, failure, true);
    const failed = await loadReceiptClaimWorkflow(context, reserved.snapshot.operation.operationId);
    assert.ok(failed);
    assert.equal(failed.operation.submission, undefined);
    assert.equal(await advanceReceiptClaimWorkflowGeneration(context, failed, deadline, {
      resetRetryWindow: true, requestId: failed.operation.requestId,
    }), null);
    const resumed = await advanceReceiptClaimWorkflowGeneration(context, failed, deadline, {
      resetRetryWindow: true, requestId: crypto.randomUUID(),
    });
    assert.equal(resumed?.operation.generation, 2);
    assert.equal(resumed?.operation.phase, 'pending');
  }
});

test('journal target mismatches retain a nonretryable failure', async (t) => {
  const fixture = setup();
  t.after(() => fixture.database.close());
  const reserved = await reserveReceiptClaimWorkflow(fixture.context, CODE, RECIPIENT, NOW);
  if (reserved.status !== 'pending') return assert.fail();
  const candidate = submission();
  candidate.target.dropId = 'another-drop';
  const error = await persistReceiptClaimWorkflowSubmission(fixture.context, reserved.snapshot, candidate).then(() => assert.fail('Expected target failure'), (error: unknown) => error);
  assert.deepEqual(receiptClaimWorkflowFailure(error), {
    code: 'failed-precondition', message: 'Receipt claim submission is outside its operation.', retryable: false,
  });
  assert.equal((await loadReceiptClaimWorkflow(fixture.context, reserved.snapshot.operation.operationId))?.operation.submission, undefined);
});

test('receipt claim completion atomically stores its durable result and order mirror', async (t) => {
  let loseNextCommit = false;
  const fixture = setup({ observeBatchAfterCommit: ({ statements }) => {
    if (loseNextCommit && statements.some(({ sql }) => sql.includes('INSERT INTO commerce_commit_guards'))) {
      loseNextCommit = false;
      throw new TypeError('completion acknowledgement lost');
    }
  } });
  t.after(() => fixture.database.close());
  const reserved = await reserveReceiptClaimWorkflow(fixture.context, CODE, RECIPIENT, NOW);
  if (reserved.status !== 'pending') return assert.fail();
  const result = { processed: true, dropId: DROP, deliveryId: 7, receiptKind: 'box' as const, receiptsTransferred: 1, receiptTxs: ['signature'] };
  loseNextCommit = true;
  await completeReceiptClaimWorkflow(fixture.context, reserved.snapshot, result);
  await completeReceiptClaimWorkflow(fixture.context, reserved.snapshot, result);
  const complete = await reserveReceiptClaimWorkflow(fixture.context, CODE, RECIPIENT, NOW);
  assert.deepEqual(complete, { status: 'complete', result });
  const order = await fixture.context.repository.get(commerceKeys.deliveryOrder(DROP, '7'));
  assert.equal((order?.data.stripeReceiptClaim as Record<string, unknown>).status, 'claimed');
  assert.deepEqual(await queryDueReceiptClaimWorkflows(fixture.db, NOW + 1_000_000), []);
});

test('completed receipt claim results remain readable while commerce is paused', async (t) => {
  const fixture = setup();
  t.after(() => fixture.database.close());
  const reserved = await reserveReceiptClaimWorkflow(fixture.context, CODE, RECIPIENT, NOW);
  if (reserved.status !== 'pending') return assert.fail();
  const result = { processed: true, dropId: DROP, deliveryId: 7, receiptKind: 'box' as const, receiptsTransferred: 1, receiptTxs: [] };
  await completeReceiptClaimWorkflow(fixture.context, reserved.snapshot, result);
  fixture.database.exec(`INSERT INTO commerce_authority_control_lease (
      singleton, lease_token, acquired_at_ms, expires_at_ms
    ) VALUES (1, '00000000-0000-4000-8000-000000000717',
      CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 60000);
    UPDATE commerce_authority_control SET authority_state = 'paused', revision = revision + 1,
      paused_at_ms = NULL, updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE singleton = 1;
    DELETE FROM commerce_authority_control_lease WHERE singleton = 1`);
  const stored = await loadReceiptClaimWorkflow(fixture.context, reserved.snapshot.operation.operationId);
  assert.equal(stored?.operation.phase, 'complete');
  assert.deepEqual(stored?.operation.result, result);
});

test('uncertain receipt claim failures remain locked and retries require a new request token', async (t) => {
  const fixture = setup();
  t.after(() => fixture.database.close());
  const reserved = await reserveReceiptClaimWorkflow(fixture.context, CODE, RECIPIENT, NOW);
  if (reserved.status !== 'pending') return assert.fail();
  await persistReceiptClaimWorkflowSubmission(fixture.context, reserved.snapshot, submission());
  await failReceiptClaimWorkflow(fixture.context, reserved.snapshot, { code: 'unavailable', message: 'Retry later.', retryable: true }, false);
  const current = await loadReceiptClaimWorkflow(fixture.context, reserved.snapshot.operation.operationId);
  assert.equal(current?.operation.phase, 'manual_review');
  assert.ok(current);
  assert.equal(await advanceReceiptClaimWorkflowGeneration(fixture.context, current, NOW + 1_000_000,
    { resetRetryWindow: true, requestId: current.operation.requestId }), null);
  const restarted = await advanceReceiptClaimWorkflowGeneration(fixture.context, current, NOW + 1_000_000,
    { resetRetryWindow: true, requestId: crypto.randomUUID() });
  assert.equal(restarted?.operation.generation, 2);
  assert.equal(restarted?.operation.submission?.signature, 'signature-one');
  await assert.rejects(reserveReceiptClaimWorkflow(fixture.context, CODE, 'another-recipient', NOW + 1_000_000), /original receiver/);
});

test('a joined request replay cannot restart a failed receipt operation', async (t) => {
  const fixture = setup();
  t.after(() => fixture.database.close());
  const originalId = crypto.randomUUID();
  const joinedId = crypto.randomUUID();
  const reserved = await reserveReceiptClaimWorkflow(fixture.context, CODE, RECIPIENT, NOW, { requestId: originalId });
  if (reserved.status !== 'pending') return assert.fail();
  await reserveReceiptClaimWorkflow(fixture.context, CODE, RECIPIENT, NOW, { requestId: joinedId });
  await failReceiptClaimWorkflow(fixture.context, reserved.snapshot, { code: 'unavailable', message: 'Retry later.', retryable: true }, false);
  const failed = await loadReceiptClaimWorkflow(fixture.context, reserved.snapshot.operation.operationId);
  assert.ok(failed);
  assert.deepEqual(failed.operation.requestIds, [originalId, joinedId]);
  assert.equal(await advanceReceiptClaimWorkflowGeneration(fixture.context, failed, NOW,
    { resetRetryWindow: true, requestId: joinedId }), null);
  const fresh = crypto.randomUUID();
  const resumed = await advanceReceiptClaimWorkflowGeneration(fixture.context, failed, NOW,
    { resetRetryWindow: true, requestId: fresh });
  assert.deepEqual(resumed?.operation.requestIds, [originalId, joinedId, fresh]);
});

test('claim dispatch leases expire without releasing durable recipient ownership', async (t) => {
  const fixture = setup();
  t.after(() => fixture.database.close());
  const reserved = await reserveReceiptClaimWorkflow(fixture.context, CODE, RECIPIENT, NOW);
  if (reserved.status !== 'pending') return assert.fail();
  const args = { operationId: reserved.snapshot.operation.operationId, generation: 1, nowMs: NOW };
  assert.ok(await claimReceiptClaimWorkflowDispatch(fixture.context, args));
  assert.equal(await claimReceiptClaimWorkflowDispatch(fixture.context, args), null);
  assert.ok(await claimReceiptClaimWorkflowDispatch(fixture.context, { ...args, nowMs: NOW + 30_000 }));
  await assert.rejects(reserveReceiptClaimWorkflow(fixture.context, CODE, 'another-recipient', NOW + 1_000_000), /original receiver/);
});

test('legacy claim adoption waits for old handlers and retains recipient restrictions', async (t) => {
  const fixture = setup({}, { status: 'processing', recipient: RECIPIENT,
    processingStartedAt: NOW - 100_000, processingLeaseExpiresAt: NOW - 10_000 });
  t.after(() => fixture.database.close());
  await assert.rejects(reserveReceiptClaimWorkflow(fixture.context, CODE, RECIPIENT, NOW), /previous receipt claim request/);
  await assert.rejects(reserveReceiptClaimWorkflow(fixture.context, CODE, 'another-recipient', NOW + 180_000), /locked/);
  const adopted = await reserveReceiptClaimWorkflow(fixture.context, CODE, RECIPIENT, NOW + 180_000);
  assert.equal(adopted.status, 'pending');
});

test('direct legacy processing without a journal keeps its original recipient and rejects missing identity', async (t) => {
  for (const recipient of [RECIPIENT, '', 'invalid']) {
    const fixture = setup({}, { status: 'processing', recipient, receiptKind: 'figure', receiptAssetId: RECIPIENT,
      figureId: 16, processingStartedAt: NOW - 300_000, processingLeaseExpiresAt: NOW - 100_000 });
    t.after(() => fixture.database.close());
    await assert.rejects(reserveReceiptClaimWorkflow(fixture.context, CODE, '22222222222222222222222222222222', NOW),
      recipient === RECIPIENT ? /locked/ : /receiver is invalid/);
  }
});

test('different claims in one order retain independent recipients and completion mirrors', async (t) => {
  const fixture = setup();
  t.after(() => fixture.database.close());
  const otherCode = 'ABCDEF-0987654321';
  seedCommerceDocument(fixture, { key: commerceKeys.claimCode(otherCode), data: {
    namespace: 'stripe_receipt_v1', code: otherCode, dropId: DROP, deliveryId: 7, boxId: 17, status: 'unclaimed',
  } });
  await fixture.context.repository.run(NOW, async (unit) => unit.update(commerceKeys.deliveryOrder(DROP, '7'), {
    stripeReceiptClaimsByBoxId: {
      box_16: { namespace: 'stripe_receipt_v1', code: CODE, boxId: 16, status: 'unclaimed' },
      box_17: { namespace: 'stripe_receipt_v1', code: otherCode, boxId: 17, status: 'unclaimed' },
    },
  }));
  const starts = await Promise.all([
    reserveReceiptClaimWorkflow(fixture.context, CODE, RECIPIENT, NOW),
    reserveReceiptClaimWorkflow(fixture.context, otherCode, 'other-recipient', NOW),
  ]);
  await Promise.all(starts.map((entry) => {
    if (entry.status !== 'pending') return assert.fail();
    return completeReceiptClaimWorkflow(fixture.context, entry.snapshot, {
      processed: true, dropId: DROP, deliveryId: 7, receiptKind: 'box', receiptsTransferred: 1, receiptTxs: [],
    });
  }));
  const order = await fixture.context.repository.get(commerceKeys.deliveryOrder(DROP, '7'));
  const claims = order?.data.stripeReceiptClaimsByBoxId as Record<string, { recipient: string; status: string }>;
  assert.equal(claims.box_16.recipient, RECIPIENT);
  assert.equal(claims.box_17.recipient, 'other-recipient');
  assert.equal(claims.box_16.status, 'claimed');
  assert.equal(claims.box_17.status, 'claimed');
});

test('stored Workflow validation rejects malformed recovery state', async (t) => {
  const fixture = setup();
  t.after(() => fixture.database.close());
  const reserved = await reserveReceiptClaimWorkflow(fixture.context, CODE, RECIPIENT, NOW);
  if (reserved.status !== 'pending') return assert.fail();
  assert.throws(() => parseReceiptClaimWorkflowState({ ...reserved.snapshot.operation, claim: { ...reserved.snapshot.started, receiptTxs: [1] } }), /invalid/);
  assert.throws(() => parseReceiptClaimWorkflowState({ ...reserved.snapshot.operation, error: { code: 'internal', message: 'oops', retryable: 'yes' } }), /invalid/);
});
