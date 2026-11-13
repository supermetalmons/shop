import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { decodeReturn, encodeAbi, encodeCall } from '../../../../shared/ethereum/abi.ts';
import { ETHEREUM_FUNCTIONS } from '../../../../shared/ethereum/protocol.ts';
import { getRevealCatalog, getRevealCatalogDescriptor } from '../../../../shared/ethereum/revealCatalogRegistry.ts';
import { ownerHatchingCatalogSha256 } from '../../../../shared/ethereum/ownerHatchingCatalog.ts';
import supplement from '../../../../shared/ethereum/ownerHatchingCatalog.json';
import { parseOwnerHatchingMaintenanceRequest, type OwnerHatchingMaintenanceRequest } from '../../../../shared/ethereum/ownerHatchingMaintenance.ts';
import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.ts';
import { EthereumOwnerHatchingOperations } from '../src/ethereumOwnerHatchingOperations.ts';
import type { EthereumRevealStore, RevealSql } from '../src/ethereumRevealStore.ts';
import type { OwnerHatchingBatchInput } from '../src/ethereumOwnerHatchingStore.ts';

const descriptor = getRevealCatalogDescriptor('111k-v9')!;
const deployment: EthereumRevealDeployment = {
  deploymentId: 'mainnet-operations-test', dropId: '111k', chainId: 1, contractAddress: `0x${'11'.repeat(20)}`,
  metadataBaseUri: 'https://cdn.mons.shop/111k/', deploymentBlock: 100, catalogVersion: '111k-v8', templateJson: '{}',
  templateSha256: '0'.repeat(64), state: 'active', revision: 9, createdAtMs: 0, updatedAtMs: 0,
  activatedAtMs: 0, provisionedAtMs: 0, lastError: null, effectiveCatalogVersion: descriptor.catalogVersion,
  effectiveCatalogSha256: descriptor.manifestSha256,
};
const begin: OwnerHatchingMaintenanceRequest = {
  action: 'begin', deploymentId: deployment.deploymentId, batchId: 'drowee-fixture', expectedRevision: 9,
  sourceSha256: supplement.batches[0].source.sha256, catalogSha256: ownerHatchingCatalogSha256,
  readyCount: 18, grailIds: Array.from({ length: 9 }, (_, index) => 422 + index),
  freshEggIds: Array.from({ length: 9 }, (_, index) => 55304 + index),
};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const blockHash = (block: number) => `0x${block.toString(16).padStart(64, '0')}`;
const OWNER = `0x${'22'.repeat(20)}`;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

function fixture(t: TestContext, overrides: Partial<OwnerHatchingMaintenanceRequest> = {}) {
  const request = { ...begin, ...overrides };
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys=ON');
  database.exec(`CREATE TABLE assignments(id INTEGER PRIMARY KEY);
    CREATE TABLE owner_hatching_tokens(batch_id TEXT,token_id TEXT PRIMARY KEY,grail_asset_id INTEGER,status TEXT);
    CREATE TABLE owner_hatching_grails(batch_id TEXT,asset_id INTEGER PRIMARY KEY);
    CREATE TABLE owner_hatching_fresh_eggs(batch_id TEXT,egg_id INTEGER PRIMARY KEY,token_id TEXT);
    CREATE TABLE owner_hatching_retired_eggs(token_id TEXT PRIMARY KEY);
    CREATE TABLE owner_hatching_artwork_claims(token_id TEXT PRIMARY KEY)`);
  t.after(() => database.close());
  const sql: RevealSql = { exec(query, ...bindings) {
    const statement = database.prepare(query);
    const parameters = bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    const rows = statement.columns().length ? statement.all(...parameters) : (statement.run(...parameters), []);
    return { toArray: () => rows as never[] };
  } };
  let depth = 0;
  const transaction = <T>(action: () => T): T => {
    if (depth) return action();
    database.exec('BEGIN IMMEDIATE'); depth++;
    try { const result = action(); database.exec('COMMIT'); return result; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
    finally { depth--; }
  };
  const state = {
    now: 1_000_000, head: 500, minted: 240, catalogRevision: 1, registryRevision: 9, recover: true, current: true,
    published: 0, conflicts: 0, pendingEnrichment: 0, failedEnrichment: 0, prepareCalls: 0, wakeCalls: 0, requireCalls: 0, assigned: 0,
    traitsFail: false, malformedTraits: false, missingObject: false, badObject: false, badHeaders: false, oversized: false,
    reorg: false, conservation: true, revisionChanged: false, r2Gate: null as Promise<void> | null,
    missing: new Set<string>(), nonEgg: new Set<string>(), protected: new Set<number>(), claimed: new Set<string>(),
    randomCalls: 0, rpcCalls: 0, tokenFailure: null as Error | null, snapshotFailure: null as Error | null,
    canonicalHashes: new Map<number, string>(),
    tokenCalls: [] as Array<{ ids: string[]; block: unknown }>, recovered: [] as string[][], traitIds: [] as number[], objectReads: [] as string[],
    prepared: null as OwnerHatchingBatchInput | null,
  };
  const revisions = new Map<string, number>();
  const metadata = (tokenId: string) => JSON.stringify({ name: tokenId, readyToHatch: true, metadataRevision: revisions.get(tokenId) ?? 1 });
  const owner = {
    reservedGrail: () => false,
    hasProtectedEgg: (id: number) => state.protected.has(id),
    batchStatus: (batchId: string) => state.prepared?.batchId === batchId ? { readyCount: state.prepared.readyCount, published: state.published, hatched: 0,
      pendingPublication: state.prepared.readyCount - state.published, conflicts: state.conflicts,
      pendingEnrichment: state.pendingEnrichment, failedEnrichment: state.failedEnrichment } : null,
    canonical: (tokenId: string) => ({ targetSha256: digest(metadata(tokenId)), metadataRevision: revisions.get(tokenId) ?? 1 }),
    eligibleCandidate: (tokenId: string) => !state.nonEgg.has(tokenId) && !state.protected.has(Number(tokenId)) &&
      !state.claimed.has(tokenId) && !database.prepare('SELECT 1 FROM owner_hatching_tokens WHERE token_id=?').get(tokenId),
    prepare: (input: OwnerHatchingBatchInput) => {
      state.prepareCalls++;
      assert.equal(input.candidateTokenIds.length, input.readyCount);
      assert.ok(input.candidateTokenIds.every(id => owner.eligibleCandidate(id)));
      assert.equal(input.grails.length, request.grailIds!.length);
      for (const [index, id] of input.candidateTokenIds.slice(0, input.readyCount).entries()) {
        database.prepare("INSERT INTO owner_hatching_tokens(batch_id,token_id,grail_asset_id,status) VALUES(?,?,?,'ready')")
          .run(input.batchId, id, input.grails[index]?.assetId ?? null);
      }
      for (const grail of input.grails) database.prepare('INSERT INTO owner_hatching_grails(batch_id,asset_id) VALUES(?,?)').run(input.batchId, grail.assetId);
      for (const eggId of input.freshEggIds) database.prepare('INSERT INTO owner_hatching_fresh_eggs(batch_id,egg_id) VALUES(?,?)').run(input.batchId, eggId);
      state.prepared = structuredClone(input);
    },
  };
  const store = { catalogUpdate: {
    ownerHatching: owner,
    effectiveCatalog: () => ({ ...descriptor, generation: 'mainnet-v9-generation', catalogRevision: state.catalogRevision }),
    activeCatalog: () => getRevealCatalog('111k-v9'),
    freshOwnerEggAvailable: (id: number) => id >= 55304 && id <= 76700,
    canonicalMetadata: (tokenIds: string[]) => tokenIds.map(tokenId => ({ tokenId, assetId: Number(tokenId),
      category: state.nonEgg.has(tokenId) ? 'painting' : 'egg' })),
    pools: () => [{ available: 111111 - state.assigned - (state.conservation ? 0 : 1), total: 111111 }],
  } } as unknown as EthereumRevealStore;
  const env = { ALCHEMY_MI_NOTE_API_KEY: 'fixture', ETHEREUM_PROVIDER_CONTROL_ENABLED: 'false',
    ETHEREUM_REVEAL_METADATA: { async get(key: string) {
      const tokenId = /\/(\d+)\.json$/.exec(key)![1];
      state.objectReads.push(tokenId);
      if (state.missingObject) return null;
      const body = state.badObject ? '{}' : metadata(tokenId);
      if (state.r2Gate) await state.r2Gate;
      if (state.revisionChanged) { revisions.set(tokenId, (revisions.get(tokenId) ?? 1) + 1); state.revisionChanged = false; }
      return { size: state.oversized ? 300_000 : Buffer.byteLength(body),
        httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: state.badHeaders ? 'public' : 'no-store' },
        async text() { return body; } };
    } },
  } as unknown as Env;
  const reopen = () => new EthereumOwnerHatchingOperations({ env, sql, store, transaction,
    randomInteger: maximum => state.randomCalls++ % maximum,
    recover: async tokenIds => { state.recovered.push(tokenIds); return state.recover; },
    requireCurrent: async expectedRevision => {
      state.requireCalls++;
      if (!state.current || expectedRevision !== undefined && expectedRevision !== state.registryRevision) throw new Error('Registry revision changed.');
    },
    wake: async () => { state.wakeCalls++; },
  });
  let operations = reopen();
  t.mock.method(Date, 'now', () => state.now);
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith('https://cdn.lil.org/')) {
      const id = Number(/\/(\d+)\.json$/.exec(String(input))![1]); state.traitIds.push(id);
      if (state.traitsFail) return new Response(null, { status: 503 });
      return Response.json(state.malformedTraits ? { attributes: [] } : { 'collection block': 'DROWEE', attributes: [{ trait_type: 'id', value: id }] });
    }
    const payload = JSON.parse(String(init?.body));
    state.rpcCalls++;
    const respond = ({ id, method, params }: { id: number; method: string; params: unknown[] }) => {
      let result: unknown;
      if (method === 'eth_chainId') result = '0x1';
      else if (method === 'eth_getBlockByNumber') {
        if (params[0] === 'latest' && state.snapshotFailure) throw state.snapshotFailure;
        const block = params[0] === 'latest' ? state.head : Number(BigInt(String(params[0])));
        result = { number: `0x${block.toString(16)}`, hash: state.canonicalHashes.get(block) ??
          blockHash(state.reorg && params[0] !== 'latest' ? block + 1 : block) };
      } else if (method === 'eth_call') {
        const data = (params[0] as { data: string }).data;
        if (data.slice(0, 10) === encodeCall(ETHEREUM_FUNCTIONS.stats, [], [])) {
          result = encodeAbi(['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bool', 'bytes32', 'uint256',
            'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
          [Math.ceil(state.minted / 20), 0, state.minted, 1, 1, true, `0x${'0'.repeat(64)}`, 1, 1, 0, 0, 0, 0, 0, 0]);
        } else {
          assert.equal(data.slice(0, 10), encodeCall(ETHEREUM_FUNCTIONS.tokenInfos, [], []));
          const [ids] = decodeReturn(['uint256[]'], `0x${data.slice(10)}`) as [bigint[]];
          state.tokenCalls.push({ ids: ids.map(String), block: params[1] });
          if (state.tokenFailure) throw state.tokenFailure;
          result = encodeAbi(['(uint8,uint256,address)[]'], [ids.map(tokenId => state.missing.has(String(tokenId))
            ? [0, 0, ZERO_ADDRESS] : [1, tokenId, OWNER])]);
        }
      } else throw new Error(`Unexpected RPC: ${method}`);
      return { jsonrpc: '2.0', id, result };
    };
    return Response.json(Array.isArray(payload) ? payload.map(respond) : respond(payload));
  });
  const run = (action: OwnerHatchingMaintenanceRequest['action'], overrides: Partial<OwnerHatchingMaintenanceRequest> = {}) => operations.run(deployment,
    parseOwnerHatchingMaintenanceRequest(action === 'begin' ? { ...request, ...overrides } : { action, deploymentId: request.deploymentId,
      batchId: request.batchId, expectedRevision: request.expectedRevision, ...overrides }));
  const prepared = async () => {
    await run('begin');
    let result = await run('status');
    while (result.phase === 'scanning') result = await run('scan');
    while (result.phase === 'staging') result = await run('stage');
    return result;
  };
  const finishActivation = async () => {
    let result = await run('status');
    while (result.phase === 'prepared' || result.phase === 'activating') result = await run('activate');
    return result;
  };
  const activate = async () => { await prepared(); return finishActivation(); };
  const complete = async () => {
    await activate();
    state.published = request.readyCount!;
    while ((await run('verify')).verificationCursor !== null) {}
    state.now += 300_000;
    while ((await run('verify')).verificationCursor !== null) {}
    return run('complete');
  };
  return { state, database, run, prepared, activate, finishActivation, complete, reopen: () => { operations = reopen(); },
    row: () => database.prepare('SELECT * FROM owner_hatching_preparations WHERE batch_id=?').get(request.batchId)!,
    activation: () => database.prepare('SELECT * FROM owner_hatching_activation WHERE batch_id=?').get(request.batchId)!,
    draws: () => database.prepare('SELECT position,token_id,live FROM owner_hatching_activation_candidates WHERE batch_id=? ORDER BY position')
      .all(request.batchId).map(row => ({ ...row })),
    evidence: () => Object.fromEntries(['owner_hatching_preparations', 'owner_hatching_candidates', 'owner_hatching_trait_staging',
      'owner_hatching_activation', 'owner_hatching_activation_candidates', 'owner_hatching_tokens', 'owner_hatching_grails',
      'owner_hatching_fresh_eggs'].map(table => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])),
    count: (table: string) => Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count) };
}

function holdNextRpc(t: TestContext, method = 'eth_call') {
  const originalFetch = globalThis.fetch;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  t.after(() => release());
  let hold = true;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body));
    const rows = Array.isArray(payload) ? payload : [payload];
    const defer = hold && rows.some((row: { method: string }) => row.method === method);
    if (defer) hold = false;
    const response = await originalFetch(input, init);
    if (defer) { entered(); await gate; }
    return response;
  });
  return { started, release };
}

const cohort = (readyCount: number) => ({ readyCount,
  freshEggIds: Array.from({ length: readyCount - begin.grailIds!.length }, (_, index) => 55304 + index) });

test('owner hatching maintenance parsing accepts exact identities and rejects malformed or secret-bearing inputs', () => {
  assert.deepEqual(parseOwnerHatchingMaintenanceRequest(begin), begin);
  for (const value of [null, [], { ...begin, privateMapping: {} }, { ...begin, expectedRevision: 0 },
    { ...begin, grailIds: [422, 422] }, { ...begin, freshEggIds: [1.5] }, { ...begin, readyCount: 2001 },
    { ...begin, action: 'status' }, { ...begin, sourceSha256: 'not-a-hash' }]) {
    assert.throws(() => parseOwnerHatchingMaintenanceRequest(value));
  }
});

test('snapshot scanning pages every minted token and includes only unprotected current eggs', async t => {
  const f = fixture(t);
  f.state.nonEgg.add('2'); f.state.protected.add(3); f.state.missing.add('4');
  await f.run('begin');
  f.state.head = 501; f.state.minted = 260;
  let result = await f.run('scan');
  assert.equal(result.scanned, 100);
  f.reopen();
  result = await f.run('scan');
  assert.equal(result.scanned, 200);
  result = await f.run('scan');
  assert.equal(result.total, 240);
  assert.equal(result.scanned, 240);
  assert.equal(result.candidates, 237);
  assert.equal(result.phase, 'staging');
  assert.deepEqual(f.state.tokenCalls.map(call => [call.ids[0], call.ids.at(-1)]), [['1', '100'], ['101', '200'], ['201', '240']]);
  assert.ok(f.state.tokenCalls.every(call => JSON.stringify(call.block) === JSON.stringify({ blockHash: blockHash(500), requireCanonical: true })));
  assert.ok(f.state.recovered.flat().every(id => id !== '4'));
  assert.deepEqual(Object.keys(result).sort(), ['deploymentId', 'batchId', 'phase', 'readyCount', 'grailCount', 'candidates', 'scanned',
    'total', 'staged', 'activationChecked', 'activationSelected', 'published', 'hatched', 'retrying', 'conflicts', 'pendingEnrichment', 'failedEnrichment', 'retryAfterMs',
    'verificationCursor', 'observationUntilMs', 'complete'].sort());
  assert.ok(!JSON.stringify(result).includes('candidateTokenIds'));
  assert.ok(!JSON.stringify(result).includes('grailIds'));
});

test('pending recovery, a reorg and a registry change cannot advance the frozen scan', async t => {
  const f = fixture(t);
  await f.run('begin');
  f.state.recover = false;
  assert.equal((await f.run('scan')).scanned, 0);
  assert.equal(f.count('owner_hatching_candidates'), 0);
  f.state.recover = true; f.state.reorg = true;
  await assert.rejects(f.run('scan'), /Ethereum changed/);
  assert.equal(f.row().scanned, 0);
  f.state.reorg = false; f.state.current = false;
  await assert.rejects(f.run('scan'), /Registry revision/);
  assert.equal(f.row().scanned, 0);
  f.state.current = true;
  assert.equal((await f.run('scan')).scanned, 100);
});

test('explicit scan refresh recovers a permanent reorg and rebuilds candidates before completing the original batch', async t => {
  const f = fixture(t, cohort(150));
  await f.run('begin');
  assert.equal((await f.run('scan')).scanned, 100);
  const original = f.row();
  f.state.canonicalHashes.set(500, blockHash(1500));
  f.state.head = 501;
  f.state.minted = 360;
  f.state.nonEgg.add('1');
  await assert.rejects(f.run('scan'), /Ethereum changed/);
  f.reopen();
  await assert.rejects(f.run('scan'), /Ethereum changed/);
  const refreshed = await f.run('refresh-scan');
  assert.equal(refreshed.phase, 'scanning');
  assert.equal(refreshed.scanned, 0);
  assert.equal(refreshed.candidates, 0);
  assert.equal(refreshed.total, 360);
  assert.equal(f.count('owner_hatching_candidates'), 0);
  assert.equal(f.count('owner_hatching_trait_staging'), 0);
  assert.equal(f.count('owner_hatching_activation'), 0);
  assert.equal(f.state.randomCalls, 0);
  assert.equal(f.state.prepareCalls, 0);
  assert.equal(f.state.wakeCalls, 0);
  assert.deepEqual({ ...f.row() }, { ...original, block_number: 501, block_hash: blockHash(501), total: 360, scanned: 0, candidates: 0 });
  f.reopen();
  assert.deepEqual(await f.run('begin'), refreshed);
  const calls = f.state.tokenCalls.length;
  const rescanned = await f.run('scan');
  assert.equal(rescanned.scanned, 100);
  assert.equal(rescanned.candidates, 99);
  assert.deepEqual(f.state.tokenCalls[calls].ids, Array.from({ length: 100 }, (_, index) => String(index + 1)));
  assert.deepEqual(f.state.tokenCalls[calls].block, { blockHash: blockHash(501), requireCanonical: true });
  assert.equal((await f.complete()).complete, true);
  assert.equal(f.state.prepared!.batchId, begin.batchId);
  assert.ok(!f.state.prepared!.candidateTokenIds.includes('1'));
  assert.equal(f.state.canonicalHashes.get(500), blockHash(1500));
  assert.equal(f.row().request_json, original.request_json);
  assert.equal(f.count('owner_hatching_candidates'), 0);
});

for (const failure of ['rpc', 'canonical', 'registry', 'catalog'] as const) {
  test(`a ${failure} failure during scan refresh preserves the frozen scan`, async t => {
    const f = fixture(t);
    await f.run('begin');
    await f.run('scan');
    const evidence = f.evidence();
    f.state.head++;
    if (failure === 'rpc') {
      f.state.snapshotFailure = new Error('Injected scan refresh snapshot failure.');
      await assert.rejects(f.run('refresh-scan'));
    } else {
      const gate = holdNextRpc(t, 'eth_getBlockByNumber');
      const delayed = f.run('refresh-scan');
      await gate.started;
      if (failure === 'canonical') f.state.canonicalHashes.set(f.state.head, blockHash(f.state.head + 1000));
      if (failure === 'registry') f.state.current = false;
      if (failure === 'catalog') f.state.catalogRevision++;
      gate.release();
      await assert.rejects(delayed, failure === 'canonical' ? /Ethereum changed/ : failure === 'registry' ? /Registry revision/ : /catalog changed/);
    }
    assert.deepEqual(f.evidence(), evidence);
    assert.equal(f.state.randomCalls, 0);
    assert.equal(f.state.prepareCalls, 0);
    assert.equal(f.state.wakeCalls, 0);
  });
}

for (const concurrent of ['scan', 'refresh-scan'] as const) {
  test(`scan refresh cannot erase a concurrently committed ${concurrent}`, async t => {
    const f = fixture(t);
    await f.run('begin');
    await f.run('scan');
    f.state.head++;
    const gate = holdNextRpc(t, 'eth_getBlockByNumber');
    const delayed = f.run('refresh-scan');
    await gate.started;
    f.state.head++;
    await f.run(concurrent);
    const evidence = f.evidence();
    gate.release();
    await assert.rejects(delayed, /Scan changed while refreshing/);
    assert.deepEqual(f.evidence(), evidence);
    assert.equal(f.state.randomCalls, 0);
  });
}

test('a scan callback from the old block cannot advance a refreshed snapshot at the same cursor', async t => {
  const f = fixture(t);
  await f.run('begin');
  const gate = holdNextRpc(t);
  const delayed = f.run('scan');
  await gate.started;
  f.state.head++;
  const refreshed = await f.run('refresh-scan');
  const evidence = f.evidence();
  gate.release();
  assert.deepEqual(await delayed, refreshed);
  assert.deepEqual(f.evidence(), evidence);
  assert.equal((await f.run('scan')).scanned, 100);
  assert.equal(f.state.randomCalls, 0);
});

for (const phase of ['staging', 'prepared', 'activating', 'publishing', 'observing', 'complete', 'allocated-scanning'] as const) {
  test(`scan refresh rejects ${phase} batches without changing evidence or reading Ethereum`, async t => {
    const f = fixture(t);
    if (phase === 'staging') {
      await f.run('begin');
      while ((await f.run('scan')).phase === 'scanning') {}
    } else if (phase === 'prepared' || phase === 'activating') {
      await f.prepared();
      if (phase === 'activating') await f.run('activate');
    } else if (phase === 'complete') await f.complete();
    else {
      await f.activate();
      if (phase === 'observing') {
        f.state.published = begin.readyCount!;
        while ((await f.run('verify')).verificationCursor !== null) {}
      } else if (phase === 'allocated-scanning') {
        f.database.prepare("UPDATE owner_hatching_preparations SET phase='scanning' WHERE batch_id=?").run(begin.batchId);
      }
    }
    const evidence = f.evidence(), rpcCalls = f.state.rpcCalls, randomCalls = f.state.randomCalls;
    await assert.rejects(f.run('refresh-scan'), /unfinished scan/);
    assert.deepEqual(f.evidence(), evidence);
    assert.equal(f.state.rpcCalls, rpcCalls);
    assert.equal(f.state.randomCalls, randomCalls);
  });
}

test('a frozen batch resumes after additive catalog support changes without changing its original evidence', async t => {
  const f = fixture(t);
  await f.run('begin');
  const frozen = JSON.parse(String(f.row().request_json)) as OwnerHatchingMaintenanceRequest;
  frozen.catalogSha256 = 'b'.repeat(64);
  f.database.prepare('UPDATE owner_hatching_preparations SET request_json=? WHERE batch_id=?').run(JSON.stringify(frozen), begin.batchId);
  const replayed = await f.run('begin');
  assert.equal(replayed.scanned, 0);
  assert.equal(JSON.parse(String(f.row().request_json)).catalogSha256, frozen.catalogSha256);
  await assert.rejects(f.run('begin', { catalogSha256: 'c'.repeat(64) }), /inputs changed/);
  await assert.rejects(f.run('begin', { expectedRevision: 10 }), /inputs changed/);
});

test('new batches enforce the registry revision while frozen batches retain their original identity', async t => {
  const f = fixture(t);
  f.state.registryRevision++;
  await assert.rejects(f.run('begin'), /Registry revision/);
  assert.equal(f.count('owner_hatching_preparations'), 0);
  f.state.registryRevision--;
  await f.run('begin');
  f.state.registryRevision++;
  await f.run('begin');
  assert.equal((await f.run('scan')).scanned, 100);
  assert.equal(JSON.parse(String(f.row().request_json)).expectedRevision, begin.expectedRevision);
  await assert.rejects(f.run('scan', { expectedRevision: f.state.registryRevision }), /original operation identity/);
});

test('staging retries traits without partial pages and activation rechecks minting exactly once', async t => {
  const f = fixture(t);
  await f.run('begin');
  while ((await f.run('scan')).phase === 'scanning') {}
  f.state.traitsFail = true;
  await assert.rejects(f.run('stage'), /Trait source returned HTTP 503/);
  assert.equal(f.count('owner_hatching_trait_staging'), 0);
  f.state.traitsFail = false;
  assert.equal((await f.run('stage')).staged, 8);
  f.reopen();
  assert.equal((await f.run('stage')).phase, 'prepared');
  const traitRequests = f.state.traitIds.length;
  await f.run('stage');
  assert.equal(f.state.traitIds.length, traitRequests);
  f.state.missing.add('1'); f.state.head = 502;
  const scanCalls = f.state.tokenCalls.length;
  assert.equal((await f.run('activate')).phase, 'activating');
  assert.equal(f.state.tokenCalls.length, scanCalls);
  const result = await f.finishActivation();
  assert.equal(result.phase, 'publishing');
  assert.ok(!f.state.prepared!.candidateTokenIds.includes('1'));
  assert.ok(f.state.tokenCalls.slice(scanCalls).every(call => JSON.stringify(call.block) === JSON.stringify({ blockHash: blockHash(502), requireCanonical: true })));
  f.reopen();
  await f.run('activate');
  assert.equal(f.state.prepareCalls, 1);
  assert.equal(f.state.wakeCalls, 1);
  await assert.rejects(f.run('begin', { sourceSha256: 'f'.repeat(64) }), /inputs changed/);
});

test('activation selects 350 eggs from 10000 candidates with at most 100 token checks per call', async t => {
  const f = fixture(t, cohort(350));
  f.state.minted = 10_000;
  await f.prepared();
  f.state.tokenCalls.length = 0;
  f.state.head = 502;
  const initialized = await f.run('activate');
  assert.equal(initialized.phase, 'activating');
  assert.equal(initialized.activationChecked, 0);
  assert.equal(initialized.activationSelected, 0);
  assert.equal(f.state.randomCalls, 0);
  assert.equal(f.state.tokenCalls.length, 0);
  const progress: number[] = [];
  for (;;) {
    const before = f.state.tokenCalls.length;
    const result = await f.run('activate');
    const page = f.state.tokenCalls.slice(before);
    assert.equal(page.length, 1);
    assert.ok(page[0].ids.length <= 100);
    assert.equal(result.activationSelected, result.activationChecked);
    progress.push(result.activationChecked);
    if (result.phase === 'publishing') break;
    assert.equal(result.phase, 'activating');
    assert.equal(f.state.prepareCalls, 0);
    assert.equal(f.count('owner_hatching_tokens'), 0);
    f.state.head++;
    f.reopen();
  }
  assert.deepEqual(progress, [100, 200, 300, 350]);
  const checked = f.state.tokenCalls.flatMap(call => call.ids);
  assert.equal(checked.length, 350);
  assert.equal(new Set(checked).size, 350);
  assert.ok(f.state.tokenCalls.every(call => JSON.stringify(call.block) === JSON.stringify({ blockHash: blockHash(502), requireCanonical: true })));
  assert.deepEqual(f.state.prepared!.candidateTokenIds, checked);
  assert.equal(f.state.randomCalls, 350);
  assert.equal(f.state.prepareCalls, 1);
  assert.equal(f.state.wakeCalls, 1);
});

for (const failure of [new Error('Injected RPC failure.'), new DOMException('Injected RPC timeout.', 'TimeoutError')]) {
  test(`activation resumes its exact private page after ${failure.name} and restart`, async t => {
    const f = fixture(t, cohort(150));
    await f.prepared();
    await f.run('activate');
    f.state.tokenCalls.length = 0;
    f.state.tokenFailure = failure;
    await assert.rejects(f.run('activate'));
    const pending = f.draws();
    assert.equal(pending.length, 100);
    assert.ok(pending.every(row => row.live === null));
    assert.equal(f.activation().checked, 0);
    assert.equal(f.activation().selected, 0);
    assert.equal(f.state.prepareCalls, 0);
    const draws = f.state.randomCalls;
    f.reopen();
    f.state.tokenFailure = null;
    f.state.head++;
    const result = await f.run('activate');
    assert.equal(result.activationChecked, 100);
    assert.equal(result.activationSelected, 100);
    assert.equal(f.state.randomCalls, draws);
    assert.equal(f.state.tokenCalls.length, 2);
    assert.deepEqual(f.state.tokenCalls[0], f.state.tokenCalls[1]);
    assert.deepEqual(f.draws(), pending.map(row => ({ ...row, live: 1 })));
    assert.equal((await f.finishActivation()).phase, 'publishing');
  });
}

test('activation excludes burned, changed, protected, claimed and already selected eggs', async t => {
  const f = fixture(t);
  await f.prepared();
  f.state.missing.add('1');
  f.state.nonEgg.add('2');
  f.state.protected.add(3);
  f.state.claimed.add('4');
  f.database.prepare("INSERT INTO owner_hatching_tokens(batch_id,token_id,status) VALUES('previous','5','ready')").run();
  await f.run('activate');
  const first = await f.run('activate');
  assert.equal(first.activationChecked, 18);
  assert.equal(first.activationSelected, 13);
  assert.equal(first.phase, 'activating');
  assert.equal(f.state.prepareCalls, 0);
  assert.equal(f.draws()[0].live, 0);
  const result = await f.finishActivation();
  assert.equal(result.activationChecked, 23);
  assert.equal(result.activationSelected, 18);
  assert.equal(result.phase, 'publishing');
  assert.ok(f.state.prepared!.candidateTokenIds.every(id => !['1', '2', '3', '4', '5'].includes(id)));
});

test('a claim arriving during a later activation page refills an earlier selection before allocation', async t => {
  const f = fixture(t, cohort(150));
  await f.prepared();
  await f.run('activate');
  assert.equal((await f.run('activate')).activationSelected, 100);
  const gate = holdNextRpc(t);
  const later = f.run('activate');
  await gate.started;
  const claimed = f.draws().filter(row => row.live === 1).slice(0, 10).map(row => String(row.token_id));
  for (const tokenId of claimed) f.state.claimed.add(tokenId);
  gate.release();
  const rechecked = await later;
  assert.equal(rechecked.phase, 'activating');
  assert.equal(rechecked.activationChecked, 150);
  assert.equal(rechecked.activationSelected, 140);
  assert.equal(f.state.prepareCalls, 0);
  assert.equal((await f.finishActivation()).activationChecked, 160);
  assert.ok(f.state.prepared!.candidateTokenIds.every(id => !claimed.includes(id)));
});

test('exhausted activation retains its checked evidence without partially allocating or redrawing', async t => {
  const f = fixture(t, cohort(150));
  f.state.minted = 160;
  await f.prepared();
  await f.run('activate');
  await f.run('activate');
  const claimed = f.draws().slice(0, 20).map(row => String(row.token_id));
  for (const tokenId of claimed) f.state.claimed.add(tokenId);
  const result = await f.run('activate');
  assert.equal(result.activationChecked, 160);
  assert.equal(result.activationSelected, 140);
  const evidence = f.draws();
  const calls = f.state.rpcCalls, randomCalls = f.state.randomCalls;
  f.reopen();
  await assert.rejects(f.run('activate'), /Not enough eligible minted eggs remain/);
  assert.deepEqual(f.draws(), evidence);
  assert.equal(f.state.rpcCalls, calls);
  assert.equal(f.state.randomCalls, randomCalls);
  assert.equal(f.state.prepareCalls, 0);
  assert.equal(f.count('owner_hatching_tokens'), 0);
  assert.equal(f.count('owner_hatching_grails'), 0);
  for (const tokenId of claimed) f.state.claimed.delete(tokenId);
  assert.equal((await f.run('activate')).phase, 'publishing');
  assert.equal(f.state.tokenCalls.length, 4);
  assert.equal(f.state.randomCalls, randomCalls);
});

test('reorg and catalog or registry changes cannot advance a pending activation page', async t => {
  const f = fixture(t, cohort(150));
  await f.prepared();
  await f.run('activate');
  f.state.reorg = true;
  await assert.rejects(f.run('activate'), /Ethereum changed/);
  const pending = f.draws(), activation = f.activation();
  assert.equal(activation.checked, 0);
  f.state.reorg = false;
  f.state.current = false;
  await assert.rejects(f.run('activate'), /Registry revision/);
  f.state.current = true;
  f.state.catalogRevision++;
  await assert.rejects(f.run('activate'), /catalog changed/);
  f.state.catalogRevision--;
  assert.deepEqual(f.draws(), pending);
  assert.deepEqual(f.activation(), activation);
  const gate = holdNextRpc(t);
  const delayed = f.run('activate');
  await gate.started;
  f.state.catalogRevision++;
  gate.release();
  await assert.rejects(delayed, /catalog changed/);
  assert.deepEqual(f.draws(), pending);
  assert.deepEqual(f.activation(), activation);
  assert.equal(f.state.prepareCalls, 0);
});

test('explicit activation refresh recovers a permanent reorg at 100 of 150 without replacing private draws', async t => {
  const f = fixture(t, cohort(150));
  await f.prepared();
  f.state.head = 502;
  await f.run('activate');
  assert.equal((await f.run('activate')).activationChecked, 100);
  f.state.canonicalHashes.set(502, blockHash(1502));
  f.state.head = 503;
  await assert.rejects(f.run('activate'), /Ethereum changed/);
  const pending = f.draws(), activation = f.activation(), preparation = f.row();
  const staged = f.evidence().owner_hatching_trait_staging;
  assert.equal(pending.length, 150);
  assert.equal(activation.checked, 100);
  assert.equal(activation.selected, 100);
  assert.ok(pending.slice(0, 100).every(row => row.live === 1));
  assert.ok(pending.slice(100).every(row => row.live === null));
  const randomCalls = f.state.randomCalls;
  f.reopen();
  await assert.rejects(f.run('activate'), /Ethereum changed/);
  assert.deepEqual(f.draws(), pending);
  assert.deepEqual(f.activation(), activation);
  assert.equal(f.state.randomCalls, randomCalls);
  f.state.registryRevision++;
  const calls = f.state.tokenCalls.length, traits = f.state.traitIds.length;
  const refreshed = await f.run('refresh-activation');
  assert.equal(refreshed.phase, 'activating');
  assert.equal(refreshed.activationChecked, 0);
  assert.equal(refreshed.activationSelected, 0);
  assert.deepEqual({ ...f.activation() }, { ...activation, block_number: 503, block_hash: blockHash(503), checked: 0, selected: 0 });
  assert.deepEqual(f.draws(), pending.map(row => ({ ...row, live: null })));
  assert.deepEqual(f.row(), preparation);
  assert.deepEqual(f.evidence().owner_hatching_trait_staging, staged);
  assert.equal(JSON.parse(String(f.row().request_json)).expectedRevision, begin.expectedRevision);
  assert.equal(f.state.randomCalls, randomCalls);
  assert.equal(f.state.tokenCalls.length, calls);
  assert.equal(f.state.traitIds.length, traits);
  assert.equal(f.state.prepareCalls, 0);
  assert.equal(f.state.wakeCalls, 0);
  const refreshedEvidence = f.evidence();
  f.reopen();
  assert.deepEqual(await f.run('status'), refreshed);
  assert.deepEqual(f.evidence(), refreshedEvidence);
  const prefix = await f.run('activate');
  assert.equal(prefix.phase, 'activating');
  assert.equal(prefix.activationChecked, 100);
  assert.equal(prefix.activationSelected, 100);
  assert.deepEqual(f.state.tokenCalls[calls].ids, pending.slice(0, 100).map(row => row.token_id));
  assert.equal(f.state.randomCalls, randomCalls);
  assert.equal(f.state.prepareCalls, 0);
  const activated = await f.run('activate');
  assert.equal(activated.phase, 'publishing');
  assert.equal(activated.activationChecked, 150);
  assert.equal(activated.activationSelected, 150);
  assert.deepEqual(f.state.tokenCalls[calls + 1].ids, pending.slice(100).map(row => row.token_id));
  assert.ok(f.state.tokenCalls.slice(calls).every(call => JSON.stringify(call.block) ===
    JSON.stringify({ blockHash: blockHash(503), requireCanonical: true })));
  assert.deepEqual(f.draws(), pending.map(row => ({ ...row, live: 1 })));
  assert.deepEqual(f.state.prepared!.candidateTokenIds, pending.map(row => row.token_id));
  assert.equal(f.state.prepared!.batchId, begin.batchId);
  assert.equal(f.state.randomCalls, randomCalls);
  assert.equal(f.state.prepareCalls, 1);
  assert.equal((await f.complete()).complete, true);
  assert.equal(f.state.canonicalHashes.get(502), blockHash(1502));
});

test('activation refresh invalidates rejected as well as accepted candidate checks', async t => {
  const f = fixture(t, cohort(150));
  await f.prepared();
  f.state.missing.add('1');
  await f.run('activate');
  assert.equal((await f.run('activate')).activationSelected, 99);
  const draws = f.draws(), randomCalls = f.state.randomCalls;
  assert.equal(draws[0].live, 0);
  f.state.head++;
  f.state.missing.clear();
  await f.run('refresh-activation');
  assert.deepEqual(f.draws(), draws.map(row => ({ ...row, live: null })));
  assert.equal((await f.run('activate')).activationSelected, 100);
  assert.equal(f.draws()[0].live, 1);
  assert.equal(f.state.randomCalls, randomCalls);
});

for (const failure of ['rpc', 'canonical', 'registry', 'catalog'] as const) {
  test(`a ${failure} failure during activation refresh preserves all preparation evidence`, async t => {
    const f = fixture(t, cohort(150));
    await f.prepared();
    await f.run('activate');
    await f.run('activate');
    const evidence = f.evidence(), randomCalls = f.state.randomCalls;
    f.state.head++;
    if (failure === 'rpc') {
      f.state.snapshotFailure = new Error('Injected latest snapshot failure.');
      await assert.rejects(f.run('refresh-activation'));
    } else {
      const gate = holdNextRpc(t, 'eth_getBlockByNumber');
      const delayed = f.run('refresh-activation');
      await gate.started;
      if (failure === 'canonical') f.state.canonicalHashes.set(f.state.head, blockHash(f.state.head + 1000));
      if (failure === 'registry') f.state.current = false;
      if (failure === 'catalog') f.state.catalogRevision++;
      gate.release();
      await assert.rejects(delayed, failure === 'canonical' ? /Ethereum changed/ : failure === 'registry' ? /Registry revision/ : /catalog changed/);
    }
    assert.deepEqual(f.evidence(), evidence);
    assert.equal(f.state.randomCalls, randomCalls);
    assert.equal(f.state.prepareCalls, 0);
    assert.equal(f.state.wakeCalls, 0);
  });
}

test('concurrent activation refreshes cannot replace the first committed snapshot', async t => {
  const f = fixture(t, cohort(150));
  await f.prepared();
  await f.run('activate');
  await f.run('activate');
  f.state.head++;
  const gate = holdNextRpc(t, 'eth_getBlockByNumber');
  const delayed = f.run('refresh-activation');
  await gate.started;
  f.state.head++;
  await f.run('refresh-activation');
  const evidence = f.evidence(), randomCalls = f.state.randomCalls;
  assert.equal(f.activation().block_number, f.state.head);
  gate.release();
  await assert.rejects(delayed, /Activation changed while refreshing/);
  assert.deepEqual(f.evidence(), evidence);
  assert.equal(f.state.randomCalls, randomCalls);
});

for (const readyCount of [150, 350]) {
  test(`activation refresh cannot erase a concurrent ${readyCount === 150 ? 'allocation' : 'page completion'}`, async t => {
    const f = fixture(t, cohort(readyCount));
    f.state.minted = 500;
    await f.prepared();
    await f.run('activate');
    await f.run('activate');
    f.state.head++;
    const gate = holdNextRpc(t, 'eth_getBlockByNumber');
    const delayed = f.run('refresh-activation');
    await gate.started;
    const progressed = await f.run('activate');
    assert.equal(progressed.phase, readyCount === 150 ? 'publishing' : 'activating');
    assert.equal(progressed.activationChecked, Math.min(readyCount, 200));
    const evidence = f.evidence(), randomCalls = f.state.randomCalls;
    gate.release();
    await assert.rejects(delayed, /Activation changed while refreshing/);
    assert.deepEqual(f.evidence(), evidence);
    assert.equal(f.state.randomCalls, randomCalls);
  });
}

test('an activation page from the old snapshot cannot commit after refresh at the same checked count', async t => {
  const f = fixture(t, cohort(150));
  await f.prepared();
  await f.run('activate');
  const gate = holdNextRpc(t);
  const delayed = f.run('activate');
  await gate.started;
  const draws = f.draws(), randomCalls = f.state.randomCalls;
  f.state.head++;
  const refreshed = await f.run('refresh-activation');
  const evidence = f.evidence();
  gate.release();
  assert.deepEqual(await delayed, refreshed);
  assert.deepEqual(f.evidence(), evidence);
  assert.equal(f.state.randomCalls, randomCalls);
  assert.equal((await f.run('activate')).activationChecked, 100);
  assert.deepEqual(f.draws(), draws.map(row => ({ ...row, live: 1 })));
  assert.equal(f.state.randomCalls, randomCalls);
});

for (const phase of ['prepared', 'publishing', 'complete', 'allocated-activating'] as const) {
  test(`activation refresh rejects ${phase} batches without changing evidence or reading Ethereum`, async t => {
    const f = fixture(t);
    if (phase === 'prepared') await f.prepared();
    else if (phase === 'complete') await f.complete();
    else await f.activate();
    if (phase === 'allocated-activating') {
      f.database.prepare("UPDATE owner_hatching_preparations SET phase='activating' WHERE batch_id=?").run(begin.batchId);
    }
    const evidence = f.evidence(), rpcCalls = f.state.rpcCalls, randomCalls = f.state.randomCalls;
    await assert.rejects(f.run('refresh-activation'), /Only an unallocated activation/);
    assert.deepEqual(f.evidence(), evidence);
    assert.equal(f.state.rpcCalls, rpcCalls);
    assert.equal(f.state.randomCalls, randomCalls);
  });
}

test('concurrent activation initialization freezes one snapshot', async t => {
  const f = fixture(t);
  await f.prepared();
  const gate = holdNextRpc(t, 'eth_getBlockByNumber');
  const delayed = f.run('activate');
  await gate.started;
  f.state.head++;
  assert.equal((await f.run('activate')).phase, 'activating');
  const activation = f.activation();
  assert.equal(activation.block_number, f.state.head);
  gate.release();
  assert.equal((await delayed).phase, 'activating');
  assert.deepEqual(f.activation(), activation);
  assert.equal(f.count('owner_hatching_activation'), 1);
  assert.equal(f.state.randomCalls, 0);
});

test('concurrent activation page callbacks cannot commit progress twice', async t => {
  const f = fixture(t, cohort(150));
  await f.prepared();
  await f.run('activate');
  f.state.tokenCalls.length = 0;
  const gate = holdNextRpc(t);
  const delayed = f.run('activate');
  await gate.started;
  const current = await f.run('activate');
  assert.equal(current.activationChecked, 100);
  gate.release();
  assert.deepEqual(await delayed, current);
  assert.equal(f.activation().checked, 100);
  assert.equal(f.state.randomCalls, 100);
  assert.deepEqual(f.state.tokenCalls[0], f.state.tokenCalls[1]);
  assert.equal((await f.finishActivation()).activationChecked, 150);
  assert.equal(f.state.prepareCalls, 1);
});

for (const releasePhase of ['publishing', 'complete'] as const) {
  test(`an existing ${releasePhase} 350-egg cohort without activation state never reruns RPC or random selection`, async t => {
    const f = fixture(t, cohort(350));
    f.state.minted = 500;
    if (releasePhase === 'complete') await f.complete();
    else await f.activate();
    f.database.exec('DELETE FROM owner_hatching_activation_candidates; DELETE FROM owner_hatching_activation');
    const allocation = f.database.prepare('SELECT * FROM owner_hatching_tokens ORDER BY token_id').all();
    const prepared = structuredClone(f.state.prepared);
    const calls = f.state.rpcCalls, randomCalls = f.state.randomCalls;
    f.state.catalogRevision++;
    f.state.head++;
    f.state.tokenFailure = new Error('An existing cohort must never read tokens again.');
    f.reopen();
    const result = await f.run('activate');
    assert.equal(result.phase, releasePhase);
    assert.equal(result.activationChecked, 0);
    assert.equal(result.activationSelected, 350);
    assert.equal(f.state.rpcCalls, calls);
    assert.equal(f.state.randomCalls, randomCalls);
    assert.equal(f.state.prepareCalls, 1);
    assert.equal(f.state.wakeCalls, 1);
    assert.deepEqual(f.state.prepared, prepared);
    assert.deepEqual(f.database.prepare('SELECT * FROM owner_hatching_tokens ORDER BY token_id').all(), allocation);
    assert.equal(f.count('owner_hatching_activation'), 0);
    assert.equal(f.count('owner_hatching_activation_candidates'), 0);
  });

  test(`a delayed activation page cannot change an already ${releasePhase} allocation`, async t => {
    const f = fixture(t);
    await f.prepared();
    await f.run('activate');
    const gate = holdNextRpc(t);
    const delayed = f.run('activate');
    await gate.started;
    assert.equal((await f.run('activate')).phase, 'publishing');
    if (releasePhase === 'complete') await f.complete();
    const allocation = f.database.prepare('SELECT * FROM owner_hatching_tokens ORDER BY token_id').all();
    const activation = f.activation(), draws = f.draws();
    gate.release();
    assert.equal((await delayed).phase, releasePhase);
    assert.deepEqual(f.activation(), activation);
    assert.deepEqual(f.draws(), draws);
    assert.deepEqual(f.database.prepare('SELECT * FROM owner_hatching_tokens ORDER BY token_id').all(), allocation);
    assert.equal(f.state.prepareCalls, 1);
    assert.equal(f.state.wakeCalls, 1);
  });
}

for (const releasePhase of ['publishing', 'complete'] as const) {
  test(`a delayed final staging page preserves an already ${releasePhase} batch`, async t => {
    const f = fixture(t);
    await f.run('begin');
    while ((await f.run('scan')).phase === 'scanning') {}
    assert.equal((await f.run('stage')).staged, 8);
    const originalFetch = globalThis.fetch;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    t.after(() => release());
    let hold = true;
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('https://cdn.lil.org/') && hold) {
        hold = false;
        entered();
        await gate;
      }
      return originalFetch(input, init);
    });
    const delayed = f.run('stage');
    await started;
    assert.equal((await f.run('stage')).phase, 'prepared');
    assert.equal((await f.finishActivation()).phase, 'publishing');
    const allocation = f.database.prepare('SELECT * FROM owner_hatching_tokens ORDER BY token_id').all();
    const prepared = structuredClone(f.state.prepared);
    const completeBatch = async () => {
      f.state.published = begin.readyCount!;
      while ((await f.run('verify')).verificationCursor !== null) {}
      f.state.now += 300_000;
      while ((await f.run('verify')).verificationCursor !== null) {}
      assert.equal((await f.run('complete')).complete, true);
    };
    if (releasePhase === 'complete') await completeBatch();
    release();
    assert.equal((await delayed).phase, releasePhase);
    f.reopen();
    assert.equal((await f.run('activate')).phase, releasePhase);
    if (releasePhase === 'publishing') await completeBatch();
    assert.equal((await f.run('status')).complete, true);
    assert.equal(f.state.prepareCalls, 1);
    assert.equal(f.state.wakeCalls, 1);
    assert.deepEqual(f.state.prepared, prepared);
    assert.deepEqual(f.database.prepare('SELECT * FROM owner_hatching_tokens ORDER BY token_id').all(), allocation);
    assert.equal(f.count('owner_hatching_candidates'), 0);
    assert.equal(f.count('owner_hatching_trait_staging'), 0);
  });
}

test('too few eligible eggs and a changed catalog cannot activate a batch', async t => {
  const f = fixture(t);
  for (let id = 1; id <= 230; id++) f.state.nonEgg.add(String(id));
  await f.run('begin');
  while ((await f.run('scan')).phase === 'scanning') {}
  await assert.rejects(f.run('stage'), /too few eligible eggs/);
  assert.equal(f.state.prepareCalls, 0);
  assert.equal(f.count('owner_hatching_trait_staging'), 0);
  f.state.catalogRevision++;
  await assert.rejects(f.run('stage'), /catalog changed/);
});

test('completion verifies every metadata page twice across the scheduler interval and cleans temporary rows', async t => {
  const f = fixture(t);
  await f.activate();
  f.state.catalogRevision++;
  const waiting = await f.run('verify');
  assert.equal(waiting.verificationCursor, null);
  assert.equal(f.row().verification_passes, 0);
  f.state.published = 18;
  assert.equal((await f.run('verify')).verificationCursor, '16');
  const observed = await f.run('verify');
  assert.equal(observed.verificationCursor, null);
  assert.equal(observed.phase, 'observing');
  assert.equal(observed.observationUntilMs, f.state.now + 300_000);
  await f.run('verify');
  assert.equal(f.row().verification_passes, 1);
  await assert.rejects(f.run('complete'), /two verification passes/);
  f.state.now += 300_000;
  f.reopen();
  assert.equal((await f.run('verify')).verificationCursor, '16');
  await f.run('verify');
  const completed = await f.run('complete');
  assert.equal(completed.complete, true);
  assert.equal(completed.staged, 9);
  assert.equal(completed.candidates, 240);
  assert.equal(completed.scanned, 240);
  assert.equal(f.count('owner_hatching_candidates'), 0);
  assert.equal(f.count('owner_hatching_trait_staging'), 0);
  assert.equal(f.count('owner_hatching_activation_candidates'), 0);
  assert.equal(f.count('owner_hatching_activation'), 1);
  assert.equal(f.activation().checked, 18);
  assert.equal(f.activation().selected, 18);
  assert.equal(f.count('owner_hatching_tokens'), 18);
  assert.deepEqual(await f.run('complete'), completed);
});

test('metadata errors, concurrent hatching revisions and inventory loss cannot advance verification', async t => {
  const f = fixture(t);
  await f.activate(); f.state.published = 18;
  for (const fault of ['badObject', 'badHeaders', 'oversized', 'conservation'] as const) {
    f.state[fault] = fault !== 'conservation';
    await assert.rejects(f.run('verify'), /verification did not match|missing or oversized|conservation failed/);
    assert.equal(f.row().verification_cursor, null);
    assert.equal(f.row().verification_passes, 0);
    f.state[fault] = fault === 'conservation';
  }
  f.state.revisionChanged = true;
  assert.equal((await f.run('verify')).verificationCursor, null);
  assert.equal(f.row().verification_passes, 0);
  assert.equal((await f.run('verify')).verificationCursor, '16');
});

test('published base metadata cannot verify or complete while hatched traits are pending or failed', async t => {
  const f = fixture(t);
  await f.activate();
  f.state.published = 18;
  f.database.exec("UPDATE owner_hatching_tokens SET status='hatched' WHERE token_id='1'; INSERT INTO owner_hatching_retired_eggs VALUES('1'); INSERT INTO owner_hatching_artwork_claims VALUES('1')");
  f.state.pendingEnrichment = 1;
  const pending = await f.run('verify');
  assert.equal(pending.published, pending.readyCount);
  assert.equal(pending.retrying, 0);
  assert.equal(pending.pendingEnrichment, 1);
  assert.equal(pending.failedEnrichment, 0);
  assert.equal(pending.phase, 'publishing');
  assert.equal(f.row().verification_passes, 0);
  assert.equal(f.state.objectReads.length, 0);
  assert.equal(f.state.wakeCalls, 2);
  f.state.failedEnrichment = 1;
  await assert.rejects(f.run('verify'), /1 failed trait enrichments/);
  assert.equal((await f.run('status')).failedEnrichment, 1);
  assert.equal(f.row().verification_passes, 0);
  f.state.pendingEnrichment = 0;
  f.state.failedEnrichment = 0;
  while ((await f.run('verify')).verificationCursor !== null) {}
  f.state.now += 300_000;
  while ((await f.run('verify')).verificationCursor !== null) {}
  for (const counts of [{ pendingEnrichment: 1, failedEnrichment: 0 }, { pendingEnrichment: 0, failedEnrichment: 1 }]) {
    Object.assign(f.state, counts);
    await assert.rejects(f.run('complete'), /requires complete publication, trait enrichment/);
    assert.equal(f.count('owner_hatching_candidates'), 240);
    assert.equal(f.count('owner_hatching_trait_staging'), 9);
  }
  f.state.pendingEnrichment = 0;
  f.state.failedEnrichment = 0;
  assert.equal((await f.run('complete')).complete, true);
});

test('traits becoming pending during metadata reads cannot advance verification', async t => {
  const f = fixture(t);
  await f.activate();
  f.state.published = 18;
  let release!: () => void;
  f.state.r2Gate = new Promise<void>(resolve => { release = resolve; });
  const verifying = f.run('verify');
  await new Promise(resolve => setImmediate(resolve));
  f.state.pendingEnrichment = 1;
  release();
  assert.equal((await verifying).pendingEnrichment, 1);
  assert.equal(f.row().verification_cursor, null);
  assert.equal(f.row().verification_passes, 0);
});

test('completed batches verify every page afresh without changing their setup or private allocation', async t => {
  const f = fixture(t);
  const completed = await f.complete();
  const original = f.row();
  const allocation = f.database.prepare('SELECT * FROM owner_hatching_tokens ORDER BY token_id').all();
  f.state.objectReads.length = 0;
  f.state.registryRevision++;
  f.state.catalogRevision++;
  f.reopen();
  for (let pass = 0; pass < 2; pass++) {
    const first = await f.run('verify');
    assert.equal(first.complete, true);
    assert.equal(first.phase, 'complete');
    assert.equal(first.verificationCursor, '16');
    assert.deepEqual(await f.run('verify'), completed);
    assert.deepEqual(f.state.objectReads.slice(pass * 18), Array.from({ length: 18 }, (_, index) => String(index + 1)));
  }
  await f.run('verify');
  let release!: () => void;
  f.state.r2Gate = new Promise<void>(resolve => { release = resolve; });
  const pages = [f.run('verify'), f.run('verify')];
  await new Promise(resolve => setImmediate(resolve));
  release();
  assert.deepEqual(await Promise.all(pages), [completed, completed]);
  assert.deepEqual({ ...f.row() }, { ...original, verification_passes: Number(original.verification_passes) + 3 });
  assert.deepEqual(f.database.prepare('SELECT * FROM owner_hatching_tokens ORDER BY token_id').all(), allocation);
  assert.equal(f.state.prepareCalls, 1);
  assert.equal(f.state.wakeCalls, 1);
  assert.equal(f.count('owner_hatching_candidates'), 0);
  assert.equal(f.count('owner_hatching_trait_staging'), 0);
});

test('completed verification rejects missing or corrupt metadata, inventory loss and publication errors', async t => {
  const f = fixture(t);
  await f.complete();
  f.state.objectReads.length = 0;
  const original = f.row();
  for (const fault of ['missingObject', 'badObject', 'conservation', 'revisionChanged'] as const) {
    f.state[fault] = fault !== 'conservation';
    await assert.rejects(f.run('verify'), /missing or oversized|verification did not match|conservation failed|metadata changed/);
    assert.deepEqual(f.row(), original);
    f.state[fault] = fault === 'conservation';
  }
  assert.equal(f.state.objectReads.length, 64);
  f.state.published--;
  await assert.rejects(f.run('verify'), /publication verification failed/);
  assert.deepEqual(f.row(), original);
  assert.equal(f.state.prepareCalls, 1);
  assert.equal(f.state.wakeCalls, 1);
  assert.equal(f.count('owner_hatching_candidates'), 0);
  assert.equal(f.count('owner_hatching_trait_staging'), 0);
});

test('completed setup preserves its phase but rejects pending or failed enrichment until recovery', async t => {
  const f = fixture(t);
  const completed = await f.complete();
  const original = f.row();
  const wakeCalls = f.state.wakeCalls;
  f.state.objectReads.length = 0;
  f.state.pendingEnrichment = 1;
  const pending = await f.run('status');
  assert.equal(pending.phase, 'complete');
  assert.equal(pending.complete, true);
  assert.equal(pending.pendingEnrichment, 1);
  for (const action of ['verify', 'complete'] as const) await assert.rejects(f.run(action), /enrichment is incomplete/);
  f.state.failedEnrichment = 1;
  for (const action of ['verify', 'complete'] as const) await assert.rejects(f.run(action), /1 failed trait enrichments/);
  assert.deepEqual(f.row(), original);
  assert.equal(f.state.objectReads.length, 0);
  assert.equal(f.state.wakeCalls, wakeCalls);
  f.state.pendingEnrichment = 0;
  f.state.failedEnrichment = 0;
  assert.equal((await f.run('verify')).verificationCursor, '16');
  assert.deepEqual(await f.run('verify'), completed);
});

test('concurrent final verification pages cannot count as separate observation passes', async t => {
  const f = fixture(t);
  await f.activate(); f.state.published = 18;
  await f.run('verify');
  let release!: () => void;
  f.state.r2Gate = new Promise<void>(resolve => { release = resolve; });
  const first = f.run('verify'), second = f.run('verify');
  await new Promise(resolve => setImmediate(resolve));
  release();
  await Promise.all([first, second]);
  assert.equal(f.row().verification_passes, 1);
  f.state.now += 300_000;
  await assert.rejects(f.run('complete'), /two verification passes/);
});

test('private assignment count corruption prevents a successful verification pass', async t => {
  const f = fixture(t);
  await f.activate(); f.state.published = 18;
  f.database.exec("UPDATE owner_hatching_tokens SET grail_asset_id=NULL WHERE token_id='1'");
  await assert.rejects(f.run('verify'), /private allocation verification failed/);
  assert.equal(f.row().verification_cursor, null);
  f.database.exec("UPDATE owner_hatching_tokens SET grail_asset_id=422 WHERE token_id='1'");
  f.database.exec("UPDATE owner_hatching_tokens SET status='hatched' WHERE token_id='1'");
  await assert.rejects(f.run('verify'), /private allocation verification failed/);
  f.database.exec("INSERT INTO owner_hatching_retired_eggs VALUES('1'); INSERT INTO owner_hatching_artwork_claims VALUES('1')");
  assert.equal((await f.run('verify')).verificationCursor, '16');
});
