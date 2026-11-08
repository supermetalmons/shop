import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { run111kDeployment } from './111k-deployment.mjs';

test('a stale deployment lock cannot remove a replacement owner', { timeout: 10_000 }, async t => {
  const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), '111k-lock-race-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const exited = spawnSync(process.execPath, ['-e', '']);
  assert.equal(exited.status, 0);
  const id = randomUUID();
  const lock = join(directory, 'operation.lock');
  const marker = join(lock, `${id}.json`);
  await fs.mkdir(lock);
  await fs.writeFile(marker, JSON.stringify({ id, pid: exited.pid, host: hostname() }));
  const bothRead = Promise.withResolvers();
  const resumeStaleReader = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const duplicateEntry = Promise.withResolvers();
  const readFile = fs.readFile;
  let reads = 0;
  let entries = 0;
  t.mock.method(fs, 'readFile', async (...args) => {
    const content = await readFile(...args);
    if (args[0] === marker) {
      if (++reads === 1) await bothRead.promise;
      else if (reads === 2) {
        bothRead.resolve();
        await resumeStaleReader.promise;
      }
    }
    return content;
  });
  syncBuiltinESMExports();
  const invoke = () => run111kDeployment(['prepare', '--directory', directory, '--deployment-id', 'lock-test'], {
    resolvePredecessor: async () => ({ chainId: 11155111, contractAddress: `0x${'44'.repeat(20)}`,
      metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/old-lock/' }),
    rpc: async method => {
      if (method === 'eth_chainId') return '0xaa36a7';
      assert.equal(method, 'eth_getTransactionCount');
      if (++entries > 1) duplicateEntry.resolve(new Error('Two operations entered the protected section'));
      entered.resolve();
      await release.promise;
      throw new Error('Fixture stops before preparation');
    },
  }).catch(error => error);
  const operations = [invoke(), invoke()];
  try {
    await Promise.race([entered.promise, Promise.all(operations).then(() => assert.fail('Neither operation acquired the lock'))]);
    const ownerFiles = await fs.readdir(lock);
    assert.equal(ownerFiles.length, 1);
    assert.notEqual(ownerFiles[0], `${id}.json`);
    resumeStaleReader.resolve();
    const rejected = await Promise.race([...operations, duplicateEntry.promise]);
    assert.match(rejected.message, /Another metadata operation/);
    assert.equal(entries, 1);
    assert.deepEqual(await fs.readdir(lock), ownerFiles);
  } finally {
    bothRead.resolve();
    resumeStaleReader.resolve();
    release.resolve();
    await Promise.allSettled(operations);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  await assert.rejects(fs.stat(lock), { code: 'ENOENT' });
});

test('legacy deployment lock files are rejected without deleting their owner', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), '111k-legacy-lock-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const lock = join(directory, 'operation.lock');
  const owner = JSON.stringify({ pid: process.pid, host: hostname(), id: randomUUID() });
  await fs.writeFile(lock, owner);
  await assert.rejects(run111kDeployment(['prepare', '--directory', directory, '--deployment-id', 'lock-test'], {
    rpc: async method => {
      assert.equal(method, 'eth_chainId');
      return '0xaa36a7';
    },
  }), /Legacy or invalid metadata lock/);
  assert.equal(await fs.readFile(lock, 'utf8'), owner);
});
