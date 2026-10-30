import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.ts';
import { EthereumRevealStore, type RevealReceiptClaim, type RevealSql } from '../src/ethereumRevealStore.ts';

const deployment: EthereumRevealDeployment = {
  deploymentId: 'dispatch-test', dropId: '111k_devnet', chainId: 11155111,
  contractAddress: `0x${'ab'.repeat(20)}`, metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/dispatch-test/',
  deploymentBlock: 100, catalogVersion: '111k-v1',
  templateJson: JSON.stringify({ name: '{{tokenId}}', description: '',
    image: 'https://wip.lil.org/111k/artwork_placeholder.png', attributes: [] }),
  templateSha256: '0'.repeat(64), state: 'active', revision: 3, createdAtMs: 1, updatedAtMs: 3,
  provisionedAtMs: 2, activatedAtMs: 3, lastError: null,
};
const hash = (id: number) => `0x${id.toString(16).padStart(64, '0')}`;

function fixture(t: TestContext) {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys=ON');
  const sql: RevealSql = { exec(query, ...bindings) {
    const statement = database.prepare(query);
    const parameters = bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    const result = statement.columns().length ? statement.all(...parameters) : (statement.run(...parameters), []);
    return { toArray: () => result as never[] };
  } };
  const transaction = <T>(action: () => T): T => {
    database.exec('BEGIN');
    try { const result = action(); database.exec('COMMIT'); return result; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  };
  const reopen = () => new EthereumRevealStore(sql, transaction, () => 0);
  const store = reopen();
  store.configure(deployment);
  t.after(() => database.close());
  return { database, store, reopen };
}

test('receipt and overflow permits share a durable sixty-four inspection ceiling and retain their lanes after restart', t => {
  const { store, reopen } = fixture(t);
  const now = 1_000_000;
  const active: RevealReceiptClaim[] = [];
  for (let id = 1; id <= 63; id++) {
    store.admitTransaction(hash(id), 100, id <= 47 ? now : now - 60_000);
    const claim = store.claimReceipt(now, id <= 47 ? 'active' : 'background', hash(id));
    assert.ok(claim);
    if (claim.active) active.push(claim);
  }
  const overflow = store.claimOverflow(hash(64), now, now + 2_000);
  assert.ok(overflow);
  assert.equal(store.knownTransaction(hash(64)), false);
  assert.equal(store.opaqueCount(), 63);
  store.admitTransaction(hash(65), 100, now);
  assert.equal(store.claimReceipt(now, 'active', hash(65)), null);
  assert.equal(store.claimOverflow(hash(66), now, now + 2_000), null);
  const restored = reopen();
  assert.deepEqual(restored.dispatchState(now), { limit: 64, inFlight: 64, active: 48, background: 16,
    pauseUntilMs: 0, nextRecoveryMs: null, earliestLeaseUntilMs: now + 2_000 });
  assert.equal(restored.claimReceipt(now, 'active', hash(65)), null);
  assert.equal(restored.claimOverflow(hash(66), now, now + 2_000), null);
  assert.equal(restored.failReceipt(active[0], now), true);
  assert.ok(restored.claimReceipt(now, 'active', hash(65)));
  assert.equal(restored.dispatchState(now).inFlight, 64);
  assert.equal(restored.releaseOverflow(overflow), true);
  assert.ok(restored.claimOverflow(hash(66), now, now + 2_000));
});

test('normal and overflow verifiers cannot inspect the same hash concurrently', t => {
  const { store, reopen } = fixture(t);
  const now = 1_000_000;
  store.admitTransaction(hash(1), 100, now);
  const normal = store.claimReceipt(now, 'active', hash(1));
  assert.ok(normal);
  assert.equal(store.claimOverflow(hash(1), now, now + 2_000), null);
  const overflow = store.claimOverflow(hash(2), now, now + 2_000);
  assert.ok(overflow);
  store.admitTransaction(hash(2), 100, now);
  store.admitTransaction(hash(3), 100, now);
  assert.equal(store.claimOverflow(hash(2), now, now + 2_000), null);
  assert.equal(store.claimReceipt(now, 'active', hash(2)), null);
  assert.equal(store.claimReceipt(now, 'active')?.hash, hash(3));
  const restored = reopen();
  assert.equal(restored.validReceiptClaim(normal, now), true);
  assert.equal(restored.validOverflow(overflow, now), true);
  assert.equal(restored.claimReceipt(now, 'active', hash(2)), null);
  assert.equal(restored.releaseOverflow(overflow), true);
  assert.equal(restored.claimReceipt(now, 'active', hash(2))?.hash, hash(2));
});

test('expired permits free capacity while stale callbacks cannot release a newer verifier', t => {
  const { store, reopen } = fixture(t);
  const now = 1_000_000;
  assert.equal(store.claimOverflow(hash(1), now, now), null);
  const old = store.claimOverflow(hash(1), now, now + 500);
  assert.ok(old);
  assert.equal(old.leaseUntilMs, now + 500);
  assert.equal(store.validOverflow(old, now + 499), true);
  assert.equal(store.validOverflow(old, now + 500), false);
  const restored = reopen();
  const current = restored.claimOverflow(hash(1), now + 500, now + 100_000);
  assert.ok(current);
  assert.equal(current.leaseUntilMs, now + 30_500);
  assert.equal(restored.validOverflow(old, now + 500), false);
  assert.equal(restored.releaseOverflow(old), false);
  assert.equal(restored.validOverflow(current, now + 500), true);
  assert.equal(restored.dispatchState(now + 500).inFlight, 1);
  assert.equal(restored.dispatchState(now + 30_500).inFlight, 0);
  store.admitTransaction(hash(2), 100, now);
  const receipt = store.claimReceipt(now, 'active', hash(2));
  assert.ok(receipt);
  assert.equal(store.validReceiptClaim(receipt, now + 30_000), false);
  const replacement = restored.claimReceipt(now + 30_000, 'background', hash(2));
  assert.ok(replacement);
  assert.equal(restored.recordReceiptPresence(receipt, now + 30_000), false);
  assert.equal(restored.failReceipt(receipt, now + 30_000), false);
  assert.equal(restored.validReceiptClaim(replacement, now + 30_000), true);
});

test('provider throttling pauses receipt, overflow and discovery work but leaves admitted work durable', t => {
  const { store, reopen } = fixture(t);
  const now = 1_000_000;
  store.admitTransaction(hash(1), 100, now);
  store.admitTokens(['1'], 100, now);
  store.recordThrottle(now, 5_000);
  assert.deepEqual(store.dispatchState(now), { limit: 32, inFlight: 0, active: 0, background: 0,
    pauseUntilMs: now + 5_000, nextRecoveryMs: now + 35_000, earliestLeaseUntilMs: null });
  assert.equal(store.nextWake(now), now + 5_000);
  const restored = reopen();
  assert.equal(restored.claimReceipt(now + 4_999, 'active', hash(1)), null);
  assert.equal(restored.claimOverflow(hash(2), now + 4_999, now + 7_000), null);
  assert.equal(restored.claimScan(now + 4_999, 'active'), null);
  assert.equal(restored.knownTransaction(hash(1)), true);
  assert.equal(restored.knownTokens(['1'], now), true);
  assert.ok(restored.claimReceipt(now + 5_000, 'active', hash(1)));
  assert.ok(restored.claimScan(now + 5_000, 'active'));
  assert.ok(restored.claimOverflow(hash(2), now + 5_000, now + 7_000));
});

test('concurrent throttle reports halve once per cooldown and recovery adds four after each thirty quiet seconds', t => {
  const { store, reopen } = fixture(t);
  const now = 1_000_000;
  store.recordThrottle(now, 2_000);
  store.recordThrottle(now + 1, 5_000);
  assert.equal(store.dispatchState(now + 1).limit, 32);
  assert.equal(store.dispatchState(now + 1).pauseUntilMs, now + 5_001);
  assert.equal(store.dispatchState(now + 35_000).limit, 32);
  const restored = reopen();
  assert.equal(restored.dispatchState(now + 35_001).limit, 36);
  assert.equal(restored.dispatchState(now + 65_001).limit, 40);
  assert.equal(restored.dispatchState(now + 245_001).limit, 64);
  assert.equal(restored.dispatchState(now + 245_001).nextRecoveryMs, null);
  assert.equal(restored.nextWake(now + 245_001), null);
});

test('provider Retry-After values longer than five minutes remain honored and visible after restart', t => {
  const { store, reopen } = fixture(t);
  const now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  store.admitTransaction(hash(1), 100, now);
  store.admitTokens(['1'], 100, now);
  store.recordThrottle(now, 600_000);
  const restored = reopen();
  assert.equal(restored.summary().recovery.dispatch.pauseUntilMs, now + 600_000);
  assert.equal(restored.nextWake(now), now + 600_000);
  assert.equal(restored.claimReceipt(now + 599_999, 'background', hash(1)), null);
  assert.equal(restored.claimScan(now + 599_999, 'background'), null);
  assert.equal(restored.claimOverflow(hash(2), now + 599_999, now + 605_000), null);
  assert.ok(restored.claimReceipt(now + 600_000, 'background', hash(1)));
  assert.ok(restored.claimScan(now + 600_000, 'background'));
  assert.equal(restored.dispatchState(now + 629_999).limit, 32);
  assert.equal(restored.dispatchState(now + 630_000).limit, 36);
});

test('oversized and invalid throttle delays cannot create unsafe alarm timestamps', t => {
  const { store } = fixture(t);
  const now = 1_000_000;
  store.recordThrottle(now, Number.MAX_VALUE);
  const state = store.dispatchState(now);
  assert.ok(Number.isSafeInteger(state.pauseUntilMs));
  assert.ok(Number.isSafeInteger(state.nextRecoveryMs));
  assert.ok(Number.isFinite(new Date(state.nextRecoveryMs!).getTime()));
  for (const value of [NaN, Infinity, -1]) {
    store.recordThrottle(now, value);
    assert.equal(store.dispatchState(now).pauseUntilMs, state.pauseUntilMs);
  }
});

test('distinct throttle episodes reach a floor of four and existing inspections are allowed to settle', t => {
  const { store } = fixture(t);
  let now = 1_000_000;
  const running: RevealReceiptClaim[] = [];
  for (let id = 1; id <= 8; id++) {
    store.admitTransaction(hash(id), 100, now);
    const claim = store.claimReceipt(now, 'active', hash(id));
    assert.ok(claim);
    running.push(claim);
  }
  store.admitTransaction(hash(9), 100, now);
  for (let episode = 0; episode < 6; episode++) {
    store.recordThrottle(now, 1_000);
    now += 1_000;
  }
  assert.equal(store.dispatchState(now).limit, 4);
  assert.equal(store.dispatchState(now).inFlight, 8);
  assert.equal(store.claimReceipt(now, 'active', hash(9)), null);
  for (const claim of running.slice(0, 5)) assert.equal(store.failReceipt(claim, now), true);
  assert.ok(store.claimReceipt(now, 'active', hash(9)));
  assert.equal(store.dispatchState(now).inFlight, 4);
});

test('a full receipt pool waits for its next lease while token recovery remains independent', t => {
  const { store } = fixture(t);
  const now = 1_000_000;
  for (let id = 1; id <= 65; id++) store.admitTransaction(hash(id), 100, now);
  for (let id = 1; id <= 64; id++) assert.ok(store.claimReceipt(now, 'active', hash(id)));
  assert.equal(store.nextWake(now), now + 30_000);
  store.admitTokens(['1'], 100, now);
  assert.equal(store.nextWake(now), now + 250);
  assert.ok(store.claimScan(now, 'active'));
  assert.equal(store.nextWake(now), now + 30_000);
  assert.ok(store.claimReceipt(now + 30_000, 'background', hash(65)));
});

test('provider cooldown does not prevent publication of already frozen metadata', t => {
  const { store } = fixture(t);
  const now = 1_000_000;
  while (!store.initializeChunk()) {}
  store.freeze(deployment, { transactionHash: hash(1), blockHash: hash(101), blockNumber: 101 },
    [{ crateTokenId: '111112', tokenIds: Array.from({ length: 20 }, (_, index) => String(index + 1)) }], now);
  store.recordThrottle(now, 10_000);
  assert.equal(store.nextWake(now), now + 250);
  const jobs = store.claimPublications(now);
  assert.equal(jobs.length, 8);
  assert.ok(jobs.every(job => JSON.parse(job.metadata_json).revealStatus === 'revealed'));
});

test('legacy live receipt claims preserve their capacity and lane when the dispatch migration is installed', t => {
  const { database, store, reopen } = fixture(t);
  const now = 1_000_000;
  store.admitTransaction(hash(1), 100, now);
  store.admitTransaction(hash(2), 100, now - 60_000);
  const active = store.claimReceipt(now, 'active', hash(1));
  const background = store.claimReceipt(now, 'background', hash(2));
  assert.ok(active);
  assert.ok(background);
  database.exec('DROP INDEX receipt_live_claims');
  database.exec('ALTER TABLE receipt_work DROP COLUMN claim_active');
  database.exec('DROP TABLE reveal_dispatch_control');
  database.exec('DROP TABLE reveal_overflow_claims');
  const restored = reopen();
  assert.deepEqual(restored.dispatchState(now), { limit: 64, inFlight: 2, active: 1, background: 1,
    pauseUntilMs: 0, nextRecoveryMs: null, earliestLeaseUntilMs: now + 30_000 });
  assert.equal(restored.validReceiptClaim(active, now), true);
  assert.equal(restored.validReceiptClaim(background, now), true);
  assert.equal(restored.claimReceipt(now, 'active', hash(1)), null);
});
