import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import {
  clearEthereumInventoryRecovery,
  readEthereumExpected,
  readEthereumInventoryExpected,
  replaceEthereumInventoryRecovery,
  restoreEthereumExpected,
  writeEthereumExpected,
} from '../src/ethereum/state.ts';

const scope = '11155111:0x3333333333333333333333333333333333333333:0x1111111111111111111111111111111111111111';
const key = `mons.ethereum111k:${scope}:expected`;
const hash = `0x${'ab'.repeat(32)}`;
const replacementHash = `0x${'cd'.repeat(32)}`;
const sourceIds = Array.from({ length: 50 }, (_, index) => String(index + 1));
const untouchedIds = Array.from({ length: 50 }, (_, index) => String(index + 51));
const mintedIds = Array.from({ length: 50 }, (_, index) => String(index + 1_000_001));
const liveIds = [...untouchedIds, ...mintedIds];
const recovery = { hash, sourceIds, mintedIds };
let frontend: ReturnType<typeof setupFrontendDom>;

beforeEach(() => { frontend = setupFrontendDom(); });
afterEach(() => frontend.dom.window.close());

test('legacy expected-ID arrays remain readable and bounded without recovery metadata', () => {
  const ids = Array.from({ length: 102 }, (_, index) => String(index + 1));
  window.localStorage.setItem(key, JSON.stringify(['0', '01', '0x1', null, 4, ...ids, '102']));
  assert.deepEqual(readEthereumExpected(scope), ids.slice(-100));
  assert.deepEqual(readEthereumInventoryExpected(scope), ids.slice(-100));
  const persisted = window.localStorage.getItem(key);
  restoreEthereumExpected(scope, hash);
  assert.equal(window.localStorage.getItem(key), persisted);
});

test('one atomic storage write preserves one hundred live IDs and fifty recovery sources across reload', t => {
  const writes = t.mock.method(frontend.dom.window.Storage.prototype, 'setItem');
  writeEthereumExpected(scope, liveIds, recovery);
  assert.equal(writes.mock.callCount(), 1);
  const persisted = window.localStorage.getItem(key)!;
  assert.deepEqual(JSON.parse(persisted), { ids: liveIds, recovery });
  assert.deepEqual(readEthereumExpected(scope), liveIds);
  assert.deepEqual(readEthereumInventoryExpected(scope), [...liveIds, ...sourceIds]);
  frontend.dom.window.close();
  frontend = setupFrontendDom();
  window.localStorage.setItem(key, persisted);
  assert.deepEqual(readEthereumExpected(scope), liveIds);
  assert.deepEqual(readEthereumInventoryExpected(scope), [...liveIds, ...sourceIds]);
  restoreEthereumExpected(scope, hash);
  assert.deepEqual(new Set(readEthereumExpected(scope)), new Set([...untouchedIds, ...sourceIds]));
  assert.deepEqual(readEthereumInventoryExpected(scope), readEthereumExpected(scope));
  assert.ok(Array.isArray(JSON.parse(window.localStorage.getItem(key)!)));
});

test('an unrelated transaction hash cannot restore or clear another transaction’s inventory', () => {
  writeEthereumExpected(scope, liveIds, recovery);
  const persisted = window.localStorage.getItem(key);
  restoreEthereumExpected(scope, replacementHash);
  clearEthereumInventoryRecovery(scope, replacementHash);
  assert.equal(window.localStorage.getItem(key), persisted);
  assert.deepEqual(readEthereumExpected(scope), liveIds);
  assert.deepEqual(readEthereumInventoryExpected(scope), [...liveIds, ...sourceIds]);
});

test('a verified replacement migrates recovery ownership and only its hash can restore source IDs', () => {
  writeEthereumExpected(scope, liveIds, recovery);
  const persisted = window.localStorage.getItem(key);
  replaceEthereumInventoryRecovery(scope, replacementHash, hash);
  assert.equal(window.localStorage.getItem(key), persisted);
  replaceEthereumInventoryRecovery(scope, hash, replacementHash);
  assert.deepEqual(JSON.parse(window.localStorage.getItem(key)!), { ids: liveIds, recovery: { ...recovery, hash: replacementHash } });
  restoreEthereumExpected(scope, hash);
  assert.deepEqual(readEthereumExpected(scope), liveIds);
  restoreEthereumExpected(scope, replacementHash);
  assert.deepEqual(new Set(readEthereumExpected(scope)), new Set([...untouchedIds, ...sourceIds]));
  assert.deepEqual(readEthereumInventoryExpected(scope), readEthereumExpected(scope));
});

test('adding an expected claim-link ID preserves pending inventory recovery', () => {
  writeEthereumExpected(scope, liveIds, recovery);
  const claimLinkId = '2000001';
  writeEthereumExpected(scope, [...readEthereumExpected(scope), claimLinkId]);
  const expected = [...liveIds.slice(1), claimLinkId];
  assert.deepEqual(readEthereumExpected(scope), expected);
  assert.deepEqual(JSON.parse(window.localStorage.getItem(key)!).recovery, recovery);
  assert.deepEqual(readEthereumInventoryExpected(scope), [...expected, ...sourceIds]);
  restoreEthereumExpected(scope, hash);
  assert.deepEqual(new Set(readEthereumExpected(scope)), new Set([...untouchedIds.slice(1), claimLinkId, ...sourceIds]));
});

test('successful finalization clears recovery sources while preserving all live expected IDs', () => {
  writeEthereumExpected(scope, liveIds, recovery);
  clearEthereumInventoryRecovery(scope, hash);
  assert.deepEqual(JSON.parse(window.localStorage.getItem(key)!), liveIds);
  assert.deepEqual(readEthereumInventoryExpected(scope), liveIds);
  restoreEthereumExpected(scope, hash);
  assert.deepEqual(readEthereumExpected(scope), liveIds);
});

test('a later transaction preserves older recovery sources and clears only its matching recovery', () => {
  const nextSources = Array.from({ length: 50 }, (_, index) => String(index + 501));
  writeEthereumExpected(scope, liveIds, recovery);
  writeEthereumExpected(scope, liveIds, { hash: replacementHash, sourceIds: nextSources, mintedIds: [] });
  const persisted = window.localStorage.getItem(key)!;
  assert.deepEqual(new Set(readEthereumInventoryExpected(scope)), new Set([...liveIds, ...sourceIds, ...nextSources]));
  assert.equal(readEthereumInventoryExpected(scope).length, 200);
  frontend.dom.window.close();
  frontend = setupFrontendDom();
  window.localStorage.setItem(key, persisted);
  clearEthereumInventoryRecovery(scope, hash);
  assert.equal(window.localStorage.getItem(key), persisted);
  assert.equal(readEthereumInventoryExpected(scope).length, 200);
  clearEthereumInventoryRecovery(scope, replacementHash);
  assert.deepEqual(readEthereumExpected(scope), liveIds);
  assert.deepEqual(readEthereumInventoryExpected(scope), [...liveIds, ...sourceIds]);
  assert.equal(JSON.parse(window.localStorage.getItem(key)!).recovery, undefined);
});

test('re-inclusion preserves earlier recovery IDs evicted by an expanding crate claim', () => {
  const previousIds = Array.from({ length: 30 }, (_, index) => String(index + 500));
  const crateReceiptId = '2005555';
  const artworkReceiptIds = Array.from({ length: 31 }, (_, index) => String(index + 1_111_081));
  writeEthereumExpected(scope, artworkReceiptIds, { hash, sourceIds: [...previousIds, crateReceiptId], mintedIds: artworkReceiptIds });
  writeEthereumExpected(scope, readEthereumExpected(scope), { hash, sourceIds: [crateReceiptId], mintedIds: artworkReceiptIds });
  restoreEthereumExpected(scope, hash);
  assert.deepEqual(new Set(readEthereumExpected(scope)), new Set([...previousIds, crateReceiptId]));
});

test('recovery preserves fifty evicted live IDs and fifty burned sources across reload and re-inclusion', () => {
  const evictedIds = Array.from({ length: 50 }, (_, index) => String(index + 501));
  const allSources = [...evictedIds, ...sourceIds];
  writeEthereumExpected(scope, liveIds, { hash, sourceIds: allSources, mintedIds });
  assert.deepEqual(new Set(readEthereumInventoryExpected(scope)), new Set([...liveIds, ...allSources]));
  assert.equal(readEthereumInventoryExpected(scope).length, 200);
  const persisted = window.localStorage.getItem(key)!;
  frontend.dom.window.close();
  frontend = setupFrontendDom();
  window.localStorage.setItem(key, persisted);
  writeEthereumExpected(scope, readEthereumExpected(scope), { hash, sourceIds, mintedIds });
  assert.deepEqual(JSON.parse(window.localStorage.getItem(key)!).recovery.sourceIds, allSources);
  assert.equal(readEthereumInventoryExpected(scope).length, 200);
  restoreEthereumExpected(scope, hash);
  assert.deepEqual(new Set(readEthereumExpected(scope)), new Set(allSources));
  assert.deepEqual(new Set(readEthereumInventoryExpected(scope)), new Set([...untouchedIds, ...allSources]));
});

test('restoring a full recovery keeps all one hundred fifty originals across reload without minted receipts', () => {
  const evictedIds = Array.from({ length: 50 }, (_, index) => String(index + 501));
  const restoredIds = new Set([...untouchedIds, ...evictedIds, ...sourceIds]);
  writeEthereumExpected(scope, liveIds, { hash, sourceIds: [...evictedIds, ...sourceIds], mintedIds });
  restoreEthereumExpected(scope, hash);
  assert.equal(readEthereumExpected(scope).length, 100);
  assert.equal(readEthereumInventoryExpected(scope).length, 150);
  assert.deepEqual(new Set(readEthereumInventoryExpected(scope)), restoredIds);
  assert.ok(mintedIds.every(id => !readEthereumInventoryExpected(scope).includes(id)));
  const persisted = window.localStorage.getItem(key)!;
  frontend.dom.window.close();
  frontend = setupFrontendDom();
  window.localStorage.setItem(key, persisted);
  assert.deepEqual(new Set(readEthereumInventoryExpected(scope)), restoredIds);
  assert.equal(readEthereumInventoryExpected(scope).length, 150);
  assert.equal(JSON.parse(persisted).recovery, undefined);
});

test('malformed persisted inventory data is ignored or normalized within live and recovery bounds', () => {
  const invalidIds = ['0', '-1', '01', '0x1', '1.5', '', null, {}, 1, '9'.repeat(79)];
  for (const value of ['{', 'null', '4', '"invalid"', JSON.stringify({ ids: {}, recovery: null }),
    JSON.stringify({ ids: invalidIds, recovery: { hash, sourceIds: invalidIds, mintedIds: invalidIds } })]) {
    window.localStorage.setItem(key, value);
    assert.deepEqual(readEthereumExpected(scope), []);
    assert.deepEqual(readEthereumInventoryExpected(scope), []);
    assert.doesNotThrow(() => restoreEthereumExpected(scope, hash));
  }
  window.localStorage.setItem(key, JSON.stringify({ ids: liveIds, recovery: { ...recovery, hash: 'invalid' } }));
  assert.deepEqual(readEthereumInventoryExpected(scope), liveIds);
  const boundedSources = [...Array.from({ length: 50 }, (_, index) => String(index + 501)), ...sourceIds];
  window.localStorage.setItem(key, JSON.stringify({ ids: [...invalidIds, ...liveIds, ...liveIds], recovery: {
    hash, sourceIds: ['999', ...invalidIds, ...boundedSources, ...boundedSources], mintedIds: ['998', ...invalidIds, ...mintedIds, ...mintedIds],
  } }));
  assert.deepEqual(readEthereumExpected(scope), liveIds);
  assert.deepEqual(readEthereumInventoryExpected(scope), [...liveIds, ...boundedSources]);
  assert.equal(readEthereumInventoryExpected(scope).length, 200);
  restoreEthereumExpected(scope, hash);
  assert.deepEqual(new Set(readEthereumExpected(scope)), new Set(boundedSources));
});
