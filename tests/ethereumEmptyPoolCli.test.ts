import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { buildRevealAssetCatalog } from '../scripts/ethereum-metadata/assetImport.ts';
import { buildRevealCatalogUpdateBatch } from '../scripts/ethereum-metadata/catalogUpdate.ts';
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
