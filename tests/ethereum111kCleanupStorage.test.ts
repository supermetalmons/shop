import assert from 'node:assert/strict';
import test from 'node:test';
import { deleteCleanupPrefix, inventoryCleanupPrefix, validateCleanupObject,
  type CleanupObject, type CleanupStorage, type MetadataCleanupPolicy } from '../scripts/shared/ethereum111kCleanupStorage.ts';

const ROOT = '111k-sepolia/';
const CURRENT = `${ROOT}current/`;
const ETAG = `"${'a'.repeat(32)}"`;
const FILES = new Set(['1.json', '2.json', '10.json', '11.json', '100.json', '101.json']);
const POLICY: MetadataCleanupPolicy = {
  deletePrefixes: [ROOT],
  hasPrefix: prefix => prefix === ROOT || prefix === CURRENT,
  mayDeletePrefix: prefix => prefix === ROOT,
  files: () => FILES,
  requiresCompleteCoverage: prefix => prefix === CURRENT,
  allowsNestedPrefix: (prefix, nested) => prefix === ROOT && nested === CURRENT,
  mayReadKey: key => key.startsWith(CURRENT) && FILES.has(key.slice(CURRENT.length)),
};
const item = (key: string): CleanupObject => ({ key, bytes: 1, etag: ETAG });

function fixture() {
  const f = paginatedDeletionFixture();
  const list = f.storage.list;
  const storage: CleanupStorage = { ...f.storage,
    list: async (prefix, cursor, startAfter) => prefix === CURRENT
      ? { objects: [...FILES].sort().map(file => item(`${CURRENT}${file}`)), prefixes: [] }
      : list(prefix, cursor, startAfter),
  };
  return { deps: { storage } };
}

test('cleanup scope never accepts nested, current, mainnet, traversal or unknown token objects', () => {
  validateCleanupObject(POLICY, ROOT, item(`${ROOT}1.json`));
  for (const key of [`${CURRENT}1.json`, '111k/1.json', `${ROOT}../1.json`, `${ROOT}0.json`, `${ROOT}01.json`, `${ROOT}99999999.json`]) {
    assert.throws(() => validateCleanupObject(POLICY, ROOT, item(key)));
  }
});

test('inventory checks full current token coverage, unknown namespaces and pagination progress', async () => {
  const f = fixture();
  const inventory = await inventoryCleanupPrefix(POLICY, f.deps.storage, CURRENT);
  assert.equal(inventory.objectCount, FILES.size);
  await assert.rejects(inventoryCleanupPrefix(POLICY, { ...f.deps.storage,
    list: async () => ({ objects: [item(`${CURRENT}1.json`)], prefixes: [] }) }, CURRENT), /coverage/);
  await assert.rejects(inventoryCleanupPrefix(POLICY, { ...f.deps.storage,
    list: async () => ({ objects: [], prefixes: [`${ROOT}v17/`] }) }, ROOT), /Unexpected nested/);
  await assert.rejects(inventoryCleanupPrefix(POLICY, { ...f.deps.storage,
    list: async () => ({ objects: [], prefixes: [], cursor: 'repeated' }) }, ROOT), /Repeated/);
  let page = 0;
  await assert.rejects(inventoryCleanupPrefix(POLICY, { ...f.deps.storage,
    list: async () => ({ objects: [item(`${ROOT}1.json`)], prefixes: [], cursor: page++ === 0 ? 'next' : undefined }) }, ROOT), /Duplicate/);
});

test('deletion refuses current prefixes, larger-than-planned inventories and unacknowledged deletes', async () => {
  const f = fixture();
  await assert.rejects(deleteCleanupPrefix(POLICY, f.deps.storage, CURRENT, FILES.size), /Unapproved/);
  await assert.rejects(deleteCleanupPrefix(POLICY, f.deps.storage, ROOT, 1), /inventory changed/);
  const storage: CleanupStorage = { ...f.deps.storage, delete: async () => ({ deleted: [], errors: [] }) };
  await assert.rejects(deleteCleanupPrefix(POLICY, storage, ROOT, 5), /incomplete/);
});

function paginatedDeletionFixture(ids = [1, 10, 100, 101, 11]) {
  const objects = new Map(ids.map(id => [`${ROOT}${id}.json`, item(`${ROOT}${id}.json`)]));
  const listings: Array<{ cursor?: string; startAfter?: string }> = [];
  const deletions: string[][] = [];
  const storage: CleanupStorage = {
    async list(prefix, cursor, startAfter) {
      assert.equal(prefix, ROOT);
      listings.push({ cursor, startAfter });
      const available = [...objects.keys()].sort().filter(key => startAfter === undefined || key > startAfter);
      return { objects: available.slice(0, 2).map(key => objects.get(key)!), prefixes: [CURRENT],
        cursor: available.length > 2 ? 'more-results' : undefined };
    },
    async delete(keys) {
      deletions.push(keys);
      keys.forEach(key => objects.delete(key));
      return { deleted: keys, errors: [] };
    },
    async get() { throw new Error('Unexpected metadata read'); }, close() {},
  };
  return { storage, objects, listings, deletions };
}

test('deletion advances lexicographically only after acknowledged pages and proves emptiness from prefix start', async () => {
  const f = paginatedDeletionFixture();
  assert.equal(await deleteCleanupPrefix(POLICY, f.storage, ROOT, 5), 5);
  assert.deepEqual(f.listings, [
    { cursor: undefined, startAfter: undefined },
    { cursor: undefined, startAfter: `${ROOT}10.json` },
    { cursor: undefined, startAfter: `${ROOT}101.json` },
    { cursor: undefined, startAfter: undefined },
  ]);
  assert.deepEqual(f.deletions, [
    [`${ROOT}1.json`, `${ROOT}10.json`], [`${ROOT}100.json`, `${ROOT}101.json`], [`${ROOT}11.json`],
  ]);
  assert.equal(f.objects.size, 0);
});

test('prefix-start verification detects an earlier key omitted from a deletion page', async () => {
  const f = paginatedDeletionFixture([1, 10, 100]);
  const list = f.storage.list;
  let first = true;
  f.storage.list = async (...args) => {
    if (!first) return list(...args);
    first = false;
    f.listings.push({ cursor: args[1], startAfter: args[2] });
    return { objects: [item(`${ROOT}10.json`), item(`${ROOT}100.json`)], prefixes: [CURRENT] };
  };
  await assert.rejects(deleteCleanupPrefix(POLICY, f.storage, ROOT, 3), /Retired metadata remains/);
  assert.deepEqual([...f.objects.keys()], [`${ROOT}1.json`]);
  assert.equal(f.listings.at(-1)?.startAfter, undefined);
  assert.equal(await deleteCleanupPrefix(POLICY, f.storage, ROOT, 1), 1);
  assert.equal(f.objects.size, 0);
});

test('a partial later-page failure stops pagination and retry starts from remaining keys', async () => {
  const f = paginatedDeletionFixture();
  const remove = f.storage.delete;
  let fail = true;
  f.storage.delete = async keys => {
    if (f.deletions.length === 1 && fail) {
      fail = false;
      f.deletions.push(keys);
      f.objects.delete(keys[0]);
      return { deleted: [keys[0]], errors: [{ key: keys[1], code: 'InternalError' }] };
    }
    return remove(keys);
  };
  await assert.rejects(deleteCleanupPrefix(POLICY, f.storage, ROOT, 5), /incomplete/);
  assert.deepEqual(f.listings.map(value => value.startAfter), [undefined, `${ROOT}10.json`]);
  assert.deepEqual([...f.objects.keys()], [`${ROOT}101.json`, `${ROOT}11.json`]);
  assert.equal(await deleteCleanupPrefix(POLICY, f.storage, ROOT, 2), 2);
  assert.equal(f.listings[2].startAfter, undefined);
  assert.equal(f.objects.size, 0);
});

for (const invalid of ['unordered', 'duplicate', 'unknown-key', 'unknown-namespace'] as const) {
  test(`deletion rejects ${invalid} pages before mutating R2`, async () => {
    const f = paginatedDeletionFixture();
    f.storage.list = async () => ({
      objects: invalid === 'unordered' ? [item(`${ROOT}2.json`), item(`${ROOT}1.json`)]
        : invalid === 'duplicate' ? [item(`${ROOT}1.json`), item(`${ROOT}1.json`)]
          : invalid === 'unknown-key' ? [item(`${CURRENT}1.json`)] : [],
      prefixes: invalid === 'unknown-namespace' ? [`${ROOT}v17/`] : [],
    });
    await assert.rejects(deleteCleanupPrefix(POLICY, f.storage, ROOT, 5), /Unexpected|Duplicate/);
    assert.equal(f.deletions.length, 0);
  });
}

test('deletion rejects repeated keys at or before the last acknowledged key', async () => {
  const f = paginatedDeletionFixture();
  const list = f.storage.list;
  f.storage.list = async (prefix, cursor, startAfter) => startAfter === undefined ? list(prefix, cursor, startAfter)
    : { objects: [item(startAfter)], prefixes: [], cursor: 'more-results' };
  await assert.rejects(deleteCleanupPrefix(POLICY, f.storage, ROOT, 5), /non-advancing/);
  assert.equal(f.deletions.length, 1);
});
