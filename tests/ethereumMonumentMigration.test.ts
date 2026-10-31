import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import type { S3Client } from '@aws-sdk/client-s3';
import { parseMonumentMigrationArgs, renamedMonumentBody, runMonumentMigration } from '../scripts/ethereum-metadata/renameMonuments.ts';
import { acquireMetadataPublicationLease, type MetadataPublicationLease, type MetadataWriteFence } from '../scripts/ethereum-metadata/publicationLease.ts';
import { metadataMd5, S3MetadataStorage, type MetadataNamespaceStorage } from '../scripts/ethereum-metadata/storage.ts';

const sha256 = (body: string | Buffer) => createHash('sha256').update(body).digest('hex');
const bodyFor = (number: number, renamed = false) => Buffer.from(JSON.stringify({
  name: `${renamed ? 'Monument' : 'Reliquary'} #${number}`, description: '',
  image: `https://wip.lil.org/111k/monuments/${number}.webp`,
  attributes: [{ trait_type: 'type', value: renamed ? 'monument' : 'reliquary', display_type: 'string' }, { trait_type: 'edition', value: 1 }],
  external_url: 'https://mons.shop', extra: { preserved: ['✓', 4, null] },
}));

class MemoryStorage implements MetadataNamespaceStorage {
  destination = { endpoint: `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`, bucket: 'cdn-mons-shop' };
  values = new Map<string, Buffer>();
  writes: Array<{ key: string; etag: string; fenced: boolean }> = [];
  beforePut?: (key: string) => void;
  afterPut?: (key: string) => void;
  async *prefixes(root: string) {
    const found = new Set<string>();
    for (const key of [...this.values.keys()].sort()) {
      if (!key.startsWith(root)) continue;
      const parts = key.slice(root.length).split('/');
      if (parts.length > 1) found.add(root + parts[0] + '/');
    }
    yield* [...found].sort();
  }
  async *list(prefix: string) {
    for (const key of [...this.values.keys()].sort()) {
      if (!key.startsWith(prefix) || key.slice(prefix.length).includes('/')) continue;
      const body = this.values.get(key)!;
      yield { key, bytes: body.length, md5: metadataMd5(body) };
    }
  }
  async get(key: string) {
    const value = this.values.get(key);
    if (!value) throw new Error(`NoSuchKey: ${key}`);
    return Buffer.from(value);
  }
  async put(key: string, body: Buffer, etag?: string | null, fence?: MetadataWriteFence) {
    this.beforePut?.(key);
    fence?.assertWritable();
    assert.ok(etag);
    if (!this.values.has(key) || `"${metadataMd5(this.values.get(key)!)}"` !== etag) throw new Error('PreconditionFailed');
    this.writes.push({ key, etag, fenced: !!fence });
    this.values.set(key, Buffer.from(body));
    this.afterPut?.(key);
  }
  close() {}
}

function deployment(prefix = '111k-sepolia/v7/') {
  const template = JSON.stringify({ name: '{{tokenId}}', description: '', image: 'https://example.com/artwork.png', attributes: [] });
  return { deployment_id: prefix.split('/')[1], drop_id: '111k_devnet', chain_id: 11155111,
    contract_address: '0x' + 'a'.repeat(40), metadata_base_uri: `https://cdn.mons.shop/${prefix}`, deployment_block: 1,
    catalog_version: '111k-v1', template_json: template, template_sha256: sha256(template), state: 'active', revision: 3,
    created_at_ms: 1, updated_at_ms: 2, activated_at_ms: 2, provisioned_at_ms: 2, last_error: null };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'monument-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storage = new MemoryStorage();
  storage.values.set('111k/1.json', Buffer.from('{"name":"Mainnet artwork"}'));
  storage.values.set('111k-sepolia/1.json', Buffer.from('{"name":"Retired artwork"}'));
  storage.values.set('111k-sepolia/v7/1.json', Buffer.from('{"name":"Frozen artwork"}'));
  for (const prefix of ['111k/reliquaries-v1/', '111k-sepolia/v7/']) {
    for (let number = 1; number <= 30; number++) storage.values.set(`${prefix}${117171 + number}.json`, bodyFor(number));
  }
  storage.values.set('111k-sepolia/previously-unknown/117189.json', bodyFor(18));
  const registry = [deployment(), deployment('111k-sepolia/registry-only/')];
  const leases: Array<{ uri: string; closed: boolean; puts: number }> = [];
  const options = { storage,
    async query(sql: string) { assert.match(sql, /^SELECT \* FROM ethereum_reveal_deployments/); return structuredClone(registry); },
    async acquireLease(uri: string): Promise<MetadataPublicationLease> {
      assert.ok(!registry.some(row => row.metadata_base_uri === uri));
      const state = { uri, closed: false, puts: 0 }; leases.push(state);
      return { leaseId: 'fixture', signal: new AbortController().signal,
        assertWritable() { assert.equal(state.closed, false); },
        async beforePut() { state.puts++; }, async retireForRegistration() { throw new Error('Unexpected registration'); },
        async close() { state.closed = true; } };
    },
    fetch: (async (input: string | URL | Request) => {
      const key = new URL(String(input)).pathname.slice(1);
      return new Response(new Uint8Array(await storage.get(key)), { headers: { 'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store', 'access-control-allow-origin': '*', 'cf-cache-status': 'DYNAMIC' } });
    }) as typeof fetch,
  };
  const run = (command: string) => runMonumentMigration([command, '--directory', directory, ...(command === 'apply' ? ['--write'] : [])], options);
  return { directory, storage, registry, options, leases, run };
}

test('migration CLI requires an explicit write flag only for apply', () => {
  for (const args of [['apply', '--directory', 'x'], ['plan', '--directory', 'x', '--write'], ['verify', '--directory', 'x', '--write'],
    ['plan'], ['delete', '--directory', 'x']]) assert.throws(() => parseMonumentMigrationArgs(args), /Usage/);
  assert.equal(parseMonumentMigrationArgs(['apply', '--directory', 'x', '--write']).command, 'apply');
});

test('legacy transform preserves all fields except name and type, including editions 19 through 30', () => {
  for (const number of [1, 18, 19, 30]) {
    const before = bodyFor(number);
    const after = renamedMonumentBody(`111k/${117171 + number}.json`, '111k/', before);
    const expected = JSON.parse(before.toString());
    expected.name = `Monument #${number}`;
    expected.attributes[0].value = 'monument';
    assert.deepEqual(JSON.parse(after.toString()), expected);
    assert.deepEqual(renamedMonumentBody(`111k/${117171 + number}.json`, '111k/', after), after);
  }
  for (const token of [1, 111111, 117171, 117202, 2000001]) {
    assert.throws(() => renamedMonumentBody(`111k/${token}.json`, '111k/', bodyFor(1)), /only update legacy/);
  }
  assert.throws(() => renamedMonumentBody('unrelated/117172.json', 'unrelated/', bodyFor(1)), /Invalid deployment metadata prefix/);
  for (const modify of [
    (value: any) => { value.name = 'Reliquary #2'; },
    (value: any) => { value.attributes[0].value = 'painting'; },
    (value: any) => { value.attributes.push({ trait_type: 'type', value: 'reliquary' }); },
    (value: any) => { value.description = 'A reliquary'; },
  ]) {
    const value = JSON.parse(bodyFor(1).toString()); modify(value);
    assert.throws(() => renamedMonumentBody('111k/117172.json', '111k/', Buffer.from(JSON.stringify(value))));
  }
});

test('plan discovers both roots, unknown previews and registry-only prefixes without remote writes', async t => {
  const f = await fixture(t);
  const report = await f.run('plan');
  assert.equal(report.objects, 61);
  assert.equal(report.prefixes, 6);
  assert.deepEqual(f.storage.writes, []);
  assert.deepEqual(f.leases, []);
  const plan = JSON.parse(await readFile(join(f.directory, 'plan.json'), 'utf8'));
  assert.deepEqual(plan.scopes.map((scope: any) => scope.prefix), ['111k-sepolia/', '111k-sepolia/previously-unknown/',
    '111k-sepolia/registry-only/', '111k-sepolia/v7/', '111k/', '111k/reliquaries-v1/']);
  const sample = plan.scopes.flatMap((scope: any) => scope.objects).find((object: any) => object.key.endsWith('/117201.json'));
  assert.equal(sample.before.bytes, Buffer.byteLength(sample.before.body));
  assert.equal(sample.before.md5, metadataMd5(Buffer.from(sample.before.body)));
  assert.equal(sample.after.sha256, sha256(sample.after.body));
  await assert.rejects(f.run('plan'), /already exists/);
});

test('apply preserves coverage, frozen artwork and registry while leasing previews and conditionally renaming every legacy container', async t => {
  const f = await fixture(t);
  const original = new Map(f.storage.values);
  const registry = structuredClone(f.registry);
  await f.run('plan');
  const applied = await f.run('apply');
  assert.ok('written' in applied);
  assert.equal(applied.written, 61);
  assert.deepEqual([...f.storage.values.keys()], [...original.keys()]);
  assert.deepEqual(f.registry, registry);
  for (const [key, before] of original) {
    if (key.endsWith('/1.json')) assert.deepEqual(f.storage.values.get(key), before);
    else assert.deepEqual(f.storage.values.get(key), renamedMonumentBody(key, key.slice(0, key.lastIndexOf('/') + 1), before));
  }
  assert.equal(f.storage.values.has('111k-sepolia/previously-unknown/117172.json'), false);
  assert.ok(f.storage.writes.every(write => write.etag === `"${metadataMd5(original.get(write.key)!)}"`));
  assert.ok(f.storage.writes.filter(write => write.key.startsWith('111k-sepolia/v7/')).every(write => !write.fenced));
  assert.ok(f.storage.writes.filter(write => !write.key.startsWith('111k-sepolia/v7/')).every(write => write.fenced));
  assert.equal(f.leases.length, 2);
  assert.ok(f.leases.every(lease => lease.closed));
  const verified = await f.run('verify');
  assert.ok('complete' in verified && verified.complete);
  assert.equal(verified.objects, 61);
  const again = await f.run('apply');
  assert.ok('written' in again);
  assert.equal(again.written, 0);
  assert.equal(again.skipped, 61);
  assert.equal(f.storage.writes.length, 61);
});

test('apply rejects changed bodies, coverage and immutable registry identity before writing', async t => {
  for (const mutation of ['body', 'coverage', 'registry', 'namespace']) {
    await t.test(mutation, async t => {
      const f = await fixture(t);
      await f.run('plan');
      if (mutation === 'body') f.storage.values.set('111k-sepolia/v7/117172.json', Buffer.from('{}'));
      if (mutation === 'coverage') f.storage.values.delete('111k-sepolia/v7/117201.json');
      if (mutation === 'registry') f.registry[0].template_sha256 = '0'.repeat(64);
      if (mutation === 'namespace') f.storage.values.set('111k-sepolia/new-scope/117172.json', bodyFor(1));
      await assert.rejects(f.run('apply'), /changed/);
      assert.equal(f.storage.writes.length, 0);
    });
  }
});

test('plan validates all candidate bodies before any mutation and apply rejects forged wider changes', async t => {
  const malformed = await fixture(t);
  malformed.storage.values.set('111k-sepolia/v7/117201.json', bodyFor(1));
  await assert.rejects(malformed.run('plan'), /Unexpected legacy/);
  assert.equal(malformed.storage.writes.length, 0);
  const f = await fixture(t);
  await f.run('plan');
  const file = join(f.directory, 'plan.json');
  const plan = JSON.parse(await readFile(file, 'utf8'));
  const item = plan.scopes.flatMap((scope: any) => scope.objects)[0];
  const json = JSON.parse(item.after.body); json.image = 'https://example.com/changed.png';
  const body = Buffer.from(JSON.stringify(json));
  item.after = { body: body.toString(), bytes: body.length, md5: metadataMd5(body), sha256: sha256(body) };
  await writeFile(file, JSON.stringify(plan));
  await assert.rejects(f.run('apply'), /changes more than container wording/);
  assert.equal(f.storage.writes.length, 0);
});

test('conditional conflict cannot overwrite a concurrent change and all preview leases close on failure', async t => {
  const f = await fixture(t);
  await f.run('plan');
  const key = '111k-sepolia/previously-unknown/117189.json';
  f.storage.beforePut = candidate => { if (candidate === key) f.storage.values.set(key, Buffer.from('{"concurrent":true}')); };
  await assert.rejects(f.run('apply'), /PreconditionFailed/);
  assert.equal(f.storage.values.get(key)?.toString(), '{"concurrent":true}');
  assert.equal(f.storage.writes.length, 0);
  assert.ok(f.leases.every(lease => lease.closed));
});

test('an ambiguous completed write and truncated journal resume without overwriting again', async t => {
  const f = await fixture(t);
  await f.run('plan');
  let failed = false;
  f.storage.afterPut = () => { if (!failed) { failed = true; throw new Error('Response lost after commit'); } };
  await assert.rejects(f.run('apply'), /Response lost/);
  assert.equal(f.storage.writes.length, 1);
  await appendFile(join(f.directory, 'journal.jsonl'), '{"incomplete":');
  const result = await f.run('apply');
  assert.ok('written' in result);
  assert.equal(result.written, 60);
  assert.equal(result.skipped, 1);
  assert.equal(f.storage.writes.length, 61);
  await f.run('verify');
});

test('verification rejects stale public JSON, incorrect headers and remaining old metadata', async t => {
  const f = await fixture(t);
  await f.run('plan');
  await assert.rejects(f.run('verify'), /incomplete/);
  await f.run('apply');
  for (const problem of ['body', 'cache', 'cors', 'type', 'redirect']) {
    const badFetch = (async () => new Response(problem === 'body' ? bodyFor(1).toString() : '{}', { status: problem === 'redirect' ? 302 : 200,
      headers: { 'content-type': problem === 'type' ? 'text/plain' : 'application/json', 'cache-control': 'no-store',
        'access-control-allow-origin': problem === 'cors' ? 'https://mons.shop' : '*', 'cf-cache-status': problem === 'cache' ? 'HIT' : 'DYNAMIC' } })) as typeof fetch;
    await assert.rejects(runMonumentMigration(['verify', '--directory', f.directory], { ...f.options, fetch: badFetch }), /Public metadata/);
  }
});

test('ordinary publication lease still rejects registered prefixes at the database guard', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(await readFile(new URL('../cloud/workers/api/ops-migrations/0009_ethereum_reveal_deployments.sql', import.meta.url), 'utf8'));
    const row = deployment();
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO ethereum_reveal_deployments (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row));
    await assert.rejects(acquireMetadataPublicationLease(row.metadata_base_uri, { query: sql => db.prepare(sql).all() }), /reveal-managed/);
    assert.throws(() => db.prepare('INSERT INTO ethereum_metadata_publication_leases VALUES (?,?,?,?)')
      .run(row.metadata_base_uri, 'unexpected', 0, 0), /owned by reveal publisher/);
  } finally { db.close(); }
});

test('namespace discovery paginates past direct root objects and validates nested paths and continuation', async () => {
  const calls: Record<string, unknown>[] = [];
  const pages = [{ Contents: [{ Key: '111k/1.json' }], IsTruncated: true, NextContinuationToken: 'page2' },
    { CommonPrefixes: [{ Prefix: '111k/unknown-preview/' }], IsTruncated: true, NextContinuationToken: 'page3' },
    { CommonPrefixes: [{ Prefix: '111k/unknown-preview/' }, { Prefix: '111k/z-last/' }], IsTruncated: false }];
  const client = { async send(command: { input: Record<string, unknown> }) { calls.push(command.input); return pages[calls.length - 1]; }, destroy() {} } as unknown as S3Client;
  const storage = new S3MetadataStorage({ endpoint: 'https://example.invalid', bucket: 'cdn-mons-shop' }, client);
  const found: string[] = [];
  for await (const prefix of storage.prefixes('111k/')) found.push(prefix);
  assert.deepEqual(found, ['111k/unknown-preview/', '111k/z-last/']);
  assert.deepEqual(calls.map(call => call.ContinuationToken), [undefined, 'page2', 'page3']);
  for (const response of [
    { CommonPrefixes: [{ Prefix: '111k/../' }], IsTruncated: false },
    { CommonPrefixes: [{ Prefix: '111k/one/two/' }], IsTruncated: false },
    { CommonPrefixes: [{ Prefix: '111k-sepolia/v7/' }], IsTruncated: false },
    { IsTruncated: true, NextContinuationToken: 'loop' },
  ]) {
    const invalid = new S3MetadataStorage(storage.destination, { send: async () => response, destroy() {} } as unknown as S3Client);
    await assert.rejects(async () => { for await (const _prefix of invalid.prefixes('111k/')) {} }, /Invalid/);
  }
});
