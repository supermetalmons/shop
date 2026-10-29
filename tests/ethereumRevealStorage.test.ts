import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, type TestContext } from 'node:test';
import { encodeCall } from '../shared/ethereum/abi.ts';
import { ETHEREUM_FUNCTIONS } from '../shared/ethereum/protocol.ts';
import {
  forgetEthereumRevealJob, readEthereumPending, readEthereumRevealJobs, rememberEthereumRevealJob,
  restorePendingEthereumRevealJob, subscribeEthereumRevealJobs, writeEthereumStorage, type EthereumPendingTransaction,
} from '../src/ethereum/state.ts';
import { installBrowserLocks } from './helpers/browserLocks.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const contract = `0x${'33'.repeat(20)}`;
const owner = `0x${'11'.repeat(20)}`;
const scope = `11155111:${contract}:${owner}`;
const hashA = `0x${'aa'.repeat(32)}`;
const hashB = `0x${'bb'.repeat(32)}`;
const hashC = `0x${'cc'.repeat(32)}`;
const recordKey = (hash: string, selectedScope = scope) => `ethereum111k:${selectedScope}:reveal-job:v2:${hash}`;
const legacyKey = `ethereum111k:${scope}:reveals`;
let environment: ReturnType<typeof setupFrontendDom>;

beforeEach(context => {
  environment = setupFrontendDom();
  installBrowserLocks(context as TestContext);
});
afterEach(() => environment.dom.window.close());

function pending(hash = hashA): EthereumPendingTransaction {
  return { scope, hash, action: 'unbox', submittedAt: 1,
    intent: { to: contract, data: encodeCall(ETHEREUM_FUNCTIONS.unboxCrate, ['uint256'], ['111112']), value: '0x0' } };
}

test('reveal jobs retain the intended single or batch crates, including the bonus crate, across reload', () => {
  for (const ids of [['116666'], ['111112', '116666']]) {
    const operation = pending(ids.length === 1 ? hashA : hashB);
    operation.intent!.data = ids.length === 1 ? encodeCall(ETHEREUM_FUNCTIONS.unboxCrate, ['uint256'], ids)
      : encodeCall(ETHEREUM_FUNCTIONS.unboxCrates, ['uint256[]'], [ids]);
    rememberEthereumRevealJob(scope, operation.hash, 1, operation);
    assert.deepEqual(readEthereumRevealJobs(scope).find(job => job.transactionHash === operation.hash)?.crateTokenIds, ids);
  }
  const saved = [hashA, hashB].map(hash => [recordKey(hash), window.localStorage.getItem(recordKey(hash))!] as const);
  environment.dom.window.close();
  environment = setupFrontendDom();
  for (const [key, value] of saved) window.localStorage.setItem(key, value);
  assert.deepEqual(readEthereumRevealJobs(scope).map(job => job.crateTokenIds), [['116666'], ['111112', '116666']]);
});

test('malformed or unrelated intents cannot attribute a transaction to selected crates', () => {
  const base = pending();
  const invalid = [
    { ...base, scope: `${scope}:other` }, { ...base, hash: hashB }, { ...base, action: 'mint' as const },
    { ...base, intent: { ...base.intent!, to: owner } }, { ...base, intent: { ...base.intent!, value: '0x1' } },
    ...[
      '0x', `${encodeCall(ETHEREUM_FUNCTIONS.unboxCrate, [], [])}`,
      encodeCall(ETHEREUM_FUNCTIONS.unboxCrate, ['uint256'], ['111111']),
      encodeCall(ETHEREUM_FUNCTIONS.unboxWarehouse, ['uint256'], ['116667']),
      encodeCall(ETHEREUM_FUNCTIONS.unboxCrates, ['uint256[]'], [[]]),
      encodeCall(ETHEREUM_FUNCTIONS.unboxCrates, ['uint256[]'], [['111112', '111112']]),
      encodeCall(ETHEREUM_FUNCTIONS.unboxCrates, ['uint256[]'], [Array.from({ length: 16 }, (_, index) => String(111112 + index))]),
      `${base.intent!.data}${'00'.repeat(32)}`,
    ].map(data => ({ ...base, intent: { ...base.intent!, data } })),
  ];
  for (const operation of invalid) {
    rememberEthereumRevealJob(scope, hashA, 1, operation);
    assert.equal(readEthereumRevealJobs(scope)[0].crateTokenIds, undefined);
  }
  rememberEthereumRevealJob(scope, hashA, 1, base);
  assert.deepEqual(readEthereumRevealJobs(scope)[0].crateTokenIds, ['111112']);
});

for (const legacy of [false, true]) test(`pending restoration enriches ${legacy ? 'legacy' : 'current'} jobs without changing their generation`, async () => {
  if (legacy) window.localStorage.setItem(legacyKey, JSON.stringify([{ transactionHash: hashA, submittedAt: 1 }]));
  else rememberEthereumRevealJob(scope, hashA, 1);
  const original = readEthereumRevealJobs(scope)[0];
  writeEthereumStorage(`${scope}:pending`, pending());
  await restorePendingEthereumRevealJob(scope, hashA);
  const enriched = { ...original, crateTokenIds: ['111112'] };
  assert.deepEqual(readEthereumRevealJobs(scope), [enriched]);
  const conflicting = pending();
  conflicting.intent!.data = encodeCall(ETHEREUM_FUNCTIONS.unboxCrate, ['uint256'], ['111113']);
  writeEthereumStorage(`${scope}:pending`, conflicting);
  await restorePendingEthereumRevealJob(scope, hashA);
  rememberEthereumRevealJob(scope, hashA, 99, conflicting);
  assert.deepEqual(readEthereumRevealJobs(scope), [enriched]);
  forgetEthereumRevealJob(scope, hashA, original.trackingId);
  await restorePendingEthereumRevealJob(scope, hashA);
  assert.deepEqual(readEthereumRevealJobs(scope), []);
});

test('legacy uppercase pending hashes retain the intended crate scope', async () => {
  rememberEthereumRevealJob(scope, hashA, 1);
  const operation = { ...pending(), hash: `0x${hashA.slice(2).toUpperCase()}` };
  writeEthereumStorage(`${scope}:pending`, operation);
  assert.deepEqual(readEthereumRevealJobs(scope)[0].crateTokenIds, ['111112']);
  await restorePendingEthereumRevealJob(scope, hashA);
  writeEthereumStorage(`${scope}:pending`, null);
  assert.deepEqual(readEthereumRevealJobs(scope)[0].crateTokenIds, ['111112']);
});

test('closing a generation during scope enrichment cannot reopen it', t => {
  rememberEthereumRevealJob(scope, hashA, 1);
  const original = readEthereumRevealJobs(scope)[0];
  const prototype = Object.getPrototypeOf(window.localStorage) as Storage;
  const setItem = prototype.setItem;
  let interleaved = false;
  t.mock.method(prototype, 'setItem', function(key: string, value: string) {
    if (key === recordKey(hashA) && !interleaved) {
      interleaved = true;
      forgetEthereumRevealJob(scope, hashA, original.trackingId);
    }
    setItem.call(this, key, value);
  });
  rememberEthereumRevealJob(scope, hashA, 1, pending());
  assert.ok(interleaved);
  assert.deepEqual(readEthereumRevealJobs(scope), []);
});

for (const [outer, inner] of [['add', 'add'], ['add', 'close'], ['close', 'add'], ['close', 'close']] as const) {
  test(`interleaved ${outer} A and ${inner} B preserve both reveal decisions`, t => {
    if (outer === 'close') rememberEthereumRevealJob(scope, hashA, 1);
    if (inner === 'close') rememberEthereumRevealJob(scope, hashB, 2);
    writeEthereumStorage(`${scope}:pending`, pending(hashB));
    const prototype = Object.getPrototypeOf(window.localStorage) as Storage;
    const setItem = prototype.setItem;
    const removeItem = prototype.removeItem;
    let interleaved = false;
    const interleave = () => {
      if (interleaved) return;
      interleaved = true;
      if (inner === 'add') rememberEthereumRevealJob(scope, hashB, 2);
      else {
        writeEthereumStorage(`${scope}:pending`, null);
        forgetEthereumRevealJob(scope, hashB);
      }
    };
    t.mock.method(prototype, 'setItem', function(key: string, value: string) { interleave(); setItem.call(this, key, value); });
    t.mock.method(prototype, 'removeItem', function(key: string) { interleave(); removeItem.call(this, key); });
    if (outer === 'add') rememberEthereumRevealJob(scope, hashA, 1);
    else forgetEthereumRevealJob(scope, hashA);
    assert.ok(interleaved);
    assert.deepEqual(readEthereumRevealJobs(scope).map(job => job.transactionHash), [
      ...(outer === 'add' ? [hashA] : []), ...(inner === 'add' ? [hashB] : []),
    ]);
    if (inner === 'close') assert.equal(readEthereumPending(scope), null);
  });
}

test('legacy reveal arrays remain read-only and stale legacy writes cannot reopen a closed job', t => {
  const legacy = JSON.stringify([{ transactionHash: hashA, submittedAt: 1 }, { transactionHash: hashB, submittedAt: 2 },
    { transactionHash: hashB, submittedAt: 2 }, null, {}, { transactionHash: hashC, submittedAt: -1 }]);
  window.localStorage.setItem(legacyKey, legacy);
  const writes = t.mock.method(Object.getPrototypeOf(window.localStorage), 'setItem');
  assert.deepEqual(readEthereumRevealJobs(scope), [
    { transactionHash: hashA, submittedAt: 1, trackingId: 'legacy' },
    { transactionHash: hashB, submittedAt: 2, trackingId: 'legacy' },
  ]);
  rememberEthereumRevealJob(scope, hashB, 99);
  assert.equal(writes.mock.callCount(), 0);
  forgetEthereumRevealJob(scope, hashA, 'legacy');
  assert.equal(window.localStorage.getItem(legacyKey), legacy);
  window.localStorage.setItem(legacyKey, JSON.stringify([{ transactionHash: hashA, submittedAt: 1 },
    { transactionHash: hashB, submittedAt: 2 }, { transactionHash: hashC, submittedAt: 3 }]));
  assert.deepEqual(readEthereumRevealJobs(scope).map(job => job.transactionHash), [hashB, hashC]);
  assert.ok(writes.mock.calls.slice(0, -1).every(call => call.arguments[0] !== legacyKey));
});

test('explicitly returning to a closed hash creates a generation immune to earlier completion', () => {
  rememberEthereumRevealJob(scope, hashA, 1);
  const first = readEthereumRevealJobs(scope)[0];
  forgetEthereumRevealJob(scope, hashA, first.trackingId);
  rememberEthereumRevealJob(scope, hashB, 2);
  forgetEthereumRevealJob(scope, hashB);
  rememberEthereumRevealJob(scope, hashA, 3);
  const reopened = readEthereumRevealJobs(scope)[0];
  assert.notEqual(reopened.trackingId, first.trackingId);
  forgetEthereumRevealJob(scope, hashA, first.trackingId);
  rememberEthereumRevealJob(scope, hashA, 99);
  assert.deepEqual(readEthereumRevealJobs(scope), [reopened]);
  assert.equal(reopened.submittedAt, 3);
  assert.equal(window.localStorage.getItem(`ethereum111k:${scope}:reveal-closed:v2:${hashA}:${first.trackingId}`), 'true');
  assert.ok(window.localStorage.getItem(recordKey(hashA))?.includes(reopened.trackingId));
});

test('pending restoration waits for the submission lock and rechecks dismissal', async () => {
  writeEthereumStorage(`${scope}:pending`, pending());
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const competing = navigator.locks.request(`ethereum111k-submission:${scope}`, {}, () => { entered.resolve(); return release.promise; });
  await entered.promise;
  const restoring = restorePendingEthereumRevealJob(scope, hashA);
  writeEthereumStorage(`${scope}:pending`, null);
  forgetEthereumRevealJob(scope, hashA);
  release.resolve();
  await Promise.all([competing, restoring]);
  assert.deepEqual(readEthereumRevealJobs(scope), []);
  assert.equal(window.localStorage.getItem(recordKey(hashA)), null);
});

test('restoration preserves terminal generations and only repairs the currently pending unpack', async () => {
  writeEthereumStorage(`${scope}:pending`, pending());
  await restorePendingEthereumRevealJob(scope, hashA);
  const first = readEthereumRevealJobs(scope)[0];
  assert.ok(first);
  forgetEthereumRevealJob(scope, hashA, first.trackingId);
  await restorePendingEthereumRevealJob(scope, hashA);
  assert.deepEqual(readEthereumRevealJobs(scope), []);
  writeEthereumStorage(`${scope}:pending`, pending(hashB));
  await restorePendingEthereumRevealJob(scope, hashA);
  assert.deepEqual(readEthereumRevealJobs(scope), []);
  await restorePendingEthereumRevealJob(scope, hashB);
  assert.deepEqual(readEthereumRevealJobs(scope).map(job => job.transactionHash), [hashB]);
});

test('legacy close markers survive reload and block automatic restoration without a legacy array', async () => {
  forgetEthereumRevealJob(scope, hashA, 'legacy');
  const key = `ethereum111k:${scope}:reveal-closed:v2:${hashA}:legacy`;
  const closed = window.localStorage.getItem(key)!;
  environment.dom.window.close();
  environment = setupFrontendDom();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_name: string, _options: unknown, run: () => unknown) => run() } });
  window.localStorage.setItem(key, closed);
  writeEthereumStorage(`${scope}:pending`, pending());
  await restorePendingEthereumRevealJob(scope, hashA);
  assert.deepEqual(readEthereumRevealJobs(scope), []);
  window.localStorage.setItem(legacyKey, JSON.stringify([{ transactionHash: hashA, submittedAt: 1 }]));
  assert.deepEqual(readEthereumRevealJobs(scope), []);
});

for (const failure of ['blocked', 'full', 'silent'] as const) test(`${failure} storage preserves per-hash fallback jobs and closure`, () => {
  const storage = window.localStorage;
  if (failure === 'blocked') Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('Blocked'); } });
  else Object.defineProperty(window, 'localStorage', { configurable: true, value: {
    getItem: storage.getItem.bind(storage), setItem() { if (failure === 'full') throw new Error('Quota exceeded'); }, removeItem() {},
  } });
  rememberEthereumRevealJob(scope, hashA, 1);
  rememberEthereumRevealJob(scope, hashB, 2);
  const first = readEthereumRevealJobs(scope)[0];
  assert.deepEqual(readEthereumRevealJobs(scope).map(job => job.transactionHash), [hashA, hashB]);
  forgetEthereumRevealJob(scope, hashA, first.trackingId);
  assert.deepEqual(readEthereumRevealJobs(scope).map(job => job.transactionHash), [hashB]);
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
  assert.deepEqual(readEthereumRevealJobs(scope).map(job => job.transactionHash), [hashB]);
  const replacement = { transactionHash: hashB, submittedAt: 3, trackingId: crypto.randomUUID() };
  storage.setItem(recordKey(hashB), JSON.stringify(replacement));
  assert.deepEqual(readEthereumRevealJobs(scope), [replacement]);
});

test('per-hash subscriptions include same-tab writes, matching storage events, legacy changes and storage clear', () => {
  let changes = 0;
  const unsubscribe = subscribeEthereumRevealJobs(scope, () => changes++);
  rememberEthereumRevealJob(scope, hashA, 1);
  assert.equal(changes, 1);
  const job = readEthereumRevealJobs(scope)[0];
  for (const key of [recordKey(hashA), `ethereum111k:${scope}:reveal-closed:v2:${hashA}:${job.trackingId}`, legacyKey, null]) {
    window.dispatchEvent(new window.StorageEvent('storage', { key, storageArea: window.localStorage }));
  }
  assert.equal(changes, 5);
  const otherScope = `31337:${contract}:${owner}`;
  rememberEthereumRevealJob(otherScope, hashA, 2);
  window.dispatchEvent(new window.StorageEvent('storage', { key: recordKey(hashA, otherScope), storageArea: window.localStorage }));
  window.dispatchEvent(new window.StorageEvent('storage', { key: recordKey(hashA), storageArea: window.sessionStorage }));
  assert.equal(changes, 5);
  forgetEthereumRevealJob(otherScope, hashA);
  assert.deepEqual(readEthereumRevealJobs(scope), [job]);
  unsubscribe();
  forgetEthereumRevealJob(scope, hashA);
  assert.equal(changes, 5);
});
