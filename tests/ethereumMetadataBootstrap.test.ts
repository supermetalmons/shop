import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { sha256 } from '../scripts/ethereum-metadata/catalog.ts';
import { acquireMetadataPublicationLease, type MetadataPublicationLease, type MetadataWriteFence } from '../scripts/ethereum-metadata/publicationLease.ts';
import { bootstrapMainnetRootMetadata, bootstrapMainnetRootObjects, snapshotObjects } from '../scripts/ethereum-metadata/remote.ts';
import { metadataMd5, type MetadataStorage } from '../scripts/ethereum-metadata/storage.ts';

async function fixture(t: TestContext, empty = false) {
  const directory = await mkdtemp(join(tmpdir(), '111k-bootstrap-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = new Map(['1.json', '111112.json', '117172.json', '3000001.json'].map(file => [file, Buffer.from(`new ${file}`)]));
  const values = new Map<string, Buffer>(empty ? [] : [
    ['111k/1.json', Buffer.from('original artwork')], ['111k/111112.json', Buffer.from('original crate')],
  ]);
  const preserved = new Map([
    ['111k/collection.json', Buffer.from('{"name":"111k"}')], ['111k/future/1.json', Buffer.from('child namespace')],
    ['111k-sepolia/1.json', Buffer.from('sepolia')], ['unrelated/1.json', Buffer.from('unrelated')],
  ]);
  for (const [key, body] of preserved) values.set(key, body);
  const originals = new Map([...values].filter(([key]) => /^111k\/\d+\.json$/.test(key)));
  const writes: Array<{ key: string; expectedEtag: string | null | undefined }> = [];
  let beforeWrite: ((key: string, body: Buffer) => void) | undefined;
  let afterWrite: ((key: string, body: Buffer) => void) | undefined;
  let lostLease = false;
  let acquired = 0;
  let closed = 0;
  let listed = 0;
  const publicationLease = async (uri: string): Promise<MetadataPublicationLease> => {
    assert.equal(uri, 'https://cdn.mons.shop/111k/');
    acquired++;
    const assertWritable = () => { if (lostLease) throw new Error('lost lease'); };
    return { leaseId: 'fixture', signal: new AbortController().signal, assertWritable,
      async renew() { assertWritable(); },
      async beforePut() { assertWritable(); }, async close() { closed++; },
      async retireForRegistration() { assert.fail('bootstrap cannot register a deployment'); } };
  };
  const storage: MetadataStorage = {
    destination: { endpoint: `https://${sha256(directory).slice(0, 32)}.r2.cloudflarestorage.com`, bucket: 'cdn-mons-shop' },
    async *list(prefix, range = {}) {
      assert.equal(prefix, '111k/');
      listed++;
      for (const key of [...values.keys()].sort()) {
        if (!key.startsWith(prefix) || range.startAfter !== undefined && key <= range.startAfter || range.endAt !== undefined && key > range.endAt) continue;
        const body = values.get(key)!;
        yield { key, bytes: body.length, md5: metadataMd5(body) };
      }
    },
    async get(key) {
      assert.ok(originals.has(key), `only original token files may be snapshotted: ${key}`);
      return Buffer.from(values.get(key)!);
    },
    async put(key, body, expectedEtag, fence: MetadataWriteFence) {
      assert.ok(key.startsWith('111k/') && target.has(key.slice(5)));
      assert.ok(fence);
      fence.assertWritable();
      beforeWrite?.(key, body);
      const existing = values.get(key);
      assert.equal(existing ? `"${metadataMd5(existing)}"` : null, expectedEtag, 'conditional write failed');
      values.set(key, Buffer.from(body));
      writes.push({ key, expectedEtag });
      afterWrite?.(key, body);
    },
    close() { assert.fail('injected storage should remain owned by its caller'); },
  };
  const objects = async function* () {
    for (const [file, body] of target) yield { file, body, bytes: body.length, md5: metadataMd5(body), sha256: sha256(body) };
  };
  const snapshotDirectory = join(directory, 'snapshot');
  const args = { directory, snapshotDirectory, storage, files: new Set(target.keys()), publicationManifestSha256: sha256('manifest'),
    objectsSha256: sha256('objects'), objects, concurrency: 1, publicationLease };
  return { args, values, originals, preserved, target, writes,
    beforeWrite: (callback?: typeof beforeWrite) => { beforeWrite = callback; },
    afterWrite: (callback?: typeof afterWrite) => { afterWrite = callback; },
    loseLease: () => { lostLease = true; }, counts: () => ({ acquired, closed, listed }) };
}

test('bootstrap updates legacy mainnet root files and creates missing relic files under a publication lease', async t => {
  const f = await fixture(t);
  const report = await bootstrapMainnetRootObjects(f.args);
  assert.equal(report.originalObjectCount, 2);
  assert.equal(report.objectCount, 4);
  assert.equal(report.uploaded, 4);
  assert.equal(report.complete, true);
  assert.deepEqual(f.writes.map(row => row.expectedEtag), [
    `"${metadataMd5(f.originals.get('111k/1.json')!)}"`, `"${metadataMd5(f.originals.get('111k/111112.json')!)}"`, null, null,
  ]);
  for (const [file, body] of f.target) assert.deepEqual(f.values.get(`111k/${file}`), body);
  for (const [key, body] of f.preserved) assert.deepEqual(f.values.get(key), body);
  const manifest = JSON.parse(await readFile(join(f.args.snapshotDirectory, 'manifest.json'), 'utf8'));
  const snapshot = new Map<string, Buffer>();
  for await (const row of snapshotObjects(f.args.snapshotDirectory, manifest, new Set(['1.json', '111112.json']))) snapshot.set(`111k/${row.file}`, row.body);
  assert.deepEqual(snapshot, f.originals);
  assert.deepEqual(f.counts(), { acquired: 1, closed: 1, listed: 2 });
});

test('bootstrap resumes an uncertain create without replacing its original snapshot or duplicating writes', async t => {
  const f = await fixture(t);
  f.afterWrite(key => { if (key === '111k/117172.json') throw new Error('lost response'); });
  await assert.rejects(bootstrapMainnetRootObjects(f.args), /lost response/);
  const originals = await readFile(join(f.args.snapshotDirectory, 'bootstrap.json'));
  const snapshot = await readFile(join(f.args.snapshotDirectory, 'objects.jsonl.gz'));
  await appendFile(join(f.args.directory, 'uploads', 'bootstrap-mainnet-root.jsonl'), '{"file":"117172.json"');
  f.afterWrite();
  f.writes.length = 0;
  const report = await bootstrapMainnetRootObjects(f.args);
  assert.equal(report.uploaded, 1);
  assert.equal(report.skipped, 3);
  assert.deepEqual(f.writes.map(row => row.key), ['111k/3000001.json']);
  assert.deepEqual(await readFile(join(f.args.snapshotDirectory, 'bootstrap.json')), originals);
  assert.deepEqual(await readFile(join(f.args.snapshotDirectory, 'objects.jsonl.gz')), snapshot);
  assert.equal((await bootstrapMainnetRootObjects(f.args)).uploaded, 0);
  assert.deepEqual(f.counts(), { acquired: 3, closed: 3, listed: 5 });
});

test('bootstrap refuses foreign changes, deleted originals and unexpected new bytes on retries', async t => {
  for (const change of ['existing', 'missing', 'created']) await t.test(change, async t => {
    const f = await fixture(t);
    f.afterWrite(key => { if (key === '111k/1.json') throw new Error('interrupted'); });
    await assert.rejects(bootstrapMainnetRootObjects(f.args), /interrupted/);
    f.afterWrite();
    f.writes.length = 0;
    if (change === 'existing') f.values.set('111k/1.json', Buffer.from('foreign edit'));
    if (change === 'missing') f.values.delete('111k/111112.json');
    if (change === 'created') f.values.set('111k/117172.json', Buffer.from('foreign creation'));
    await assert.rejects(bootstrapMainnetRootObjects(f.args), /changed outside this bootstrap/);
    assert.equal(f.writes.length, 0);
  });
});

test('bootstrap preserves root scope and fails before mutation for registered prefixes or lost leases', async t => {
  const f = await fixture(t);
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  database.exec(await readFile(new URL('../cloud/workers/api/ops-migrations/0009_ethereum_reveal_deployments.sql', import.meta.url), 'utf8'));
  database.exec(`INSERT INTO ethereum_reveal_deployments VALUES
    ('mainnet', '111k', 1, '0x${'ab'.repeat(20)}', 'https://cdn.mons.shop/111k/', 1, '111k-v8', '{}', 'hash', 'ready', 1, 0, 0, NULL, 0, NULL)`);
  await assert.rejects(bootstrapMainnetRootObjects({ ...f.args,
    publicationLease: uri => acquireMetadataPublicationLease(uri, { query: sql => database.prepare(sql).all() }) }), /prefix is reveal-managed/);
  assert.deepEqual(await readdir(f.args.directory), []);
  assert.equal(f.counts().listed, 0);
  f.loseLease();
  await assert.rejects(bootstrapMainnetRootObjects(f.args), /lost lease/);
  assert.equal(f.writes.length, 0);
  assert.equal(f.counts().closed, 1);
  await assert.rejects(bootstrapMainnetRootMetadata(f.args.directory, { prefix: '111k/elsewhere/' } as never), /cannot select another scope/);
  await assert.rejects(bootstrapMainnetRootMetadata(f.args.directory, { tokenIds: ['1'] } as never), /cannot select another scope/);
});

test('bootstrap conditional writes reject races after inventory without overwriting their bytes', async t => {
  for (const file of ['1.json', '117172.json']) await t.test(file, async t => {
    const f = await fixture(t);
    const foreign = Buffer.from('concurrent write');
    f.beforeWrite(key => { if (key === `111k/${file}`) f.values.set(key, foreign); });
    await assert.rejects(bootstrapMainnetRootObjects(f.args), /conditional write failed/);
    assert.deepEqual(f.values.get(`111k/${file}`), foreign);
    assert.ok(!f.writes.some(row => row.key === `111k/${file}`));
  });
});

test('bootstrap refuses changed source, corrupt snapshot and missing original evidence on resume', async t => {
  const f = await fixture(t);
  await bootstrapMainnetRootObjects(f.args);
  f.writes.length = 0;
  await assert.rejects(bootstrapMainnetRootObjects({ ...f.args, objectsSha256: sha256('different target') }), /different destination or publication/);
  await assert.rejects(bootstrapMainnetRootObjects({ ...f.args, snapshotDirectory: join(f.args.directory, 'another') }), /evidence exists without/);
  const archive = join(f.args.snapshotDirectory, 'objects.jsonl.gz');
  const bytes = await readFile(archive);
  await writeFile(archive, Buffer.from('corrupt'));
  await assert.rejects(bootstrapMainnetRootObjects(f.args), /archive checksum mismatch/);
  await writeFile(archive, bytes);
  await rm(join(f.args.snapshotDirectory, 'bootstrap.json'));
  await assert.rejects(bootstrapMainnetRootObjects(f.args), /evidence exists without/);
  assert.equal(f.writes.length, 0);
});

test('bootstrap supports an empty unregistered root and rejects foreign direct filenames', async t => {
  const f = await fixture(t, true);
  f.values.set('111k/99999999.json', Buffer.from('unrelated direct object'));
  await assert.rejects(bootstrapMainnetRootObjects(f.args), /Unexpected remote metadata key/);
  assert.deepEqual(await readdir(f.args.directory), []);
  f.values.delete('111k/99999999.json');
  const report = await bootstrapMainnetRootObjects(f.args);
  assert.equal(report.originalObjectCount, 0);
  assert.equal(report.uploaded, 4);
  assert.equal((await bootstrapMainnetRootObjects(f.args)).skipped, 4);
});

test('read-phase lease renewal retains ownership without requiring a writer drain', async t => {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  database.exec(await readFile(new URL('../cloud/workers/api/ops-migrations/0009_ethereum_reveal_deployments.sql', import.meta.url), 'utf8'));
  let now = 0;
  let renewals = 0;
  const lease = await acquireMetadataPublicationLease('https://cdn.mons.shop/111k/', { now: () => now, wallNow: () => now,
    query: sql => { if (sql.startsWith('UPDATE')) renewals++; return database.prepare(sql).all(); } });
  for (now = 30_001; now <= 300_010; now += 30_001) await lease.renew();
  assert.equal(renewals, 10);
  await lease.close();
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ethereum_metadata_publication_leases').get()!.count, 0);
});

test('bootstrap heartbeat renews during snapshot reads and stops after renewal loss', async t => {
  const f = await fixture(t);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const get = f.args.storage.get.bind(f.args.storage);
  f.args.storage.get = async key => { started.resolve(); await release.promise; return get(key); };
  let renewals = 0;
  const factory = f.args.publicationLease;
  f.args.publicationLease = async uri => ({ ...await factory(uri), async renew() { renewals++; throw new Error('read renewal failed'); } });
  t.mock.timers.enable({ apis: ['setInterval'] });
  const pending = bootstrapMainnetRootObjects(f.args);
  await started.promise;
  t.mock.timers.tick(20_000);
  await setImmediate();
  assert.equal(renewals, 1);
  const rejected = assert.rejects(pending, /read renewal failed/);
  release.resolve();
  await rejected;
  assert.equal(f.writes.length, 0);
  assert.equal(f.counts().closed, 1);
  t.mock.timers.tick(60_000);
  await setImmediate();
  assert.equal(renewals, 1);
});

test('bootstrap entrypoint rejects incomplete generated collections before acquiring a lease', async t => {
  const f = await fixture(t);
  await writeFile(join(f.args.directory, 'manifest.json'), JSON.stringify({ version: 1, objectCount: 4 }));
  await assert.rejects(bootstrapMainnetRootMetadata(f.args.directory, { storage: f.args.storage, publicationLease: f.args.publicationLease }), /complete collection/);
  assert.equal(f.counts().acquired, 0);
  assert.equal(f.counts().listed, 0);
  assert.equal(f.writes.length, 0);
});
