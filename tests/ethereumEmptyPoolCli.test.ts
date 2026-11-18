import registry from '../shared/ethereum/mixedAllocationReleases.json';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { buildRevealAssetCatalog } from '../scripts/ethereum-metadata/assetImport.ts';
import { buildRevealCatalogUpdateBatch } from './helpers/historicalCatalogBatch.ts';
import { emptyPoolMain, parseEmptyPoolArgs } from '../scripts/ethereum-metadata/emptyPoolCli.ts';
import type { EthereumRevealEmptyPoolRequest, EthereumRevealEmptyPoolResult } from '../shared/ethereum/revealMaintenance.ts';

const scope = ['--bundle', 'releases/test', '--deployment-id', 'mainnet-v1', '--operation-id', `empty-${'a'.repeat(32)}`,
  '--expected-revision', '6'];

test('empty-pool CLI pins one operation and requires explicit writes', () => {
  assert.equal(parseEmptyPoolArgs(['apply', ...scope, '--write']).expectedRevision, 6);
  assert.equal(parseEmptyPoolArgs(['cancel', ...scope, '--write']).operationId, `empty-${'a'.repeat(32)}`);
  for (const command of ['inspect', 'verify']) assert.equal(parseEmptyPoolArgs([command, ...scope]).command, command);
  for (const command of ['apply', 'cancel']) assert.throws(() => parseEmptyPoolArgs([command, ...scope]), /Usage/);
  for (const command of ['inspect', 'verify']) assert.throws(() => parseEmptyPoolArgs([command, ...scope, '--write']), /Usage/);
});

test('empty-pool writes reject public bundle directories before opening a transport', async () => {
  let calls = 0;
  await assert.rejects(emptyPoolMain(['apply', ...scope, '--write'], {
    transport: async () => { calls++; throw new Error('Unexpected transport'); },
  }), /Hatch evidence/);
  assert.equal(calls, 0);
});

test('empty-pool CLI rejects ambiguous identities and unsafe revisions', () => {
  assert.throws(() => parseEmptyPoolArgs(['apply', ...scope, '--write', '--operation-id', `empty-${'b'.repeat(32)}`]), /Duplicate/);
  for (const revision of ['0', '-1', '01', '1.5', '9007199254740992']) {
    assert.throws(() => parseEmptyPoolArgs(['apply', ...scope.slice(0, -1), revision, '--write']), /Usage|ambiguous/);
  }
  assert.throws(() => parseEmptyPoolArgs(['apply', '--bundle', 'x', '--deployment-id', 'mainnet-v1', '--operation-id', 'other',
    '--expected-revision', '6', '--write']), /Usage/);
});

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'empty-pool-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previous = { '3d/1.png': [1, 1], 'animated/1.png': [1, 1], 'paintings/1.png': [1, 1],
    'videos/1.mp4': [2, 1], 'videos/1.webp': [2, 1] };
  const source = JSON.stringify({ ...previous, 'paintings/2.png': [2, 3] });
  const predecessor = JSON.stringify(previous);
  const batch = buildRevealCatalogUpdateBatch(
    buildRevealAssetCatalog(predecessor, { catalogVersion: '111k-v5', availableEggs: 111111 }),
    buildRevealAssetCatalog(source, { catalogVersion: '111k-v6', availableEggs: 111111 }),
  );
  await Promise.all([['batch.json', JSON.stringify(batch)], ['source.json', source], ['predecessor-source.json', predecessor]]
    .map(([name, bytes]) => writeFile(join(directory, name), bytes)));
  const args = ['--bundle', directory, ...scope.slice(2)];
  const journalPath = join(directory, 'mainnet-v1.empty-pool.journal.json');
  const result = (phase: EthereumRevealEmptyPoolResult['phase'] = 'complete'): EthereumRevealEmptyPoolResult => ({
    deploymentId: 'mainnet-v1', operationId: `empty-${'a'.repeat(32)}`, phase, complete: phase === 'complete',
    catalogRevision: 2, seeded: 111111, total: 111111, fenceActive: phase !== 'complete', retryAfterMs: 0,
  });
  return { directory, args, journalPath, batch, result };
}

test('empty-pool retries preserve the original revision and replace checkpoints without changing the frozen bundle', async t => {
  const f = await fixture(t);
  await assert.rejects(emptyPoolMain(['apply', ...f.args, '--write'], {
    transport: async () => { throw new Error('interrupted begin'); },
  }), /interrupted begin/);
  const before = await readFile(f.journalPath, 'utf8');
  assert.equal(JSON.parse(before).expectedRevision, 6);
  assert.equal(JSON.parse(before).result, null);
  await assert.rejects(emptyPoolMain(['apply', ...f.args.slice(0, -1), '7', '--write'], {
    transport: async () => { assert.fail('changed revision reached transport'); },
  }), /original revision/);
  const calls: EthereumRevealEmptyPoolRequest[] = [];
  await emptyPoolMain(['inspect', ...f.args], { transport: async request => { calls.push(request); return f.result(); } });
  assert.equal(await readFile(f.journalPath, 'utf8'), before);
  await emptyPoolMain(['apply', ...f.args, '--write'], { transport: async request => {
    calls.push(request);
    return f.result(request.action === 'begin' ? 'staging' : 'complete');
  } });
  assert.deepEqual(calls.map(call => call.action), ['inspect', 'begin', 'advance']);
  assert(calls.every(call => call.expectedRevision === 6));
  assert.deepEqual(calls[1].batch, f.batch);
  const completed = JSON.parse(await readFile(f.journalPath, 'utf8'));
  assert.equal(completed.result.complete, true);
  assert.equal(completed.expectedRevision, 6);
  assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'batch.json'), 'utf8')), f.batch);
  assert.equal((await readdir(f.directory)).some(name => name.endsWith('.tmp') || name.endsWith('.lock')), false);
});

test('empty-pool mutations retain their operation lock and reject mismatched responses', async t => {
  const f = await fixture(t);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const first = emptyPoolMain(['apply', ...f.args, '--write'], { transport: async () => {
    entered();
    await blocked;
    return f.result();
  } });
  await started;
  try {
    await assert.rejects(emptyPoolMain(['cancel', ...f.args, '--write'], {
      transport: async () => { assert.fail('concurrent mutation reached transport'); },
    }), /Another metadata operation/);
  } finally { release(); }
  await first;
  const before = await readFile(f.journalPath, 'utf8');
  await assert.rejects(emptyPoolMain(['cancel', ...f.args, '--write'], {
    transport: async () => ({ ...f.result(), operationId: `empty-${'b'.repeat(32)}` }),
  }), /response identity changed/);
  assert.equal(await readFile(f.journalPath, 'utf8'), before);
});

test('empty rebuild can select an installed future-only mixed release and rejects owner rewards', async t => {
  const { getRevealCatalogDescriptor } = await import('../shared/ethereum/revealCatalogRegistry.ts');
  const { mixedAllocationHash } = await import('../shared/ethereum/revealMixedAllocation.ts');
  const { emptyPoolRelease } = await import('../shared/ethereum/installedMixedAllocation.ts');
  const definition = { version: 2, batchId: 'reviewed-prelaunch-fixture', deploymentId: 'prelaunch-fixture', chainId: 1,
    contractAddress: '0x' + '1'.repeat(40), deploymentBlock: 1, metadataBaseUri: 'https://cdn.mons.shop/111k/prelaunch-fixture/',
    originCatalogVersion: '111k-v6', predecessor: getRevealCatalogDescriptor('111k-v6')!, target: getRevealCatalogDescriptor('111k-v7')!,
    sourceSha256: '0'.repeat(64), ownerSupplementSha256: '0'.repeat(64), collectionBlocksSha256: '0'.repeat(64),
    groups: [{ category: 'painting', collectionBlock: 'fixture collection', firstId: 1, lastId: 1, ownerCount: 0 }],
    ordinaryCount: 0 };
  (registry as unknown[]).push(definition);
  t.after(() => { registry.pop(); });
  const directory = await mkdtemp(join(tmpdir(), '111k-empty-mixed-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'definition.json'), JSON.stringify(definition));
  const identity = { batchId: definition.batchId, batchSha256: mixedAllocationHash(definition), version: 'mixed' };
  const request = { action: 'begin', deploymentId: definition.deploymentId, expectedRevision: 1, operationId: 'empty-' + '0'.repeat(32), batch: identity };
  assert.equal(emptyPoolRelease(identity.batchId, identity.batchSha256, definition.deploymentId).batchId, identity.batchId);
  assert.throws(() => emptyPoolRelease(identity.batchId, identity.batchSha256, 'unrelated'));
  assert.throws(() => emptyPoolRelease(identity.batchId, '0'.repeat(64), definition.deploymentId));
  let inspected = false;
  await emptyPoolMain(['inspect', '--bundle', directory, '--deployment-id', definition.deploymentId, '--operation-id', request.operationId, '--expected-revision', '1'], {
    transport: async input => { inspected = true; assert.equal(input.action, 'inspect');
      return { deploymentId: definition.deploymentId, operationId: request.operationId, phase: 'unstarted', complete: false,
        catalogRevision: 1, seeded: 0, total: 111111, fenceActive: false, retryAfterMs: 0 }; },
  });
  assert.ok(inspected);
  definition.groups[0].ownerCount = 1;
  assert.throws(() => emptyPoolRelease(identity.batchId, mixedAllocationHash(definition), definition.deploymentId), /future-only/);
});
