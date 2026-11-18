import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const workspaceRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const childPath = fileURLToPath(new URL('./inventory-memory.child.ts', import.meta.url));

test('inventory compacts 50-60 MiB of provider data within a constrained heap', { timeout: 120_000 }, async t => {
  const cache = join(workspaceRoot, '.cache');
  await mkdir(cache, { recursive: true });
  const outdir = await mkdtemp(join(cache, 'inventory-memory-'));
  t.after(() => rm(outdir, { recursive: true, force: true }));
  await build({ entryPoints: [childPath], outdir, bundle: true, splitting: true, format: 'esm', platform: 'node',
    target: 'node26', packages: 'external', outExtension: { '.js': '.mjs' } });
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    '--max-old-space-size=80',
    '--max-semi-space-size=4',
    join(outdir, 'inventory-memory.child.mjs'),
  ], {
    cwd: workspaceRoot,
    env: { ...process.env, NODE_OPTIONS: '' },
    maxBuffer: 4 * 1024 * 1024,
    timeout: 110_000,
  });
  assert.equal(stderr, '');
  const result = JSON.parse(stdout.trim()) as {
    providerCalls: number;
    providerResponseBytes: number;
    responseBytes: number;
    items: number;
    maxActiveProviderCalls: number;
    maxActiveProviderBodyReads: number;
  };
  assert.ok(result.providerCalls > 32);
  assert.ok(result.providerResponseBytes >= 50 * 1024 * 1024);
  assert.ok(result.providerResponseBytes <= 60 * 1024 * 1024);
  assert.ok(result.responseBytes < result.providerResponseBytes / 100);
  assert.equal(result.items, 32 * 64);
  assert.equal(result.maxActiveProviderCalls, 3);
  assert.equal(result.maxActiveProviderBodyReads, 1);
});
