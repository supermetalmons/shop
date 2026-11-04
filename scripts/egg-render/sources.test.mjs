import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareEggSources } from './sources.mjs';

test('refreshes a bad pinned source once and publishes only verified bytes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'egg-sources-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sample = { id: '1', path: join(dir, '1.webp'), source_url: 'https://example.test/1.webp' };
  const artwork = Buffer.from('RIFF0000WEBPcorrect');
  const stale = Buffer.from('RIFF0000WEBPstale');
  const hashes = { 1: createHash('sha256').update(artwork).digest('hex') };
  let upstream = Buffer.from('RIFF0000WEBPwrong');
  const fetch = t.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response(upstream)));
  const prepare = () => prepareEggSources([sample], hashes);

  await assert.rejects(prepare(), /differs from the saved egg 1/);
  assert.deepEqual(await readdir(dir), []);
  await writeFile(sample.path, stale);
  await assert.rejects(prepare(), /differs from the saved egg 1/);
  assert.deepEqual(await readFile(sample.path), stale);
  assert.equal(fetch.mock.callCount(), 2);

  upstream = artwork;
  await prepare();
  assert.equal(fetch.mock.callCount(), 3);
  await prepare();
  assert.equal(fetch.mock.callCount(), 3);

  await writeFile(sample.path, stale);
  await Promise.all([prepare(), prepare()]);
  assert.deepEqual(await readFile(sample.path), artwork);
  assert.deepEqual(await readdir(dir), ['1.webp']);

  const unpinned = { id: '2', path: join(dir, '2.webp'), source_url: 'https://example.test/2.webp' };
  upstream = stale;
  await prepareEggSources([sample, unpinned], hashes);
  assert.deepEqual(await readFile(unpinned.path), upstream);
});
