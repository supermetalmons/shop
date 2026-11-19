import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import type { DuplicateCorrectionLedgerResult } from '../../../../shared/ethereum/duplicateCorrectionLedger.ts';

test('online duplicate correction swaps only free surplus in the full-size SQLite ledger and resumes after interruption', { timeout: 120_000 }, async t => {
  const bundle = await build({ entryPoints: [resolve(import.meta.dirname, 'duplicateCorrectionFixtureWorker.ts')],
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers', 'node:*'] });
  const worker = 'native-duplicate-correction';
  const config = { workers: [{ config: { name: worker, compatibilityDate: '2026-08-08', compatibilityFlags: ['nodejs_compat'],
    manifest: { mainModule: 'correction.mjs', modulesRoot: resolve('.'), modules: {
      'correction.mjs': { type: 'esm' as const, contents: bundle.outputFiles[0].text } } },
    env: { POOL: { type: 'durable-object' as const, exportName: 'CorrectionFixture', worker } },
    exports: { CorrectionFixture: { type: 'durable-object' as const, storage: 'sqlite' as const } } } }] };
  const runtime = new Miniflare(config);
  t.after(() => runtime.dispose());
  const call = async <T = unknown>(action: string): Promise<T> => {
    const response = await runtime.dispatchFetch(`https://fixture.test/${action}`);
    const data = await response.json();
    if (!response.ok) throw new Error(String(data));
    return data as T;
  };
  await call('seed');
  const initial = await call<DuplicateCorrectionLedgerResult>('inspect');
  assert.deepEqual([initial.totals.groups, initial.totals.paintings, initial.totals.revealed, initial.totals.extraRevealed,
    initial.totals.keptFree, initial.totals.toReplace], [313, 628, 244, 44, 113, 271]);
  assert.equal(await call('has-schema'), 0);
  await call('reserve-conflict');
  assert.equal((await call<DuplicateCorrectionLedgerResult>('inspect')).totals.conflicts, 1);
  await assert.rejects(call('apply'), /commitments conflict/);
  await call('release-conflict');
  await call('reserve-keeper');
  await call('prepare-holder');
  const digest = await call('fingerprint');
  await assert.rejects(call('failure'), /injected mapping failure/);
  await assert.rejects(call('unrelated-corruption'), /effective artwork identity is duplicated/);
  assert.equal(await call('has-schema'), 0);
  assert.equal(await call('fingerprint'), digest);
  const start = performance.now();
  const result = await call<DuplicateCorrectionLedgerResult>('apply');
  t.diagnostic(`Atomic 271-slot cutover plus local dispatch took ${Math.round(performance.now() - start)} ms`);
  assert.equal(result.applied, true);
  assert.equal(result.catalogRevision, 3);
  assert.deepEqual([result.totals.revealed, result.totals.reserved, result.totals.keptFree, result.totals.replaced,
    result.totals.toReplace, result.totals.conflicts, result.totals.extraRevealed], [244, 2, 111, 271, 0, 0, 44]);
  assert.deepEqual(await call('apply'), result);
  await call('immutability');
  await call('release-keeper');
  assert.equal(await call('claim-holder'), true);
  await runtime.setOptions(config);
  const resumed = await call<DuplicateCorrectionLedgerResult>('verify');
  assert.equal(resumed.appliedAtMs, result.appliedAtMs);
  assert.equal(resumed.totals.keptFree, 112);
  assert.equal(resumed.totals.revealed, 245);
  assert.equal(resumed.totals.replaced, 271);
  assert.equal(resumed.totals.conflicts, 0);
  assert.equal(await call('fingerprint'), digest);
  await call('full-verify');
  await call('next-catalog');
  for (const action of ['apply', 'inspect', 'verify']) assert.deepEqual(await call(action), { ...result, historical: true });
});
