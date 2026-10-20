import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import bs58 from 'bs58';
import {
  BINDER_RECEIPT_ISSUANCE_ID,
  BINDER_RECEIPT_ISSUANCE_OWNER,
  buildBinderReceiptIssuanceDocuments,
  preflightBinderReceiptIssuance,
  publishBinderReceiptIssuance,
  type BinderReceiptIssuancePlan,
} from '../scripts/shared/binderReceiptIssuanceStore.ts';
import { commerceKeys, D1CommerceRepository } from '../cloud/workers/api/src/commerceRepository.ts';
import { fulfillmentOrdersQuery } from '../cloud/workers/api/src/commerceQueries.ts';
import { startClaim } from '../cloud/workers/api/src/stripeReceiptClaimStore.ts';
import { createCommerceD1Harness, seedCommerceDocument, type CommerceD1Harness } from '../cloud/workers/api/test/commerceD1Harness.ts';
import { fulfillmentOrderFromRecord } from '../shared/fulfillmentReadModel.ts';
import { FRONTEND_DROPS } from '../src/config/deployment.ts';
import { buildFulfillmentOrdersExport, buildFulfillmentSecretCodeExportEntries } from '../src/lib/fulfillmentExports.ts';
import { filterFulfillmentOrdersByVisibility } from '../src/lib/fulfillmentOrderVisibility.ts';

function plan(): BinderReceiptIssuancePlan {
  return {
    issuanceId: BINDER_RECEIPT_ISSUANCE_ID,
    deliveryId: 20261020,
    receiptOwner: BINDER_RECEIPT_ISSUANCE_OWNER,
    createdAtMs: Date.parse('2026-10-20T19:00:00Z'),
    receipts: [21, 22].map((receiptId, index) => ({
      receiptId, code: ['ABCDEF-1234567890', 'GHIJKL-0123456789'][index],
      assetId: bs58.encode(new Uint8Array(32).fill(receiptId)),
      signature: bs58.encode(new Uint8Array(64).fill(receiptId)),
    })),
  };
}

function dependencies(harness: CommerceD1Harness, transform?: (sql: string) => string) {
  const files: string[] = [];
  return {
    files,
    query: (sql: string) => harness.database.prepare(sql).all(),
    executeFile: (filePath: string) => {
      files.push(filePath);
      assert.equal(statSync(filePath).mode & 0o777, 0o600);
      assert.equal(statSync(path.dirname(filePath)).mode & 0o777, 0o700);
      const sql = readFileSync(filePath, 'utf8');
      harness.database.exec('BEGIN');
      try {
        harness.database.exec(transform ? transform(sql) : sql);
        harness.database.exec('COMMIT');
      } catch (error) {
        harness.database.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function existingClaim(harness: CommerceD1Harness) {
  seedCommerceDocument(harness, { key: commerceKeys.claimCode('EXISTN-1234567890'), data: {
    dropId: 'card_nft_binder', deliveryId: 9, boxId: 20, namespace: 'stripe_receipt_v1',
    code: 'EXISTN-1234567890', status: 'unclaimed',
  } });
  return harness.database.prepare("SELECT * FROM commerce_documents WHERE document_path = 'claimCodes/EXISTN-1234567890'").get();
}

test('publication creates one packing order and two claims without changing existing codes', async (t) => {
  const harness = createCommerceD1Harness();
  t.after(() => harness.database.close());
  const original = existingClaim(harness);
  const input = plan();
  const deps = dependencies(harness);
  const before = await preflightBinderReceiptIssuance(input, deps);
  assert.equal(before.status, 'available');
  assert.equal(harness.database.prepare('SELECT COUNT(*) AS count FROM commerce_documents').get()?.count, 1);
  assert.deepEqual(await publishBinderReceiptIssuance(input, deps), { status: 'published', deliveryId: input.deliveryId });
  assert.deepEqual(harness.database.prepare("SELECT * FROM commerce_documents WHERE document_path = 'claimCodes/EXISTN-1234567890'").get(), original);
  assert.equal(harness.database.prepare('SELECT COUNT(*) AS count FROM commerce_documents').get()?.count, 4);
  assert.equal(harness.database.prepare('SELECT COUNT(*) AS count FROM commerce_commit_guards').get()?.count, 0);
  assert.equal(harness.database.prepare('SELECT COUNT(*) AS count FROM commerce_delivery_recovery').get()?.count, 1);
  assert.equal(harness.database.prepare('SELECT documents_revision FROM commerce_authority_control').get()?.documents_revision, before.documentsRevision + 1);
  assert.equal(deps.files.length, 1);
  assert.equal(existsSync(path.dirname(deps.files[0])), false);
  assert.equal((await preflightBinderReceiptIssuance(input, deps)).status, 'published');

  const query = fulfillmentOrdersQuery({ dropId: 'card_nft_binder', limit: 100 });
  const rows = harness.database.prepare(query.sql).all(...query.bindings);
  assert.equal(rows.length, 1);
  const order = fulfillmentOrderFromRecord(String(input.deliveryId), JSON.parse(String(rows[0].document_json)), {
    dropId: 'card_nft_binder', canViewSensitiveAddress: false, decryptAddress: () => null,
  });
  assert.ok(order);
  assert.equal(order.status, 'ready_to_ship');
  assert.deepEqual(filterFulfillmentOrdersByVisibility([order], 'not_shipped'), [order]);
  assert.equal(order.address.label, 'Packing replacements');
  assert.deepEqual(order.boxes.map((box) => box.boxId), [21, 22]);
  const options = { dropById: new Map([['card_nft_binder', FRONTEND_DROPS.card_nft_binder]]) };
  assert.deepEqual(buildFulfillmentOrdersExport([order], options)[0].boxes?.map((box) => box.secretCode), input.receipts.map((receipt) => receipt.code));
  const exports = buildFulfillmentSecretCodeExportEntries([order], options);
  assert.equal(exports.length, 2);
  assert.deepEqual(exports.map((entry) => entry.secretCode), input.receipts.map((receipt) => receipt.code));
  assert.deepEqual(exports.map((entry) => entry.claimUrl), input.receipts.map((receipt) => `https://mons.shop/claim/?code=${receipt.code}`));
});

test('published receipts enter the real claim store and publication retries preserve claim state', async (t) => {
  const harness = createCommerceD1Harness();
  t.after(() => harness.database.close());
  const input = plan();
  const deps = dependencies(harness);
  await publishBinderReceiptIssuance(input, deps);
  const context = { repository: new D1CommerceRepository(harness.db), signal: new AbortController().signal, nowMs: input.createdAtMs + 1000 };
  const requestId = '00000000-0000-4000-8000-000000000001';
  const result = await startClaim(context, input.receipts[0].code, '11111111111111111111111111111111', 'attempt', context.nowMs, {
    operationId: `src-v1-${requestId}`, requestId,
  });
  assert.equal(result.status, 'started');
  assert.equal(result.boxId, 21);
  const before = harness.database.prepare('SELECT * FROM commerce_documents ORDER BY document_path').all();
  assert.deepEqual(await publishBinderReceiptIssuance(input, deps), { status: 'already_published', deliveryId: input.deliveryId });
  assert.equal(deps.files.length, 1);
  assert.deepEqual(harness.database.prepare('SELECT * FROM commerce_documents ORDER BY document_path').all(), before);
});

test('a failed import rolls back every new record and removes the private SQL file', async (t) => {
  const harness = createCommerceD1Harness();
  t.after(() => harness.database.close());
  const original = existingClaim(harness);
  const input = plan();
  const deps = dependencies(harness, (sql) => sql.replace('INSERT INTO commerce_delivery_recovery (', 'INSERT INTO missing_recovery_table ('));
  await assert.rejects(publishBinderReceiptIssuance(input, deps), (error: Error) => {
    assert.match(error.message, /did not complete/);
    assert.ok(input.receipts.every((receipt) => !error.message.includes(receipt.code)));
    return true;
  });
  assert.equal(harness.database.prepare('SELECT COUNT(*) AS count FROM commerce_documents').get()?.count, 1);
  assert.equal(harness.database.prepare('SELECT COUNT(*) AS count FROM commerce_delivery_recovery').get()?.count, 0);
  assert.equal(harness.database.prepare('SELECT COUNT(*) AS count FROM commerce_commit_guards').get()?.count, 0);
  assert.deepEqual(harness.database.prepare('SELECT * FROM commerce_documents').get(), original);
  assert.equal(existsSync(path.dirname(deps.files[0])), false);
});

test('a lost publication acknowledgment reconciles without duplicating receipts or resetting codes', async (t) => {
  const harness = createCommerceD1Harness();
  t.after(() => harness.database.close());
  const input = plan();
  const deps = dependencies(harness);
  const executeFile = deps.executeFile;
  deps.executeFile = (filePath) => { executeFile(filePath); throw new Error(input.receipts[0].code); };
  assert.equal((await publishBinderReceiptIssuance(input, deps)).status, 'published');
  assert.equal(harness.database.prepare('SELECT COUNT(*) AS count FROM commerce_documents').get()?.count, 3);
  assert.equal((await publishBinderReceiptIssuance(input, deps)).status, 'already_published');
  assert.equal(deps.files.length, 1);
});

test('a concurrent database change aborts the full publication under the revision guard', async (t) => {
  const harness = createCommerceD1Harness();
  t.after(() => harness.database.close());
  const input = plan();
  const deps = dependencies(harness);
  const executeFile = deps.executeFile;
  deps.executeFile = (filePath) => {
    existingClaim(harness);
    executeFile(filePath);
  };
  await assert.rejects(publishBinderReceiptIssuance(input, deps), /did not complete/);
  assert.equal(harness.database.prepare('SELECT COUNT(*) AS count FROM commerce_documents').get()?.count, 1);
  assert.equal(harness.database.prepare('SELECT COUNT(*) AS count FROM commerce_delivery_recovery').get()?.count, 0);
  assert.equal(harness.database.prepare('SELECT COUNT(*) AS count FROM commerce_commit_guards').get()?.count, 0);
});

test('preflight rejects another receipt owner, partial publication, or existing target IDs', async (t) => {
  for (const conflict of ['owner', 'partial', 'receipt', 'code'] as const) {
    const harness = createCommerceD1Harness();
    t.after(() => harness.database.close());
    const input = plan();
    const deps = dependencies(harness);
    if (conflict === 'owner') input.receiptOwner = '11111111111111111111111111111111';
    if (conflict === 'partial') {
      const document = buildBinderReceiptIssuanceDocuments(input)[1];
      seedCommerceDocument(harness, { key: commerceKeys.claimCode(input.receipts[0].code), data: document.data });
    }
    if (conflict === 'receipt') seedCommerceDocument(harness, { key: commerceKeys.claimCode('EXISTN-1234567890'), data: {
      dropId: 'card_nft_binder', boxId: 21, code: 'EXISTN-1234567890', status: 'claimed',
    } });
    if (conflict === 'code') seedCommerceDocument(harness, { key: commerceKeys.claimCode(input.receipts[0].code), data: {
      dropId: 'card_nft_2', boxId: 5, code: input.receipts[0].code, status: 'unclaimed',
    } });
    const before = harness.database.prepare('SELECT * FROM commerce_documents ORDER BY document_path').all();
    await assert.rejects(preflightBinderReceiptIssuance(input, deps));
    await assert.rejects(publishBinderReceiptIssuance(input, deps));
    assert.equal(deps.files.length, 0);
    assert.deepEqual(harness.database.prepare('SELECT * FROM commerce_documents ORDER BY document_path').all(), before);
  }
});

test('an exact operation ID cannot be republished with a different asset or mint signature', async (t) => {
  const harness = createCommerceD1Harness();
  t.after(() => harness.database.close());
  const input = plan();
  const deps = dependencies(harness);
  await publishBinderReceiptIssuance(input, deps);
  const before = harness.database.prepare('SELECT * FROM commerce_documents ORDER BY document_path').all();
  for (const field of ['assetId', 'signature'] as const) {
    const changed = structuredClone(input);
    changed.receipts[0][field] = bs58.encode(new Uint8Array(field === 'assetId' ? 32 : 64).fill(99));
    await assert.rejects(publishBinderReceiptIssuance(changed, deps), /does not match/);
  }
  assert.equal(deps.files.length, 1);
  assert.deepEqual(harness.database.prepare('SELECT * FROM commerce_documents ORDER BY document_path').all(), before);
});
