import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { artistMetadataMain } from '../scripts/ops/ethereumArtistMetadata.ts';
import type { ArtistMetadataEvidence, ArtistMetadataPage, ArtistMetadataRequest } from '../shared/ethereum/artistMetadataMaintenance.ts';
import type { EthereumRevealDeployment } from '../shared/ethereum/revealDeployment.ts';

const hash = 'b'.repeat(64);
const deployment: EthereumRevealDeployment = {
  deploymentId: 'mainnet-v1', chainId: 1, dropId: '111k', contractAddress: `0x${'1'.repeat(40)}`,
  metadataBaseUri: 'https://cdn.mons.shop/111k/', deploymentBlock: 1, catalogVersion: '111k-v11', effectiveCatalogVersion: '111k-v11',
  effectiveCatalogSha256: hash, catalogRevision: 4, revision: 18, state: 'active', templateJson: '{}', templateSha256: hash,
  createdAtMs: 1, updatedAtMs: 1, provisionedAtMs: 1, activatedAtMs: 1, lastError: null,
};

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'artist-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const journal = join(root, 'operation.json');
  const evidence = join(root, 'evidence.jsonl');
  const shared = ['--deployment-id', 'mainnet-v1', '--journal', journal, '--page-size', '1', '--parallel', '4'];
  const start = async (command: 'apply' | 'verify', send: (request: ArtistMetadataRequest) => Promise<ArtistMetadataPage>, ...args: string[]) =>
    artistMetadataMain([command, ...shared, ...(command === 'apply' ? ['--write'] : []), ...args], { deployment: async () => deployment, send });
  return { journal, evidence, start };
}

function page(request: ArtistMetadataRequest, fields: Partial<ArtistMetadataPage> = {}): ArtistMetadataPage {
  return { action: request.action, scope: request.scope, started: true, next: null, scanned: 0, eggs: 0, credited: 0,
    published: 0, deferred: [], conflicts: [], records: [], frozenThroughMs: request.frozenThroughMs ?? request.scope.frozenThroughMs, ...fields };
}

function select(request: ArtistMetadataRequest, ids: string[]) {
  const candidates = ids.filter(id => id > (request.after ?? '')).slice(0, request.limit);
  return { candidates, next: candidates.length === request.limit ? candidates.at(-1)! : null };
}

test('parallel apply plans disjoint bursts, respects the page cap, and resumes deferred tokens', async t => {
  const f = fixture(t);
  const ids = ['1', '10', '11', '12', '2', '20'];
  const requests: ArtistMetadataRequest[] = [];
  const attempts = new Set<string>();
  const inFlight = new Set<string>();
  let concurrent = 0;
  const send = async (request: ArtistMetadataRequest) => {
    requests.push(request);
    if (request.action === 'inspect') return page(request);
    if (request.action === 'plan') {
      const { candidates, next } = select(request, ids);
      return page(request, { scanned: candidates.length, plannedTokenIds: candidates, next });
    }
    assert.equal(request.action, 'apply');
    const [id] = request.retryTokenIds ?? [];
    assert.ok(id && !inFlight.has(id));
    inFlight.add(id);
    concurrent = Math.max(concurrent, inFlight.size);
    await delay(5);
    inFlight.delete(id);
    if (['1', '10'].includes(id) && !attempts.has(id)) {
      attempts.add(id);
      return page(request, { scanned: 1, deferred: [id] });
    }
    return page(request, { scanned: 1, published: 1 });
  };
  const first = await f.start('apply', send, '--max-pages', '3');
  assert.ok('pages' in first);
  assert.equal(first.pages, 3);
  assert.equal(first.scanned, 3);
  assert.equal(first.deferred, 2);
  assert.equal(concurrent, 3);
  assert.equal(requests[1].action, 'plan');
  assert.equal(requests[1].limit, 3);
  const original = JSON.parse(readFileSync(f.journal, 'utf8'));
  assert.equal(original.after, '11');
  const second = await f.start('apply', send);
  assert.ok('pages' in second);
  assert.equal(second.pages, 5);
  assert.equal(second.scanned, 6);
  assert.equal(second.published, 6);
  assert.equal(second.deferred, 0);
  assert.equal(second.complete, true);
  assert.deepEqual(second.scope, original.scope);
  assert.deepEqual(requests.slice(-2).map(request => request.retryTokenIds), [['1'], ['10']]);
});

test('parallel apply drains sibling writes before an interrupted burst can release the journal', async t => {
  const f = fixture(t);
  const ids = ['1', '10', '11'];
  const completed = new Set<string>();
  let interrupt = true;
  const send = async (request: ArtistMetadataRequest) => {
    if (request.action === 'inspect') return page(request);
    if (request.action === 'plan') return page(request, { scanned: ids.length, plannedTokenIds: ids });
    const [id] = request.retryTokenIds!;
    if (interrupt && id === '10') throw new Error('Mock interrupted page.');
    await delay(20);
    completed.add(id);
    return page(request, { scanned: 1, published: 1 });
  };
  await assert.rejects(f.start('apply', send), /Mock interrupted page/);
  assert.deepEqual(completed, new Set(['1', '11']));
  const before = JSON.parse(readFileSync(f.journal, 'utf8'));
  assert.equal(before.after, null);
  assert.equal(before.counts.scanned, 0);
  interrupt = false;
  const resumed = await f.start('apply', send);
  assert.equal(resumed.complete, true);
  assert.equal(resumed.scanned, ids.length);
  assert.deepEqual(resumed.scope, before.scope);
});

test('parallel verification includes the requested later cutoff and merges retried evidence in cohort order', async t => {
  const f = fixture(t);
  await f.start('apply', async request => page(request, request.action === 'plan' ? { plannedTokenIds: [] } : {}));
  const requestedCutoff = Date.now() - 1;
  const ids = ['1', '10', '100', '11', '2', '20'];
  const attempted = new Set<string>();
  const record = (tokenId: string): ArtistMetadataEvidence => ({ tokenId, category: 'painting', assetId: 1,
    assignmentRevision: 1, metadataRevision: 3, metadataSha256: hash, frozenMetadataSha256: hash, nonAttributeSha256: hash,
    nonArtistSha256: hash, collectionBlock: 'plane of existence', artists: ['evil biscuit'] });
  const checked = await f.start('verify', async request => {
    assert.equal(request.frozenThroughMs, requestedCutoff);
    if (request.action === 'plan') {
      const { candidates, next } = select(request, ids);
      return page(request, { scanned: candidates.length, plannedTokenIds: candidates, next });
    }
    assert.equal(request.action, 'verify');
    const [id] = request.retryTokenIds!;
    if (id === '1' || id === '2') {
      if (!attempted.has(id)) {
        attempted.add(id);
        return page(request, { scanned: 1, deferred: [id] });
      }
    }
    await delay(id === '10' ? 10 : 1);
    return page(request, { scanned: 1, credited: 1, records: [record(id)] });
  }, '--frozen-through-ms', String(requestedCutoff), '--evidence', f.evidence);
  assert.equal(checked.complete, true);
  assert.equal(checked.scanned, ids.length);
  assert.equal(checked.credited, ids.length);
  assert.deepEqual(readFileSync(f.evidence, 'utf8').trim().split('\n').map(line => JSON.parse(line).tokenId), ids);
});
