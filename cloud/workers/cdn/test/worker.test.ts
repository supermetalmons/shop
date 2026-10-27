import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createTestHarness } from 'wrangler';

test('metadata CDN reads fresh R2 objects and never caches any response', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'mons-cdn-test-'));
  const server = createTestHarness({ root, workers: [{ config: {
    name: 'mons-shop-cdn-test', main: resolve('cloud/workers/cdn/src/index.ts'),
    compatibility_date: '2026-08-08', compatibility_flags: ['nodejs_compat'],
    r2_buckets: [{ binding: 'METADATA_BUCKET', bucket_name: 'cdn-test', remote: false }],
  } }] });
  context.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  await server.listen();
  const worker = server.getWorker<Env>('mons-shop-cdn-test');
  const bucket = (await worker.getEnv()).METADATA_BUCKET;
  const fetch = (path: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => worker.fetch(`https://cdn.mons.shop${path}`, init);
  const assertFresh = (response: { headers: { get(name: string): string | null } }) => {
    for (const name of ['Cache-Control', 'CDN-Cache-Control', 'Cloudflare-CDN-Cache-Control']) {
      assert.equal(response.headers.get(name), 'no-store');
    }
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  };
  const path = '/111k-sepolia/1.json';
  const missing = await fetch(path);
  assert.equal(missing.status, 404);
  assertFresh(missing);
  await bucket.put(path.slice(1), JSON.stringify({ name: 'first' }), {
    httpMetadata: { cacheControl: 'public, max-age=31536000', contentType: 'text/plain' },
  });
  const first = await fetch(path);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assertFresh(first);
  assert.deepEqual(await first.json(), { name: 'first' });
  const etag = first.headers.get('ETag');
  assert.ok(etag);
  await bucket.put(path.slice(1), JSON.stringify({ name: 'second' }));
  const second = await fetch(path, { headers: { 'If-None-Match': etag } });
  assert.equal(second.status, 200);
  assertFresh(second);
  assert.deepEqual(await second.json(), { name: 'second' });
  assert.notEqual(second.headers.get('ETag'), etag);
  const head = await fetch(path, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assertFresh(head);
  assert.equal(await head.text(), '');
  assert.equal(Number(head.headers.get('Content-Length')), Buffer.byteLength(JSON.stringify({ name: 'second' })));
  const preflight = await fetch(path, { method: 'OPTIONS', headers: { Origin: 'https://example.com' } });
  assert.equal(preflight.status, 204);
  assertFresh(preflight);
  const rejected = await fetch(path, { method: 'PUT', body: '{}' });
  assert.equal(rejected.status, 405);
  assertFresh(rejected);
  assert.equal(rejected.headers.get('Allow'), 'GET, HEAD, OPTIONS');
  await bucket.delete(path.slice(1));
  const removed = await fetch(path);
  assert.equal(removed.status, 404);
  assertFresh(removed);
  for (const tokenId of [1, 111111, 111112, 116666, 116667, 117171, 1000001, 1111111, 1111112, 1222222, 2000001, 2005555]) {
    const key = `111k/${tokenId}.json`;
    await bucket.put(key, JSON.stringify({ tokenId }));
    const response = await fetch(`/${key}`);
    assert.equal(response.status, 200, key);
    assertFresh(response);
    assert.deepEqual(await response.json(), { tokenId });
  }
  for (const invalid of ['/111k/0.json', '/111k/01.json', '/111k/117172.json', '/111k/1000000.json',
    '/111k/1222223.json', '/111k/2000000.json', '/111k/2005556.json', '/111k/9007199254740993.json',
    '/111k/1.svg', '/other/1.json', '/111k/', '/111k/%31.json']) {
    const response = await fetch(invalid);
    assert.equal(response.status, 404, invalid);
    assertFresh(response);
  }
  await bucket.put('111k-sepolia/2.json', 'x'.repeat(128 * 1024 + 1));
  const oversized = await fetch('/111k-sepolia/2.json');
  assert.equal(oversized.status, 502);
  assertFresh(oversized);
});
