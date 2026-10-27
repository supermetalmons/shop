import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs, { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { sha256 } from '../scripts/ethereum-metadata/catalog.ts';
import { publishObjects } from '../scripts/ethereum-metadata/remote.ts';
import { metadataMd5, type MetadataStorage } from '../scripts/ethereum-metadata/storage.ts';

async function fixture(t: TestContext, endpoint = 'https://example.invalid') {
  const directory = await mkdtemp(join(tmpdir(), '111k-journal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const body = Buffer.from('new metadata');
  const object = { file: '1.json', body, bytes: body.length, md5: metadataMd5(body), sha256: sha256(body) };
  let puts = 0;
  const storage: MetadataStorage = {
    destination: { endpoint, bucket: 'cdn-mons-shop' },
    async *list() { throw new Error('Unexpected listing'); },
    async get() { throw new Error('Unexpected download'); },
    async put(key, value) {
      assert.equal(key, '111k-sepolia/1.json');
      assert.deepEqual(value, body);
      puts++;
    },
    close() {},
  };
  const args = { storage, network: 'sepolia' as const, journal: join(directory, 'upload.jsonl'),
    sourceHash: sha256('journal test'), concurrency: 1, total: 1,
    inventory: new Map([['1.json', { key: '111k-sepolia/1.json', bytes: 3, md5: metadataMd5(Buffer.from('old')) }]]) };
  const header = `${JSON.stringify({ version: 1, ...storage.destination, network: args.network, sourceHash: args.sourceHash })}\n`;
  const publish = () => publishObjects({ ...args, objects: (async function* () { yield object; })() });
  return { directory, args, header, object, publish, puts: () => puts };
}

function restoreMocks(t: TestContext): void {
  t.mock.restoreAll();
  syncBuiltinESMExports();
}

test('failed initial journal writes leave no canonical header and perform no PUT', async t => {
  const { directory, args, header, publish, puts } = await fixture(t);
  const originalOpen = fs.open;
  const failure = Object.assign(new Error('interrupted header write'), { code: 'ENOSPC' });
  t.mock.method(fs, 'open', async (path, flags, mode) => {
    const handle = await originalOpen(path, flags, mode);
    if (String(path).startsWith(`${args.journal}.`)) {
      t.mock.method(handle, 'writeFile', async () => {
        await handle.write(header.slice(0, 10));
        throw failure;
      });
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(publish(), error => error === failure);
    assert.equal(puts(), 0);
    await assert.rejects(readFile(args.journal), { code: 'ENOENT' });
    assert.deepEqual(await readdir(directory), []);
  } finally { restoreMocks(t); }
  assert.deepEqual(await publish(), { uploaded: 1, skipped: 0 });
});

test('interruption before journal commit leaves only a temporary file that retry ignores', { timeout: 10_000 }, async t => {
  const { directory, args, header, publish, puts } = await fixture(t);
  const module = new URL('../scripts/ethereum-metadata/remote.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { publishObjects } from ${JSON.stringify(module)};
    fs.link = async () => process.exit(73);
    syncBuiltinESMExports();
    const storage = {
      destination: ${JSON.stringify(args.storage.destination)},
      put: async () => process.exit(74)
    };
    await publishObjects({ storage, network: 'sepolia', journal: process.argv[1],
      sourceHash: ${JSON.stringify(args.sourceHash)}, concurrency: 1, total: 1,
      inventory: new Map(), objects: (async function* () { yield {}; })() });
  `, args.journal], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code, signal] = await once(child, 'exit');
  assert.equal(code, 73, stderr);
  assert.equal(signal, null);
  await assert.rejects(readFile(args.journal), { code: 'ENOENT' });
  const [temporary] = await readdir(directory);
  assert.match(temporary, /^upload\.jsonl\.[a-f0-9-]{36}\.tmp$/);
  assert.equal(await readFile(join(directory, temporary), 'utf8'), header);
  assert.deepEqual(await publish(), { uploaded: 1, skipped: 0 });
  assert.equal(puts(), 1);
  assert.equal(await readFile(join(directory, temporary), 'utf8'), header);
  assert.equal((await readFile(args.journal, 'utf8')).split('\n')[0], header.trimEnd());
});

test('legacy empty or partial canonical headers fail closed without overwriting their state', async t => {
  const { args, header, publish, puts } = await fixture(t);
  for (const content of ['', header.slice(0, 10), header.trimEnd()]) {
    await writeFile(args.journal, content);
    await assert.rejects(publish(), /different destination or manifest/);
    assert.equal(await readFile(args.journal, 'utf8'), content);
    assert.equal(puts(), 0);
  }
});

test('valid mismatched canonical headers remain unchanged and block publication', async t => {
  const { args, header, publish, puts } = await fixture(t);
  const parsed = JSON.parse(header);
  for (const changed of [{ sourceHash: sha256('another source') }, { endpoint: 'https://another.invalid' }, { network: 'mainnet' }]) {
    const content = `${JSON.stringify({ ...parsed, ...changed })}\n`;
    await writeFile(args.journal, content);
    await assert.rejects(publish(), /different destination or manifest/);
    assert.equal(await readFile(args.journal, 'utf8'), content);
    assert.equal(puts(), 0);
  }
});

test('atomic journal commit never replaces a canonical journal created during initialization', async t => {
  const { directory, args, header, publish, puts } = await fixture(t);
  const originalLink = fs.link;
  const content = `${JSON.stringify({ ...JSON.parse(header), sourceHash: sha256('concurrent source') })}\n`;
  t.mock.method(fs, 'link', async (existing, path) => {
    await writeFile(path, content, { flag: 'wx' });
    return originalLink(existing, path);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(publish(), { code: 'EEXIST' });
    assert.equal(await readFile(args.journal, 'utf8'), content);
    assert.equal(puts(), 0);
    assert.deepEqual(await readdir(directory), ['upload.jsonl']);
  } finally { restoreMocks(t); }
});

test('incomplete journal tails are truncated by byte length without rewriting the valid prefix', async t => {
  const { args, header, object, publish } = await fixture(t, 'https://é.invalid');
  const complete = `${header}${JSON.stringify({ file: object.file, sha256: object.sha256 })}\n`;
  await writeFile(args.journal, `${complete}{"file":"2.json"`);
  const originalTruncate = fs.truncate;
  const truncated: Array<{ path: string; length: number | undefined }> = [];
  t.mock.method(fs, 'truncate', async (path, length) => {
    truncated.push({ path: String(path), length });
    return originalTruncate(path, length);
  });
  t.mock.method(fs, 'writeFile', async () => assert.fail('Tail repair must not rewrite the journal'));
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await publish(), { uploaded: 1, skipped: 0 });
    assert.deepEqual(truncated, [{ path: args.journal, length: Buffer.byteLength(complete) }]);
    assert.equal(await readFile(args.journal, 'utf8'), complete);
  } finally { restoreMocks(t); }
});

test('completion records remain whole when a single write would append only part of a record', async t => {
  const { args, header, object } = await fixture(t);
  const objects = [object, { ...object, file: '2.json' }];
  const inventory = new Map(args.inventory);
  inventory.set('2.json', { ...inventory.get('1.json')!, key: '111k-sepolia/2.json' });
  const writes: string[] = [];
  const storage: MetadataStorage = { ...args.storage, async put(key, body) {
    writes.push(key);
    inventory.set(key.slice('111k-sepolia/'.length), { key, bytes: body.length, md5: metadataMd5(body) });
  } };
  const originalOpen = fs.open;
  t.mock.method(fs, 'open', async (path, flags, mode) => {
    const handle = await originalOpen(path, flags, mode);
    if (path === args.journal && flags === 'a') {
      const originalWrite = handle.write.bind(handle);
      let firstWrite = true;
      t.mock.method(handle, 'write', async data => {
        const record = String(data);
        if (!firstWrite) return originalWrite(record);
        firstWrite = false;
        return originalWrite(record.slice(0, 10));
      });
    }
    return handle;
  });
  syncBuiltinESMExports();
  const publish = () => publishObjects({ ...args, storage, inventory, total: objects.length,
    objects: (async function* () { yield* objects; })() });
  try {
    assert.deepEqual(await publish(), { uploaded: 2, skipped: 0 });
    const expected = header + objects.map(({ file, sha256 }) => `${JSON.stringify({ file, sha256 })}\n`).join('');
    assert.equal(await readFile(args.journal, 'utf8'), expected);
    assert.deepEqual(await publish(), { uploaded: 0, skipped: 2 });
    assert.equal(await readFile(args.journal, 'utf8'), expected);
    assert.deepEqual(writes, ['111k-sepolia/1.json', '111k-sepolia/2.json']);
  } finally { restoreMocks(t); }
});
