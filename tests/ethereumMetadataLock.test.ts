import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { withMetadataLock } from '../scripts/ethereum-metadata/lock.ts';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), '111k-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, 'operation.lock') };
}

async function abandonLock(path: string) {
  const module = new URL('../scripts/ethereum-metadata/lock.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { withMetadataLock } from ${JSON.stringify(module)};
    await withMetadataLock(process.argv[1], async () => {
      process.send('locked');
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    });
  `, path], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(child, 'exit');
  try {
    await Promise.race([
      once(child, 'message'),
      exited.then(() => { throw new Error('Lock owner exited before acquisition'); }),
    ]);
    child.kill('SIGINT');
    await exited;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

test('metadata locks exclude active owners and clean failed acquisition attempts', async t => {
  const { directory, path } = await fixture(t);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const first = withMetadataLock(path, async () => {
    entered.resolve();
    await release.promise;
    return 42;
  });
  try {
    await entered.promise;
    await assert.rejects(withMetadataLock(path, async () => assert.fail('concurrent owner entered')), /Another metadata operation owns/);
    assert.deepEqual(await readdir(directory), ['operation.lock']);
  } finally { release.resolve(); }
  assert.equal(await first, 42);
  assert.deepEqual(await readdir(directory), []);
});

test('metadata locks recover after an owner is interrupted', { timeout: 10_000 }, async t => {
  const { directory, path } = await fixture(t);
  await abandonLock(path);
  assert.equal((await readdir(path)).length, 1);
  assert.equal(await withMetadataLock(path, async () => 'resumed'), 'resumed');
  assert.deepEqual(await readdir(directory), []);
});

test('simultaneous stale-lock recovery admits only one owner', { timeout: 10_000 }, async t => {
  const { path } = await fixture(t);
  await abandonLock(path);
  const rejected = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let entered = 0;
  let failures = 0;
  const attempts = Array.from({ length: 12 }, () => withMetadataLock(path, async () => {
    entered++;
    await release.promise;
  }).catch(error => {
    assert.match(error.message, /Another metadata operation owns/);
    if (++failures === 11) rejected.resolve();
  }));
  try {
    await rejected.promise;
    assert.equal(entered, 1);
    assert.equal((await readdir(path)).length, 1);
  } finally { release.resolve(); }
  await Promise.all(attempts);
  assert.equal(entered, 1);
});

test('an old owner cannot remove a replacement owners lock when releasing', async t => {
  const { directory, path } = await fixture(t);
  const replacementEntered = Promise.withResolvers<void>();
  const releaseReplacement = Promise.withResolvers<void>();
  let replacement: Promise<void>;
  await withMetadataLock(path, async () => {
    await rename(path, join(directory, 'previous.lock'));
    replacement = withMetadataLock(path, async () => {
      replacementEntered.resolve();
      await releaseReplacement.promise;
    });
    await replacementEntered.promise;
  });
  try {
    assert.equal((await readdir(path)).length, 1);
    await assert.rejects(withMetadataLock(path, async () => assert.fail('replacement owner lost its lock')), /Another metadata operation owns/);
  } finally { releaseReplacement.resolve(); }
  await replacement!;
});

test('metadata locks release ownership after work fails', async t => {
  const { directory, path } = await fixture(t);
  const failure = new Error('work failed');
  await assert.rejects(withMetadataLock(path, async () => { throw failure; }), error => error === failure);
  assert.deepEqual(await readdir(directory), []);
  assert.equal(await withMetadataLock(path, async () => 'retry'), 'retry');
});

test('legacy files and foreign or malformed owners fail closed', async t => {
  const { directory, path } = await fixture(t);
  await writeFile(path, 'legacy');
  await assert.rejects(withMetadataLock(path, async () => assert.fail('legacy lock bypassed')), /Confirm no metadata operation is running/);
  assert.equal(await readFile(path, 'utf8'), 'legacy');
  await rm(path);
  await mkdir(path);
  const id = randomUUID();
  const marker = join(path, `${id}.json`);
  for (const body of [JSON.stringify({ id, host: `${hostname()}-other`, pid: process.pid }), '{']) {
    await writeFile(marker, body);
    await assert.rejects(withMetadataLock(path, async () => assert.fail('unknown owner bypassed')), /Another metadata operation owns|Unreadable metadata lock/);
    assert.equal(await readFile(marker, 'utf8'), body);
    assert.deepEqual(await readdir(directory), ['operation.lock']);
  }
});
