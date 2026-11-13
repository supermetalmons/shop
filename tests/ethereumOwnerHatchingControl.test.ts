import assert from 'node:assert/strict';
import test from 'node:test';
import { completeOwnerHatchingBatch, ownerHatchingControlMain, parseOwnerHatchingControlArgs,
  preflightOwnerHatchingMedia } from '../scripts/ops/ethereumOwnerHatchingControl.ts';
import { getOwnerHatchingGrail } from '../shared/ethereum/ownerHatchingCatalog.ts';
import type { OwnerHatchingMaintenanceRequest, OwnerHatchingMaintenanceResult } from '../shared/ethereum/ownerHatchingMaintenance.ts';
import type { EthereumRevealDeployment } from '../shared/ethereum/revealDeployment.ts';

const identity = ['--deployment-id', 'mainnet-v1', '--batch-id', 'drowee-first', '--expected-revision', '9'];
function status(change: Partial<OwnerHatchingMaintenanceResult> = {}): OwnerHatchingMaintenanceResult {
  return { deploymentId: 'mainnet-v1', batchId: 'drowee-first', phase: 'scanning', readyCount: 350, grailCount: 175,
    candidates: 0, scanned: 0, total: 400, staged: 0, activationChecked: 0, activationSelected: 0,
    published: 0, hatched: 0, retrying: 0, conflicts: 0,
    pendingEnrichment: 0, failedEnrichment: 0,
    retryAfterMs: 250, verificationCursor: null, observationUntilMs: null, complete: false, ...change };
}
const deployment: EthereumRevealDeployment = {
  deploymentId: 'mainnet-v1', dropId: '111k', chainId: 1, contractAddress: `0x${'11'.repeat(20)}`,
  metadataBaseUri: 'https://cdn.mons.shop/111k/', deploymentBlock: 1, catalogVersion: '111k-v8', templateJson: '{}',
  templateSha256: 'a'.repeat(64), state: 'active', revision: 9, createdAtMs: 0, updatedAtMs: 0,
  activatedAtMs: 0, provisionedAtMs: 0, lastError: null, effectiveCatalogVersion: '111k-v9',
  effectiveCatalogSha256: 'a7cf99fd2f9850a069ff9e69dfacdfb87249eeb0c4a8d5fcee1967da950974f1',
};

test('owner hatching CLI requires explicit writes and rejects ambiguous batch arguments', () => {
  assert.equal(parseOwnerHatchingControlArgs(['inspect', ...identity])?.command, 'inspect');
  assert.equal(parseOwnerHatchingControlArgs(['verify', ...identity, '--write'])?.command, 'verify');
  assert.equal(parseOwnerHatchingControlArgs(['refresh-activation', ...identity, '--write'])?.command, 'refresh-activation');
  assert.equal(parseOwnerHatchingControlArgs(['refresh-scan', ...identity, '--write'])?.command, 'refresh-scan');
  const apply = ['apply', ...identity, '--source', '/tmp/111k.json', '--fresh-egg-start', '60000', '--fresh-egg-count', '175', '--write'];
  assert.equal(parseOwnerHatchingControlArgs(apply)?.freshEggCount, 175);
  for (const args of [
    ['verify', ...identity], ['refresh-activation', ...identity], ['refresh-scan', ...identity], ['inspect', ...identity, '--write'], apply.slice(0, -1),
    [...apply, '--batch-id', 'changed'], [...apply, '--ready-count', '350.1'],
    ['status', ...identity, '--source', '/tmp/111k.json'], [...apply, '--fresh-egg-count', '0'],
  ]) assert.throws(() => parseOwnerHatchingControlArgs(args));
});

test('activation refresh preserves the frozen identity and does not restart apply', async () => {
  const calls: OwnerHatchingMaintenanceRequest[] = [];
  const expected = status({ phase: 'activating', scanned: 400, staged: 175 });
  const result = await ownerHatchingControlMain(['refresh-activation', ...identity, '--write'], {
    registry: async () => ({ ...deployment, revision: 11 }),
    readSource: async () => { throw new Error('Refresh must not import a new source.'); },
    fetch: async () => { throw new Error('Refresh must not republish media.'); },
    transport: async request => { calls.push(request); return expected; },
  });
  assert.deepEqual(calls, [{ action: 'refresh-activation', deploymentId: 'mainnet-v1', batchId: 'drowee-first', expectedRevision: 9 }]);
  assert.deepEqual(result, expected);
});

test('scan refresh keeps the original identity and returns the reset scan status', async () => {
  const calls: OwnerHatchingMaintenanceRequest[] = [];
  const expected = status();
  const result = await ownerHatchingControlMain(['refresh-scan', ...identity, '--write'], {
    registry: async () => ({ ...deployment, revision: 11 }),
    readSource: async () => { throw new Error('Refresh must not replace the frozen input.'); },
    transport: async request => { calls.push(request); return expected; },
  });
  assert.deepEqual(calls, [{ action: 'refresh-scan', deploymentId: 'mainnet-v1', batchId: 'drowee-first', expectedRevision: 9 }]);
  assert.deepEqual(result, expected);
});

test('status returns only aggregate fields and never triggers registry or mutation calls', async () => {
  const calls: OwnerHatchingMaintenanceRequest[] = [];
  const expected = status({ pendingEnrichment: 2, failedEnrichment: 1 });
  const result = await ownerHatchingControlMain(['inspect', ...identity], {
    registry: async () => { throw new Error('Registry should not be queried for status.'); },
    transport: async request => { calls.push(request); return { ...expected, assignments: [{ tokenId: 'secret' }] }; },
  });
  assert.deepEqual(calls.map(call => call.action), ['status']);
  assert.deepEqual(result, expected);
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('status requires numeric enrichment counts from maintenance transport', async () => {
  for (const field of ['pendingEnrichment', 'failedEnrichment'] as const) {
    for (const value of [undefined, -1, 0.5, '0']) {
      await assert.rejects(ownerHatchingControlMain(['status', ...identity], {
        transport: async () => ({ ...status(), [field]: value }) as OwnerHatchingMaintenanceResult,
      }), new RegExp(`invalid ${field}`));
    }
  }
});

test('mutation preflight rejects a non-mainnet deployment or unapproved source before beginning', async () => {
  let calls = 0;
  const transport = async () => { calls++; return status(); };
  await assert.rejects(ownerHatchingControlMain(['verify', ...identity, '--write'], {
    registry: async () => ({ ...deployment, chainId: 11155111 }), transport,
  }), /active mainnet deployment/);
  await assert.rejects(ownerHatchingControlMain(['apply', ...identity, '--source', '/tmp/111k.json',
    '--fresh-egg-start', '60000', '--fresh-egg-count', '175', '--write'], {
    registry: async () => deployment, readSource: async () => '{}', transport,
  }), /Source checksum/);
  assert.equal(calls, 0);
});

test('verification preserves the frozen revision after registry and catalog changes', async () => {
  const calls: OwnerHatchingMaintenanceRequest[] = [];
  const result = await ownerHatchingControlMain(['verify', ...identity, '--write'], {
    registry: async () => ({ ...deployment, revision: 11, catalogRevision: 2, effectiveCatalogVersion: '111k-v10' }),
    transport: async request => {
      calls.push(request);
      return status({ phase: 'complete', complete: true, published: 350 });
    },
  });
  assert.deepEqual(calls, [{ action: 'verify', deploymentId: 'mainnet-v1', batchId: 'drowee-first', expectedRevision: 9 }]);
  assert.equal(typeof result === 'object' && result.complete, true);
});

test('explicit verification rejects published base metadata with pending or failed traits', async () => {
  for (const complete of [false, true]) {
    for (const failedEnrichment of [0, 1]) {
      await assert.rejects(ownerHatchingControlMain(['verify', ...identity, '--write'], {
        registry: async () => deployment,
        transport: async () => status({ phase: complete ? 'complete' : 'publishing', complete, published: 350,
          verificationCursor: '175', pendingEnrichment: 1, failedEnrichment }),
        sleep: async () => { throw new Error('Pending traits must not advance the verification cursor.'); },
      }), failedEnrichment ? /failed trait enrichments/ : /enrichment is incomplete/);
    }
  }
});

test('resuming never overrides a pause or an in-progress catalog operation', async () => {
  for (const changed of [{ state: 'paused' as const }, { catalogUpdateId: 'another-batch' }]) {
    await assert.rejects(ownerHatchingControlMain(['verify', ...identity, '--write'], {
      registry: async () => ({ ...deployment, revision: 11, ...changed }),
      transport: async () => { throw new Error('Paused deployment must not receive a continuation.'); },
    }), /active mainnet deployment/);
  }
});

test('media preflight uses bounded HEAD requests and validates PNG, GIF, traits and fresh eggs', async () => {
  const calls: string[] = [];
  let active = 0, maximum = 0;
  const fetchSource: typeof fetch = async (input, options) => {
    active++; maximum = Math.max(maximum, active);
    assert.equal(options?.method, 'HEAD');
    assert.equal(options?.redirect, 'manual');
    assert.equal(new Headers(options?.headers).get('Origin'), 'https://vvv.so');
    assert.match(new Headers(options?.headers).get('User-Agent')!, /Mozilla/);
    const url = String(input); calls.push(url);
    await Promise.resolve(); active--;
    return new Response(null, { headers: { 'content-type': url.endsWith('.gif') ? 'image/gif'
      : url.endsWith('.json') ? 'application/json; charset=utf-8' : 'image/png', 'access-control-allow-origin': '*' } });
  };
  const result = await preflightOwnerHatchingMedia([getOwnerHatchingGrail('animated', 593)!], [60000, 60001], fetchSource);
  assert.deepEqual(result, { objects: 5 });
  assert.ok(calls.includes('https://cdn.lil.org/nft/111k/animated/593.gif'));
  assert.ok(calls.includes('https://cdn.lil.org/nft/111k/animated/json/v0/593.json'));
  assert.ok(calls.includes('https://cdn.lil.org/nft/111k/eggs/60000.png'));
  assert.ok(maximum <= 8);
  await assert.rejects(preflightOwnerHatchingMedia([getOwnerHatchingGrail('animated', 593)!], [], async () => new Response(null,
    { status: 404, headers: { 'content-type': 'image/gif', 'access-control-allow-origin': '*' } })), /media is unavailable/);
  await assert.rejects(preflightOwnerHatchingMedia([getOwnerHatchingGrail('animated', 593)!], [], async () => new Response(null,
    { headers: { 'content-type': 'video/mp4', 'access-control-allow-origin': '*' } })), /media is unavailable/);
});

test('apply completes scanning, staging, paged publication and a fresh verification after scheduler observation', async () => {
  let now = 0, verifies = 0, scans = 0, current = status();
  const calls: Array<{ action: string; at: number }> = [];
  const sleeps: number[] = [];
  const result = await completeOwnerHatchingBatch(current, async action => {
    calls.push({ action, at: now });
    if (action === 'scan') {
      scans++;
      current = status({ scanned: scans * 200, candidates: scans * 200, phase: scans === 2 ? 'staging' : 'scanning' });
    } else if (action === 'stage') current = { ...current, phase: 'prepared', staged: 175 };
    else if (action === 'activate') current = { ...current, phase: 'publishing' };
    else if (action === 'verify') {
      verifies++;
      current = { ...current, phase: verifies < 2 ? 'publishing' : 'observing', published: 350,
        verificationCursor: verifies % 2 ? '175' : null, observationUntilMs: 301_000 };
    } else if (action === 'complete') current = { ...current, phase: 'complete', complete: true };
    else assert.equal(action, 'status');
    return current;
  }, { now: () => now, sleep: async milliseconds => { sleeps.push(milliseconds); now += milliseconds; } });
  assert.equal(result.complete, true);
  assert.equal(calls.filter(call => call.action === 'activate').length, 1);
  assert.equal(verifies, 4);
  assert.ok(calls.findLast(call => call.action === 'verify')!.at >= 301_000);
  assert.ok(calls.find(call => call.action === 'complete')!.at >= 301_000);
  assert.ok(sleeps.every(milliseconds => milliseconds <= 30_000));
});

test('resuming an observing batch does not reselect, restage or activate it', async () => {
  const calls: string[] = [];
  const initial = status({ phase: 'observing', scanned: 400, candidates: 400, staged: 175, published: 350, observationUntilMs: 100 });
  const result = await completeOwnerHatchingBatch(initial, async action => {
    calls.push(action);
    return action === 'complete' ? { ...initial, phase: 'complete', complete: true } : initial;
  }, { now: () => 200, sleep: async () => {} });
  assert.equal(result.complete, true);
  assert.deepEqual(calls, ['verify', 'verify', 'complete']);
});

test('apply resumes bounded activation pages and exposes only aggregate progress', async () => {
  let activationCalls = 0;
  const progress: number[] = [];
  let current = status({ phase: 'activating', scanned: 10_000, total: 10_000, candidates: 10_000, staged: 175 });
  const result = await completeOwnerHatchingBatch(current, async action => {
    if (action === 'activate') {
      activationCalls++;
      const selected = Math.min(350, activationCalls * 100);
      progress.push(selected);
      current = { ...current, activationChecked: selected, activationSelected: selected,
        phase: selected === 350 ? 'publishing' : 'activating' };
    } else if (action === 'verify') {
      current = { ...current, phase: 'observing', published: 350, observationUntilMs: 1000 };
    } else if (action === 'complete') current = { ...current, phase: 'complete', complete: true };
    else assert.fail(`Unexpected continuation ${action}`);
    return current;
  }, { now: () => 2000, sleep: async () => {} });
  assert.deepEqual(progress, [100, 200, 300, 350]);
  assert.equal(result.complete, true);
  assert.equal(result.activationSelected, 350);
});

test('apply waits for healthy pending traits even after base metadata is fully published', async () => {
  const initial = status({ phase: 'observing', published: 350, pendingEnrichment: 1, observationUntilMs: 100 });
  const calls: string[] = [];
  let verifies = 0, pauses = 0;
  const result = await completeOwnerHatchingBatch(initial, async action => {
    calls.push(action);
    if (action === 'verify') return { ...initial, pendingEnrichment: ++verifies === 1 ? 1 : 0 };
    assert.equal(action, 'complete');
    return { ...initial, phase: 'complete', complete: true, pendingEnrichment: 0 };
  }, { now: () => 200, sleep: async () => { pauses++; } });
  assert.equal(result.complete, true);
  assert.equal(result.pendingEnrichment, 0);
  assert.deepEqual(calls, ['verify', 'verify', 'verify', 'complete']);
  assert.equal(pauses, 1);
});

test('apply rejects known failed traits and completed setups with unfinished traits', async () => {
  for (const complete of [false, true]) {
    await assert.rejects(completeOwnerHatchingBatch(status({ phase: complete ? 'complete' : 'publishing', complete,
      published: 350, pendingEnrichment: 1, failedEnrichment: 1 }), async () => {
      throw new Error('Failed traits require source recovery.');
    }), /failed trait enrichments/);
  }
  await assert.rejects(completeOwnerHatchingBatch(status({ phase: 'complete', complete: true,
    published: 350, pendingEnrichment: 1 }), async () => {
    throw new Error('Completed setup must keep its phase.');
  }), /enrichment is incomplete/);
});

test('insufficient candidates and metadata conflicts cannot report a completed batch', async () => {
  await assert.rejects(completeOwnerHatchingBatch(status({ scanned: 400, candidates: 349 }), async () => {
    throw new Error('No further mutation expected.');
  }), /Only 349 minted eggs/);
  await assert.rejects(completeOwnerHatchingBatch(status({ phase: 'publishing' }), async () => status({
    phase: 'publishing', conflicts: 1, published: 349,
  }), { sleep: async () => {} }), /publication conflicts/);
});
