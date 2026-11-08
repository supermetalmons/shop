import assert from 'node:assert/strict';
import test from 'node:test';
import { metadataIdentities, sha256 } from '../scripts/ethereum-metadata/catalog.ts';
import { CLEANUP_CURRENT, CLEANUP_TARGETS, deleteCleanupPrefix, executeCleanupEthereum111k, inventoryCleanupPrefix,
  parseCleanupEthereum111kArgs, validateCleanupManifest, validateCleanupObject, validateCleanupReceipt,
  type CleanupDependencies, type CleanupManifest, type CleanupObject, type CleanupSnapshot,
  type CleanupStorage } from '../scripts/ops/cleanupEthereum111k.ts';
import { withEthereumRevealMaintenance } from '../scripts/shared/ethereumRevealMaintenance.ts';
import type { EthereumRevealPurgeResult } from '../shared/ethereum/revealMaintenance.ts';
import { acquireMetadataPublicationLease, acquireRetired111kPreviewCleanupLease, assertMetadataPublicationAllowed } from '../scripts/ethereum-metadata/publicationLease.ts';
import { restoreMetadata, uploadMetadata } from '../scripts/ethereum-metadata/remote.ts';

const ROOT = '111k-sepolia/';
const CURRENT = `${ROOT}v16/`;
const PREVIEW = `${ROOT}reliquaries-v1/`;
const ETAG = `"${'a'.repeat(32)}"`;
const FILES = [...metadataIdentities()].map(identity => identity.file).sort();
const PREFIXES = [...CLEANUP_TARGETS.map(target => target.metadataBaseUri.replace('https://cdn.mons.shop/', '')), PREVIEW, CURRENT];
const snapshot = (): CleanupSnapshot => ({ currentRevision: 3, commerceRevision: 46,
  targets: CLEANUP_TARGETS.map(target => ({ ...target, revision: 4 })) });
const item = (key: string): CleanupObject => ({ key, bytes: 1, etag: ETAG });
const receipt = (target: CleanupSnapshot['targets'][number]): EthereumRevealPurgeResult => ({ deploymentId: target.deploymentId,
  chainId: target.chainId, contractAddress: target.contractAddress, metadataBaseUri: target.metadataBaseUri, revision: target.revision,
  purged: true, storageEmpty: true, alarmCleared: true });

function fixture() {
  const objects = new Map<string, CleanupObject>(PREFIXES.filter(prefix => prefix !== CURRENT).flatMap(prefix =>
    (prefix === PREVIEW ? [117172, 117201] : [1, 2]).map(id => [`${prefix}${id}.json`, item(`${prefix}${id}.json`)] as const)));
  let saved: CleanupManifest | undefined;
  const purges: string[] = [];
  const inspections: string[] = [];
  const deleteCalls: string[][] = [];
  const leases: string[] = [];
  let changedSnapshot: CleanupSnapshot | undefined;
  let failedPurge: string | undefined;
  let partialDelete = false;
  let artworkChanged = false;
  const storage: CleanupStorage = {
    async list(prefix, cursor, startAfter) {
      const start = cursor === undefined ? 0 : Number(cursor);
      const files = prefix === CURRENT ? FILES : [...objects.keys()].filter(key => key.startsWith(prefix)
        && !key.slice(prefix.length).includes('/')).sort().map(key => key.slice(prefix.length));
      const all = startAfter === undefined ? files : files.filter(file => `${prefix}${file}` > startAfter);
      const end = Math.min(start + 1000, all.length);
      return { objects: all.slice(start, end).map(file => item(`${prefix}${file}`)),
        prefixes: prefix === ROOT ? PREFIXES.filter(value => value !== ROOT) : [], cursor: end < all.length ? String(end) : undefined };
    },
    async get(key) { return Buffer.from(artworkChanged ? `changed:${key}` : key); },
    async delete(keys) {
      assert.equal(purges.length, 10, 'all reveal stores must be purged before any R2 mutation');
      assert(keys.every(key => !key.startsWith(CURRENT)));
      deleteCalls.push(keys);
      if (partialDelete) {
        partialDelete = false;
        objects.delete(keys[0]);
        return { deleted: [keys[0]], errors: keys.slice(1).map(key => ({ key, code: 'InternalError' })) };
      }
      keys.forEach(key => objects.delete(key));
      return { deleted: keys, errors: [] };
    }, close() {},
  };
  const deps: CleanupDependencies = {
    snapshot: async () => changedSnapshot ?? snapshot(), storage,
    maintenance: async work => work({
      async purgeRetired(request) {
        if (request.deploymentId === failedPurge) throw new Error('purge failed');
        purges.push(request.deploymentId);
        return receipt(snapshot().targets.find(target => target.deploymentId === request.deploymentId)!);
      },
      async inspectRetired(request) {
        inspections.push(request.deploymentId);
        return receipt(snapshot().targets.find(target => target.deploymentId === request.deploymentId)!);
      },
    }),
    async previewLease(write, absent) { leases.push(absent ? 'verify-absent' : write ? 'delete' : 'check'); },
    async previewMutation(work) { leases.push('exclusive'); return work({ assertWritable() {}, signal: new AbortController().signal }); },
    async load() { return structuredClone(saved); },
    async save(_path, value, create) { if (create && saved) throw new Error('exists'); saved = structuredClone(value); },
    now: () => '2026-11-08T12:00:00.000Z', progress() {},
  };
  const run = (command: 'plan' | 'apply' | 'verify', write = false) => executeCleanupEthereum111k({ command, write, manifest: '/tmp/cleanup.json' }, deps);
  return { deps, objects, purges, inspections, deleteCalls, leases, run, manifest: () => saved!,
    changeSnapshot: (value: CleanupSnapshot) => { changedSnapshot = value; },
    failPurge: (id: string | undefined) => { failedPurge = id; },
    partialDelete: () => { partialDelete = true; }, changeArtwork: () => { artworkChanged = true; } };
}

test('CLI requires an explicit manifest and limits --write to apply', () => {
  assert.equal(parseCleanupEthereum111kArgs(['plan', '--manifest', 'cleanup.json']).command, 'plan');
  assert.equal(parseCleanupEthereum111kArgs(['apply', '--manifest', 'cleanup.json']).write, false);
  assert.equal(parseCleanupEthereum111kArgs(['apply', '--manifest', 'cleanup.json', '--write']).write, true);
  for (const args of [[], ['apply', '--write'], ['verify', '--manifest', 'x', '--write'],
    ['plan', '--manifest', 'x', '--manifest', 'y'], ['apply', '--manifest', 'x', '--unknown']]) {
    assert.throws(() => parseCleanupEthereum111kArgs(args));
  }
});

test('legacy root scope never accepts nested, current, mainnet, traversal or unknown token objects', () => {
  validateCleanupObject(ROOT, item(`${ROOT}1.json`));
  for (const key of [`${CURRENT}1.json`, '111k/1.json', `${ROOT}../1.json`, `${ROOT}0.json`, `${ROOT}01.json`, `${ROOT}99999999.json`]) {
    assert.throws(() => validateCleanupObject(ROOT, item(key)));
  }
});

test('historical prefix coverage respects root, thirty-reliquary v7/preview, and eighteen-relic v8 boundaries', async () => {
  for (const id of [117172, 117189, 117190, 117201]) {
    validateCleanupObject(PREVIEW, item(`${PREVIEW}${id}.json`));
    validateCleanupObject(`${ROOT}v7/`, item(`${ROOT}v7/${id}.json`));
    assert.throws(() => validateCleanupObject(ROOT, item(`${ROOT}${id}.json`)));
  }
  for (const id of [1, 117171, 117202, 3000001]) assert.throws(() => validateCleanupObject(PREVIEW, item(`${PREVIEW}${id}.json`)));
  for (const prefix of [`${ROOT}v8/`, `${ROOT}v9/`, CURRENT]) {
    validateCleanupObject(prefix, item(`${prefix}117189.json`));
    assert.throws(() => validateCleanupObject(prefix, item(`${prefix}117190.json`)));
    assert.throws(() => validateCleanupObject(prefix, item(`${prefix}117201.json`)));
  }
  for (const prefix of [ROOT, `${ROOT}v7/`, `${ROOT}v8/`]) {
    assert.throws(() => validateCleanupObject(prefix, item(`${prefix}3000001.json`)));
  }
  validateCleanupObject(`${ROOT}v9/`, item(`${ROOT}v9/3000018.json`));
  const f = fixture();
  for (let id = 117172; id <= 117201; id++) f.objects.set(`${PREVIEW}${id}.json`, item(`${PREVIEW}${id}.json`));
  assert.equal((await inventoryCleanupPrefix(f.deps.storage, PREVIEW)).objectCount, 30);
  f.purges.push(...CLEANUP_TARGETS.map(target => target.deploymentId));
  assert.equal(await deleteCleanupPrefix(f.deps.storage, PREVIEW, 30), 30);
});

test('generic upload, restore and lease acquisition permanently refuse the retired Sepolia preview', async () => {
  const uri = `https://cdn.mons.shop/${PREVIEW}`;
  await assert.rejects(uploadMetadata('/unused', 'sepolia', { prefix: PREVIEW }), /retired/);
  await assert.rejects(restoreMetadata('/unused', 'sepolia', { prefix: PREVIEW }), /retired/);
  let queries = 0;
  await assert.rejects(acquireMetadataPublicationLease(uri, { query: () => { queries++; return []; } }), /retired/);
  assert.equal(queries, 0);
  assertMetadataPublicationAllowed('https://cdn.mons.shop/111k/reliquaries-v1/');
  assertMetadataPublicationAllowed(CLEANUP_CURRENT.metadataBaseUri);
  const statements: string[] = [];
  const lease = await acquireRetired111kPreviewCleanupLease({ leaseId: 'preview-cleanup-test', query: sql => {
    statements.push(sql);
    return [{ lease_id: 'preview-cleanup-test' }];
  } });
  lease.assertWritable();
  await lease.close();
  assert(statements.every(sql => sql.includes(uri)));
  assert(statements.every(sql => !sql.includes('https://cdn.mons.shop/111k/reliquaries-v1/')));
});

test('inventory checks full current token coverage, unknown namespaces and pagination progress', async () => {
  const f = fixture();
  const inventory = await inventoryCleanupPrefix(f.deps.storage, CURRENT);
  assert.equal(inventory.objectCount, 344984);
  await assert.rejects(inventoryCleanupPrefix({ ...f.deps.storage,
    list: async () => ({ objects: [item(`${CURRENT}1.json`)], prefixes: [] }) }, CURRENT), /coverage/);
  await assert.rejects(inventoryCleanupPrefix({ ...f.deps.storage,
    list: async () => ({ objects: [], prefixes: [`${ROOT}v17/`] }) }, ROOT), /Unexpected nested/);
  await assert.rejects(inventoryCleanupPrefix({ ...f.deps.storage,
    list: async () => ({ objects: [], prefixes: [], cursor: 'repeated' }) }, ROOT), /Repeated/);
  let page = 0;
  await assert.rejects(inventoryCleanupPrefix({ ...f.deps.storage,
    list: async () => ({ objects: [item(`${ROOT}1.json`)], prefixes: [], cursor: page++ === 0 ? 'next' : undefined }) }, ROOT), /Duplicate/);
});

test('plan is read-only and apply dry-run leaves all remote state untouched', async () => {
  const f = fixture();
  const result = await f.run('plan');
  assert.equal(result.deleteObjects, 22);
  assert.equal(result.currentObjects, 344984);
  assert.equal(f.manifest().currentArtworkSha256['1.json'], sha256(`${CURRENT}1.json`));
  assert.equal(f.purges.length, 0);
  assert.equal(f.deleteCalls.length, 0);
  assert.equal((await f.run('apply')).dryRun, true);
  assert.equal(f.purges.length, 0);
  assert.equal(f.objects.size, 22);
  assert.equal(f.leases.includes('delete'), false);
});

test('apply preserves current data, purges all ledgers first, and verifies restart-safe emptiness', async () => {
  const f = fixture();
  await f.run('plan');
  assert.equal((await f.run('apply', true)).completed, true);
  assert.equal(f.objects.size, 0);
  assert.equal(f.purges.length, 10);
  assert.equal(f.manifest().completedPrefixes.length, 11);
  assert(f.leases.includes('exclusive'));
  assert(f.leases.includes('delete'));
  assert.equal((await f.run('verify')).verified, true);
  assert.equal(f.inspections.length, 10);
  assert(f.leases.includes('verify-absent'));
});

test('any purge failure blocks every R2 delete and resume inspects completed purges', async () => {
  const f = fixture();
  await f.run('plan');
  f.failPurge('v10');
  await assert.rejects(f.run('apply', true), /purge failed/);
  assert.equal(f.deleteCalls.length, 0);
  assert.equal(f.purges.length, 4);
  f.failPurge(undefined);
  await f.run('apply', true);
  assert.equal(f.purges.length, 10);
  assert.equal(f.inspections.length, 4);
  assert.equal(f.objects.size, 0);
});

test('partial per-object deletion errors are resumable without resetting current state', async () => {
  const f = fixture();
  await f.run('plan');
  f.partialDelete();
  await assert.rejects(f.run('apply', true), /deletion was incomplete/);
  assert(f.objects.size > 0 && f.objects.size < 22);
  await f.run('apply', true);
  assert.equal(f.objects.size, 0);
  assert.equal(f.purges.length, 10);
  assert.equal((await f.run('verify')).verified, true);
});

test('revision drift and changed immutable current artwork abort before purging or deleting', async () => {
  const f = fixture();
  await f.run('plan');
  f.changeSnapshot({ ...snapshot(), commerceRevision: 47 });
  await assert.rejects(f.run('apply', true), /revisions changed/);
  f.changeSnapshot(snapshot());
  f.changeArtwork();
  await assert.rejects(f.run('apply', true), /immutable artwork/);
  assert.equal(f.purges.length, 0);
  assert.equal(f.deleteCalls.length, 0);
});

test('changed initial obsolete inventory and unexpected new deployments fail closed', async () => {
  const f = fixture();
  await f.run('plan');
  f.objects.set(`${ROOT}3.json`, item(`${ROOT}3.json`));
  await assert.rejects(f.run('apply', true), /inventory changed/);
  const altered = structuredClone(f.manifest());
  altered.snapshot.targets[0] = { ...altered.snapshot.targets[0], contractAddress: CLEANUP_CURRENT.contractAddress };
  assert.throws(() => validateCleanupManifest(altered), /allowlist/);
  altered.snapshot = snapshot();
  altered.completedPrefixes = [CURRENT];
  assert.throws(() => validateCleanupManifest(altered), /Invalid cleanup manifest/);
  assert.equal(f.deleteCalls.length, 0);
});

test('purge receipts must prove exact identity, revision, cleared alarm and empty storage', () => {
  const target = snapshot().targets[0];
  validateCleanupReceipt(target, receipt(target), true);
  for (const change of [{ revision: 5 }, { contractAddress: CLEANUP_CURRENT.contractAddress }, { storageEmpty: false }, { alarmCleared: false }, { purged: false }]) {
    assert.throws(() => validateCleanupReceipt(target, { ...receipt(target), ...change } as EthereumRevealPurgeResult, true), /not confirmed/);
  }
});

test('deletion refuses current prefixes, larger-than-planned inventories and unacknowledged deletes', async () => {
  const f = fixture();
  await assert.rejects(deleteCleanupPrefix(f.deps.storage, CURRENT, 344984), /Unapproved/);
  await assert.rejects(deleteCleanupPrefix(f.deps.storage, ROOT, 1), /inventory changed/);
  const storage: CleanupStorage = { ...f.deps.storage, delete: async () => ({ deleted: [], errors: [] }) };
  await assert.rejects(deleteCleanupPrefix(storage, ROOT, 2), /incomplete/);
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
  assert.equal(await deleteCleanupPrefix(f.storage, ROOT, 5), 5);
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
  await assert.rejects(deleteCleanupPrefix(f.storage, ROOT, 3), /Retired metadata remains/);
  assert.deepEqual([...f.objects.keys()], [`${ROOT}1.json`]);
  assert.equal(f.listings.at(-1)?.startAfter, undefined);
  assert.equal(await deleteCleanupPrefix(f.storage, ROOT, 1), 1);
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
  await assert.rejects(deleteCleanupPrefix(f.storage, ROOT, 5), /incomplete/);
  assert.deepEqual(f.listings.map(value => value.startAfter), [undefined, `${ROOT}10.json`]);
  assert.deepEqual([...f.objects.keys()], [`${ROOT}101.json`, `${ROOT}11.json`]);
  assert.equal(await deleteCleanupPrefix(f.storage, ROOT, 2), 2);
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
    await assert.rejects(deleteCleanupPrefix(f.storage, ROOT, 5), /Unexpected|Duplicate/);
    assert.equal(f.deletions.length, 0);
  });
}

test('deletion rejects repeated keys at or before the last acknowledged key', async () => {
  const f = paginatedDeletionFixture();
  const list = f.storage.list;
  f.storage.list = async (prefix, cursor, startAfter) => startAfter === undefined ? list(prefix, cursor, startAfter)
    : { objects: [item(startAfter)], prefixes: [], cursor: 'more-results' };
  await assert.rejects(deleteCleanupPrefix(f.storage, ROOT, 5), /non-advancing/);
  assert.equal(f.deletions.length, 1);
});

test('private maintenance transport uses named binding and always disposes', async () => {
  let disposed = false;
  await assert.rejects(withEthereumRevealMaintenance(async transport => {
    await transport.purgeRetired({ deploymentId: 'v15', expectedRevision: 4 });
  }, async options => {
    assert.equal(options.persist, false);
    assert.equal(options.remoteBindings, true);
    assert(options.configPath?.endsWith('ethereum-reveal-maintenance.wrangler.jsonc'));
    return { env: { REVEAL_MAINTENANCE: { async purgeRetired() { throw new Error('rejected'); },
      async inspectRetired() { throw new Error('unused'); } } }, async dispose() { disposed = true; } };
  }), /rejected/);
  assert.equal(disposed, true);
});

test('maintenance transport normalizes non-enumerable RPC property proxies before journaling', async () => {
  const expected = receipt(snapshot().targets[0]);
  const proxied = new Proxy(expected, { ownKeys: () => [] });
  assert.deepEqual(Object.keys(proxied), []);
  await withEthereumRevealMaintenance(async transport => {
    const request = { deploymentId: expected.deploymentId, expectedRevision: expected.revision };
    assert.deepEqual(JSON.parse(JSON.stringify(await transport.purgeRetired(request))), expected);
    const { purged: _, ...inspection } = expected;
    assert.deepEqual(JSON.parse(JSON.stringify(await transport.inspectRetired(request))), inspection);
  }, async () => ({ env: { REVEAL_MAINTENANCE: {
    purgeRetired: async () => proxied, inspectRetired: async () => proxied,
  } }, dispose: async () => {} }));
});
