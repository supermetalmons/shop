import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { encodeCall } from '../shared/ethereum/abi.ts';
import { ETHEREUM_FUNCTIONS } from '../shared/ethereum/protocol.ts';
import { ETHEREUM_DROP_OPERATION_TTL, definiteEthereumSubmissionRejection, migrateEthereumDropOperation, readEthereumDropBusy, readEthereumDropOperations, runEthereumDropRequest, subscribeEthereumDropOperations, writeEthereumDropOperation, type EthereumDropOperation } from '../src/ethereum/dropOperations.ts';
import { ethereumSubmittedNonceConsumed } from '../src/ethereum/recovery.ts';
import { forgetEthereumRevealJob, readEthereumPending, readEthereumRevealJobs, rememberEthereumRevealJob, runEthereumOperation, writeEthereumStorage } from '../src/ethereum/state.ts';

let dom: ReturnType<typeof setupFrontendDom>['dom'];
beforeEach(() => { ({ dom } = setupFrontendDom()); });
afterEach(() => { dom.window.close(); });
const owner = '0x1111111111111111111111111111111111111111';
const contract = '0x3333333333333333333333333333333333333333';
const scope = `11155111:${contract}:${owner}`;
const hash = `0x${'a'.repeat(64)}`;
const operation = (id = 'first', submittedAt = Date.now()): EthereumDropOperation => ({ id, scope, submittedAt, action: 'mint', kind: 'crate', quantity: 2,
  discountedQuantity: 0, sourceTokenIds: [], hash, intent: { to: contract, data: encodeCall(ETHEREUM_FUNCTIONS.mintCrates, ['uint256'], [2]), value: '0x0' } });
const legacyUnpack = (sourceTokenIds: string[], submittedAt = Date.now()) => ({ scope, action: 'unbox' as const, hash, submittedAt,
  intent: { to: contract, value: '0x0', data: sourceTokenIds.length === 1
    ? encodeCall(ETHEREUM_FUNCTIONS.unboxCrate, ['uint256'], sourceTokenIds)
    : encodeCall(ETHEREUM_FUNCTIONS.unboxCrates, ['uint256[]'], [sourceTokenIds]) } });

function installSubmissionLocks() {
  const held = new Set<string>();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: async (name: string, _options: unknown, run: (lock: object | null) => unknown) => {
      if (held.has(name)) return run(null);
      held.add(name);
      try { return await run({ name }); } finally { held.delete(name); }
    },
  } });
}

test('separate operation keys reconcile independently and scope records to the exact collection and account', () => {
  writeEthereumDropOperation(scope, 'first', operation());
  writeEthereumDropOperation(scope, 'second', operation('second'));
  const otherScope = `1:${contract}:${owner}`;
  writeEthereumDropOperation(otherScope, 'first', { ...operation(), scope: otherScope });
  assert.equal(readEthereumDropOperations(scope).length, 2);
  writeEthereumDropOperation(scope, 'first', null);
  assert.deepEqual(readEthereumDropOperations(scope).map(item => item.id), ['second']);
  assert.equal(readEthereumDropOperations(otherScope).length, 1);
});

test('lease is tied to original submission and has no side effects when records are read', () => {
  const now = Date.now();
  writeEthereumDropOperation(scope, 'first', operation('first', now));
  assert.equal(readEthereumDropOperations(scope, now + ETHEREUM_DROP_OPERATION_TTL - 1).length, 1);
  assert.equal(readEthereumDropOperations(scope, now + ETHEREUM_DROP_OPERATION_TTL).length, 0);
  assert.equal(readEthereumDropOperations(scope, now + ETHEREUM_DROP_OPERATION_TTL, true)[0].submittedAt, now);
});

test('unavailable browser storage supports creation, update, and deletion in memory', t => {
  t.mock.method(window.Storage.prototype, 'setItem', () => { throw new Error('Full'); });
  t.mock.method(window.Storage.prototype, 'removeItem', () => { throw new Error('Full'); });
  writeEthereumDropOperation(scope, 'first', operation());
  assert.equal(readEthereumDropOperations(scope).length, 1);
  writeEthereumDropOperation(scope, 'first', { ...operation(), quantity: 3 });
  assert.equal(readEthereumDropOperations(scope)[0].quantity, 3);
  writeEthereumDropOperation(scope, 'first', null);
  assert.equal(readEthereumDropOperations(scope).length, 0);
});

test('a newer cross-tab value supersedes a failed local write and notifies subscribers', t => {
  const key = `ethereum111k:drop-operation:v1:${scope}:first`;
  writeEthereumDropOperation(scope, 'first', operation());
  const mock = t.mock.method(window.Storage.prototype, 'setItem', () => { throw new Error('Full'); });
  writeEthereumDropOperation(scope, 'first', { ...operation(), quantity: 3 });
  assert.equal(readEthereumDropOperations(scope)[0].quantity, 3);
  mock.mock.restore();
  let updates = 0;
  const unsubscribe = subscribeEthereumDropOperations(scope, () => { updates++; });
  window.localStorage.setItem(key, JSON.stringify({ ...operation(), quantity: 4 }));
  window.dispatchEvent(new window.StorageEvent('storage', { key }));
  assert.equal(updates, 1);
  assert.equal(readEthereumDropOperations(scope)[0].quantity, 4);
  unsubscribe();
});

test('legacy unpack migration preserves sources and age, discards provisional nonces, and leaves delivery records alone', () => {
  const submittedAt = Date.now() - 1000;
  writeEthereumStorage(`${scope}:pending`, { scope, action: 'unbox', submittedAt, hash, nonce: '0x3', intent: {
    to: contract, data: encodeCall(ETHEREUM_FUNCTIONS.unboxCrates, ['uint256[]'], [['111112', '111113']]), value: '0x0',
  } });
  migrateEthereumDropOperation(scope);
  const [migrated] = readEthereumDropOperations(scope);
  assert.deepEqual(migrated.sourceTokenIds, ['111112', '111113']);
  assert.equal(migrated.submittedAt, submittedAt);
  assert.equal(migrated.nonce, undefined);
  assert.equal(readEthereumPending(scope), null);
  migrateEthereumDropOperation(scope);
  assert.equal(readEthereumDropOperations(scope).length, 1);
  writeEthereumStorage(`${scope}:pending`, { ...operation(), action: 'delivery', orderId: 123 });
  migrateEthereumDropOperation(scope);
  assert.equal(readEthereumPending(scope)?.action, 'delivery');
});

for (const version of ['legacy', 'v2']) for (const ids of [['111112'], ['111112', '111113']]) {
  test(`migration preserves the ${version} reveal generation and scopes ${ids.length === 1 ? 'a single crate' : 'a batch of crates'} before clearing the legacy intent`, () => {
    const pending = legacyUnpack(ids, Date.now() - 1000);
    const jobSubmittedAt = pending.submittedAt - 500;
    if (version === 'legacy') writeEthereumStorage(`${scope}:reveals`, [{ transactionHash: hash, submittedAt: jobSubmittedAt }]);
    else rememberEthereumRevealJob(scope, hash, jobSubmittedAt);
    const [original] = readEthereumRevealJobs(scope);
    writeEthereumStorage(`${scope}:pending`, pending);
    migrateEthereumDropOperation(scope);
    const expected = [{ ...original, crateTokenIds: ids }];
    assert.deepEqual(readEthereumRevealJobs(scope), expected);
    assert.equal(readEthereumPending(scope), null);
    assert.deepEqual(readEthereumDropOperations(scope)[0].sourceTokenIds, ids);
    writeEthereumStorage(`${scope}:pending`, pending);
    migrateEthereumDropOperation(scope);
    migrateEthereumDropOperation(scope);
    assert.deepEqual(readEthereumRevealJobs(scope), expected);
    assert.equal(readEthereumDropOperations(scope).length, 1);
  });
}

test('migration preserves the source IDs of an already scoped reveal job', () => {
  const originalIntent = legacyUnpack(['111114'], Date.now() - 2000);
  rememberEthereumRevealJob(scope, hash, originalIntent.submittedAt, originalIntent);
  const original = readEthereumRevealJobs(scope);
  writeEthereumStorage(`${scope}:pending`, legacyUnpack(['111112', '111113'], Date.now() - 1000));
  migrateEthereumDropOperation(scope);
  assert.deepEqual(readEthereumRevealJobs(scope), original);
});

for (const state of ['missing', 'canceled', 'completed', 'expired']) {
  test(`migration leaves ${state} reveal tracking unchanged`, () => {
    const submittedAt = Date.now() - (state === 'expired' ? ETHEREUM_DROP_OPERATION_TTL + 1 : 1000);
    if (state !== 'missing') rememberEthereumRevealJob(scope, hash, submittedAt);
    const [original] = readEthereumRevealJobs(scope);
    if (state === 'canceled' || state === 'completed') forgetEthereumRevealJob(scope, hash, original.trackingId, state === 'completed');
    const jobs = readEthereumRevealJobs(scope);
    writeEthereumStorage(`${scope}:pending`, legacyUnpack(['111112'], submittedAt));
    migrateEthereumDropOperation(scope);
    assert.deepEqual(readEthereumRevealJobs(scope), jobs);
    assert.equal(readEthereumPending(scope), null);
    assert.equal(readEthereumDropOperations(scope).length, state === 'expired' ? 0 : 1);
  });
}

test('wallet submission mutex rejects overlap and releases independently of tracked receipts', async () => {
  let release!: () => void;
  const first = runEthereumDropRequest(scope, 'Minting', async () => { await new Promise<void>(resolve => { release = resolve; }); return hash; });
  assert.equal(readEthereumDropBusy(scope), 'Minting');
  await assert.rejects(runEthereumDropRequest(scope, 'Opening', async () => true), /request is already open/);
  writeEthereumDropOperation(scope, 'first', operation());
  release();
  assert.equal(await first, hash);
  assert.equal(readEthereumDropBusy(scope), null);
  assert.equal(await runEthereumDropRequest(scope, 'Opening', async () => true), true);
  assert.equal(readEthereumDropOperations(scope).length, 1);
});

test('a held legacy checkout request does not mark the drop busy or block mint and unpack requests', async () => {
  installSubmissionLocks();
  let busyUpdates = 0;
  const unsubscribe = subscribeEthereumDropOperations(scope, () => { busyUpdates++; });
  const release = Promise.withResolvers<void>();
  const checkout = runEthereumOperation(scope, 'Complete shipping checkout…', () => release.promise);
  try {
    assert.equal(readEthereumDropBusy(scope), null);
    assert.equal(busyUpdates, 0);
    assert.equal(await runEthereumDropRequest(scope, 'Minting', async () => 'minted'), 'minted');
    assert.equal(await runEthereumDropRequest(scope, 'Opening', async () => 'unpacked'), 'unpacked');
    assert.equal(readEthereumDropBusy(scope), null);
    assert.equal(busyUpdates, 4);
    release.resolve();
    await checkout;
    assert.equal(busyUpdates, 4);
  } finally {
    release.resolve();
    await checkout;
    unsubscribe();
  }
});

test('a held drop submission lock still excludes another drop request without a local busy entry', async () => {
  installSubmissionLocks();
  const release = Promise.withResolvers<void>();
  const competing = navigator.locks.request(`ethereum111k-drop-submission:${scope}`, {}, () => release.promise);
  try {
    assert.equal(readEthereumDropBusy(scope), null);
    let submitted = false;
    await assert.rejects(runEthereumDropRequest(scope, 'Minting', async () => { submitted = true; }), /request is already open/);
    assert.equal(submitted, false);
    assert.equal(readEthereumDropBusy(scope), null);
  } finally {
    release.resolve();
    await competing;
  }
  assert.equal(await runEthereumDropRequest(scope, 'Opening', async () => 'unpacked'), 'unpacked');
});

test('nonce retirement requires an observed sender, correct network, consumed nonce, and an actually absent receipt', async () => {
  const calls: string[] = [];
  let count = '0x2';
  let receipt: unknown = null;
  let chain = '0xaa36a7';
  const provider = { request: async ({ method }: { method: string }) => {
    calls.push(method);
    if (method === 'eth_chainId') return chain;
    if (method === 'eth_getTransactionCount') return count;
    if (method === 'eth_getTransactionReceipt') return receipt;
    throw new Error(method);
  } };
  assert.equal(await ethereumSubmittedNonceConsumed(provider, { hash, nonce: '0x1' }, 11155111), false);
  assert.equal(calls.length, 0);
  const observed = { hash, nonce: '0x1', transactionSender: owner };
  assert.equal(await ethereumSubmittedNonceConsumed(provider, observed, 11155111), true);
  receipt = { transactionHash: hash, status: '0x1' };
  assert.equal(await ethereumSubmittedNonceConsumed(provider, observed, 11155111), false);
  receipt = undefined;
  assert.equal(await ethereumSubmittedNonceConsumed(provider, observed, 11155111), false);
  receipt = null;
  count = '0x1';
  assert.equal(await ethereumSubmittedNonceConsumed(provider, observed, 11155111), false);
  count = '0x2';
  chain = '0x1';
  assert.equal(await ethereumSubmittedNonceConsumed(provider, observed, 11155111), false);
  await assert.rejects(ethereumSubmittedNonceConsumed({ request: async () => { throw new Error('RPC failed'); } }, observed, 11155111));
});

test('only definite wallet rejection permits immediate removal of an unsent hint', () => {
  for (const code of [4001, 4100, 4200, -32600, -32601, -32602]) assert.equal(definiteEthereumSubmissionRejection({ code }), true);
  assert.equal(definiteEthereumSubmissionRejection({ code: -32000, message: 'insufficient funds for gas * price + value' }), true);
  assert.equal(definiteEthereumSubmissionRejection({ code: -32000, message: 'nonce too low' }), false);
  assert.equal(definiteEthereumSubmissionRejection({ code: -32000, message: 'request timed out' }), false);
  assert.equal(definiteEthereumSubmissionRejection(new Error('Network disconnected')), false);
});
