import assert from 'node:assert/strict';
import test from 'node:test';
import { CommerceWriteConflict, D1CommerceRepository, commerceKeys, type CommerceUnitOfWork } from '../src/commerceRepository.ts';
import { createCommerceD1Harness, seedCommerceDocuments, type CommerceD1Harness } from './commerceD1Harness.ts';

type EthereumStateExpectation = Parameters<CommerceUnitOfWork['expectEthereumState']>[0];
const CONTRACT = `0x${'11'.repeat(20)}`;
const HASH = `0x${'22'.repeat(32)}`;
const BLOCK_HASH = `0x${'33'.repeat(32)}`;
const CLAIM_ID = `0x${'44'.repeat(32)}`;
const delivery = { kind: 'delivery', chainId: 31337, contractAddress: CONTRACT, id: '42', status: 'confirmed',
  transactionHash: HASH, blockNumber: 100, blockHash: BLOCK_HASH, updatedAtMs: 1000 } as const;
const claim = { ...delivery, kind: 'claim', id: '2000001', orderId: 42, claimId: CLAIM_ID, status: 'claimed' } as const;
const orderKey = commerceKeys.deliveryOrder('111k_devnet', '42');
const otherKey = commerceKeys.deliveryOrder('111k_devnet', '43');

function seed(harness: CommerceD1Harness): void {
  harness.database.prepare(`INSERT INTO ethereum_delivery_quotes
    (chain_id, contract_address, order_id, request_id, wallet, address_id, address_json, token_ids_json,
      items_json, fee_wei, deadline, status, transaction_hash, block_number, block_hash, created_at_ms, updated_at_ms)
    VALUES (?, ?, 42, 'request', 'wallet', 'address', '{}', '[]', '[]', '0', 2000, 'confirmed', ?, 100, ?, 1000, 1000)`)
    .run(delivery.chainId, CONTRACT, HASH, BLOCK_HASH);
  harness.database.prepare(`INSERT INTO ethereum_crate_claims
    (chain_id, contract_address, receipt_id, crate_id, order_id, code_hash, code, claim_id, status,
      transaction_hash, block_number, block_hash, updated_at_ms)
    VALUES (?, ?, '2000001', 1, 42, 'code-hash', 'code', ?, 'claimed', ?, 100, ?, 1000)`)
    .run(delivery.chainId, CONTRACT, CLAIM_ID, HASH, BLOCK_HASH);
  seedCommerceDocuments(harness, [orderKey, otherKey].map((key) => ({ key, data: {
    source: 'ethereum', owner: 'wallet', status: 'ready_to_ship', fulfillmentStatus: 'Preparing',
  } })));
}

function guardCount(harness: CommerceD1Harness): number {
  return Number(harness.database.prepare('SELECT COUNT(*) AS count FROM commerce_commit_guards').get()!.count);
}

test('Ethereum source changes immediately before the commit batch abort every staged document write', async (context) => {
  let beforeCommit: (() => void) | undefined;
  const harness = createCommerceD1Harness({ observeCall: (operation) => {
    if (operation.method === 'batch' && operation.statements.some(({ sql }) => sql.includes('INSERT INTO commerce_commit_guards'))) {
      const change = beforeCommit;
      beforeCommit = undefined;
      change?.();
    }
  } });
  context.after(() => harness.database.close());
  seed(harness);
  const repository = new D1CommerceRepository(harness.db);
  const original = await Promise.all([repository.get(orderKey), repository.get(otherKey)]);
  const revision = harness.database.prepare('SELECT documents_revision FROM commerce_authority_control').get();
  const unit = await repository.begin(2000);
  await unit.getMany([orderKey, otherKey]);
  unit.expectEthereumState(delivery);
  await unit.update(orderKey, { status: 'processing' });
  await unit.update(otherKey, { fulfillmentStatus: 'Shipped' });
  beforeCommit = () => harness.database.prepare(`UPDATE ethereum_delivery_quotes
    SET status = 'pending', updated_at_ms = updated_at_ms + 1 WHERE order_id = 42`).run();
  await assert.rejects(unit.commit(), CommerceWriteConflict);
  assert.deepEqual(await Promise.all([repository.get(orderKey), repository.get(otherKey)]), original);
  assert.deepEqual(harness.database.prepare('SELECT documents_revision FROM commerce_authority_control').get(), revision);
  assert.equal(guardCount(harness), 0);
});

test('Ethereum expectations remain active for read-only and expectations-only commits', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  seed(harness);
  const repository = new D1CommerceRepository(harness.db);
  for (const readDocument of [false, true]) {
    harness.database.prepare('UPDATE ethereum_delivery_quotes SET updated_at_ms = 1000 WHERE order_id = 42').run();
    const unit = await repository.begin(2000);
    if (readDocument) await unit.get(orderKey);
    unit.expectEthereumState(delivery);
    harness.database.prepare('UPDATE ethereum_delivery_quotes SET deadline = deadline + 1, updated_at_ms = 1001 WHERE order_id = 42').run();
    await assert.rejects(unit.commit(), CommerceWriteConflict);
    assert.equal(guardCount(harness), 0);
  }
  const current = { ...delivery, updatedAtMs: 1001 };
  await repository.run(2001, async (unit) => {
    unit.expectEthereumState(current);
    unit.expectEthereumState(current);
  });
  assert.equal(guardCount(harness), 0);
});

test('replacing a crate claim at the same receipt invalidates its original order or claim identity', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  seed(harness);
  const repository = new D1CommerceRepository(harness.db);
  const original = await repository.get(orderKey);
  for (const replacement of [{ orderId: 43, claimId: CLAIM_ID }, { orderId: 42, claimId: `0x${'55'.repeat(32)}` }]) {
    harness.database.prepare('UPDATE ethereum_crate_claims SET order_id = 42, claim_id = ?').run(CLAIM_ID);
    const unit = await repository.begin(2000);
    await unit.get(orderKey);
    unit.expectEthereumState(claim);
    await unit.update(orderKey, { irlClaims: [{ boxId: 1, code: 'code', status: 'claimed' }] });
    harness.database.prepare('UPDATE ethereum_crate_claims SET order_id = ?, claim_id = ?')
      .run(replacement.orderId, replacement.claimId);
    await assert.rejects(unit.commit(), CommerceWriteConflict);
    assert.deepEqual(await repository.get(orderKey), original);
    assert.equal(guardCount(harness), 0);
  }
});

test('matching nullable Ethereum state commits and conflicting repeated expectations fail closed', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  seed(harness);
  harness.database.prepare(`UPDATE ethereum_delivery_quotes SET status = 'prepared',
    transaction_hash = NULL, block_number = NULL, block_hash = NULL`).run();
  harness.database.prepare(`UPDATE ethereum_crate_claims SET status = 'available',
    transaction_hash = NULL, block_number = NULL, block_hash = NULL`).run();
  const repository = new D1CommerceRepository(harness.db);
  const expectations: EthereumStateExpectation[] = [
    { ...delivery, status: 'prepared', transactionHash: null, blockNumber: null, blockHash: null },
    { ...claim, status: 'available', transactionHash: null, blockNumber: null, blockHash: null },
  ];
  await repository.run(2000, async (unit) => {
    await unit.get(orderKey);
    for (const expectation of expectations) unit.expectEthereumState(expectation);
    await unit.update(orderKey, { status: 'processing' });
  });
  assert.equal((await repository.get(orderKey))!.data.status, 'processing');
  const unit = await repository.begin(2001);
  unit.expectEthereumState(expectations[0]);
  assert.throws(() => unit.expectEthereumState({ ...expectations[0], updatedAtMs: 1001 }), CommerceWriteConflict);
  unit.rollback();
  assert.equal(guardCount(harness), 0);
});
