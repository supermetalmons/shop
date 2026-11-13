import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { EthereumOwnerHatchingStore, type OwnerHatchingBatchInput, type OwnerHatchingCanonical,
  type OwnerHatchingEnrichmentError, type OwnerHatchingHooks } from '../src/ethereumOwnerHatchingStore.ts';
import type { RevealSql } from '../src/ethereumRevealStore.ts';
import { parseMetadataJson } from '../src/ethereumMetadataJson.ts';

const digest = (value: string) => bytesToHex(sha256(value));
const observation = { transactionHash: `0x${'1'.repeat(64)}`, blockHash: `0x${'2'.repeat(64)}`, blockNumber: 123 };

function canonical(tokenId: string, eggId: number): OwnerHatchingCanonical {
  const artwork = { tokenId, crateTokenId: '111112', category: 'egg' as const, name: `Egg #${eggId}`,
    image: `https://example.com/eggs/${eggId}.png`, aspectRatio: { width: 1, height: 1 }, observation };
  const metadataJson = JSON.stringify({ name: artwork.name, category: 'egg', image: artwork.image, attributes: [] }) + '\n';
  return { tokenId, category: 'egg', assetId: eggId, assignmentRevision: 1, metadataRevision: 2, artwork,
    metadataJson, targetSha256: digest(metadataJson), expectedJsons: ['{"placeholder":true}\n', metadataJson], allowMissing: false, migration: false };
}

function fixture(t: TestContext) {
  const database = new DatabaseSync(':memory:');
  let observed: Array<{ query: string; bindings: number }> | undefined;
  database.exec('PRAGMA foreign_keys=ON');
  database.exec(`CREATE TABLE original_tokens(token_id TEXT PRIMARY KEY,egg_id INTEGER NOT NULL,canonical_json TEXT NOT NULL);
    CREATE TABLE free_assets(category TEXT NOT NULL,asset_id INTEGER NOT NULL,PRIMARY KEY(category,asset_id));
    CREATE TABLE pool_counts(category TEXT PRIMARY KEY,total INTEGER NOT NULL,available INTEGER NOT NULL);
    INSERT INTO pool_counts VALUES('egg',4,0),('painting',3,3),('animated',0,0);
    INSERT INTO free_assets VALUES('painting',1),('painting',2),('painting',3);`);
  for (let token = 1; token <= 4; token++) database.prepare('INSERT INTO original_tokens VALUES(?,?,?)')
    .run(String(token), token, JSON.stringify(canonical(String(token), token)));
  const sql: RevealSql = { exec<T extends Record<string, string | number | null | ArrayBuffer>>(query: string,
    ...bindings: Array<string | number | null | ArrayBuffer>) {
    observed?.push({ query, bindings: bindings.length });
    const statement = database.prepare(query);
    const params = bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    const rows = statement.columns().length ? statement.all(...params) : (statement.run(...params), []);
    return { toArray: () => rows as T[] };
  } };
  let depth = 0;
  const transaction = <T>(action: () => T): T => {
    if (depth) return action();
    database.exec('BEGIN IMMEDIATE');
    depth++;
    try { const result = action(); database.exec('COMMIT'); return result; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
    finally { depth--; }
  };
  let failBuild = false;
  let buildCount = 0;
  let ordinaryCount = 0;
  let blocked = false;
  const origins = new Map<string, { category: 'painting'; assetId: number }>();
  let store: EthereumOwnerHatchingStore;
  const hooks: OwnerHatchingHooks = {
    canonical(tokenId) {
      const row = database.prepare('SELECT canonical_json FROM original_tokens WHERE token_id=?').get(tokenId);
      return row ? JSON.parse(String(row.canonical_json)) as OwnerHatchingCanonical : null;
    },
    originForToken(tokenId) { return origins.get(tokenId) ?? { category: 'egg', assetId: Number(tokenId) }; },
    transitionSlot(_origin, before, after) {
      if (before.category !== after.category) {
        database.prepare('UPDATE pool_counts SET total=total-1 WHERE category=?').run(before.category);
        database.prepare('UPDATE pool_counts SET total=total+1 WHERE category=?').run(after.category);
      }
    },
    build(tokenId, asset, original) {
      buildCount++;
      if (failBuild) throw new Error('injected build failure');
      const artwork = { ...original.artwork, tokenId, category: asset.category, name: tokenId,
        image: `https://example.com/${asset.category}/${asset.assetId}.png` };
      const metadataJson = JSON.stringify({ name: tokenId, category: asset.category, image: artwork.image,
        attributes: asset.attributesJson ? JSON.parse(asset.attributesJson) : [] }) + '\n';
      return { artwork, metadataJson };
    },
    takeOrdinary() {
      ordinaryCount++;
      const row = database.prepare("SELECT * FROM free_assets WHERE category!='egg' ORDER BY asset_id LIMIT 1").get();
      if (!row) return null;
      const origin = { category: 'painting' as const, assetId: Number(row.asset_id) };
      database.prepare('DELETE FROM free_assets WHERE category=? AND asset_id=?').run(origin.category, origin.assetId);
      database.prepare('UPDATE pool_counts SET available=available-1 WHERE category=?').run(origin.category);
      return { origin, effective: origin };
    },
    releaseReplacement(origin, eggId) {
      assert.deepEqual(store.slotOverride(origin), { category: 'egg', assetId: eggId });
      database.prepare("INSERT INTO free_assets VALUES('egg',?)").run(eggId);
      database.prepare("UPDATE pool_counts SET available=available+1 WHERE category='egg'").run();
    },
    freshEggAvailable: eggId => eggId >= 55_304 && eggId <= 76_700,
    eligibleEgg: () => !blocked,
  };
  const reopen = (initialize = true) => {
    store = new EthereumOwnerHatchingStore(sql, transaction, hooks, () => 0);
    if (initialize) store.initialize();
    return store;
  };
  reopen();
  t.after(() => database.close());
  const input: OwnerHatchingBatchInput = { batchId: 'batch-1', sourceSha256: 'a'.repeat(64), candidateTokenIds: ['1', '2', '3', '4'],
    readyCount: 2, grails: [{ category: 'animated', assetId: 422, attributesJson: '[{"trait_type":"collection block","value":"DROWEE"}]' }],
    freshEggIds: [55_304] };
  return { database, input, get store() { return store; }, reopen,
    observe: <T>(action: () => T) => {
      const queries: Array<{ query: string; bindings: number }> = [];
      observed = queries;
      try { return { value: action(), queries }; } finally { observed = undefined; }
    },
    builds: () => buildCount, draws: () => ordinaryCount,
    mintFresh: (tokenId: string, eggId: number, originalPaintingId: number) => {
      database.prepare("DELETE FROM free_assets WHERE category='egg' AND asset_id=?").run(eggId);
      database.prepare("UPDATE pool_counts SET available=available-1 WHERE category='egg'").run();
      database.prepare('INSERT INTO original_tokens VALUES(?,?,?)').run(tokenId, eggId, JSON.stringify(canonical(tokenId, eggId)));
      origins.set(tokenId, { category: 'painting', assetId: originalPaintingId });
    },
    failBuild: (value: boolean) => { failBuild = value; }, block: (value: boolean) => { blocked = value; } };
}

test('preparation is private, deterministic on retry, and consumes no ordinary rewards', t => {
  const f = fixture(t);
  const before = f.database.prepare('SELECT * FROM free_assets').all();
  const result = f.store.prepare(f.input, 1000);
  assert.deepEqual(f.store.readyTokenIds(), ['1', '4']);
  assert.equal(result.ready, 2);
  assert.equal(result.phase, 'publishing');
  assert.equal(result.grailCount, 1);
  assert.equal(f.draws(), 0);
  assert.deepEqual(f.database.prepare('SELECT * FROM free_assets').all(), before);
  assert.equal('grails' in result, false);
  assert.equal(JSON.stringify(result).includes('422'), false);
  const ready = f.store.canonical('1')!;
  assert.equal(JSON.parse(ready.metadataJson).readyToHatch, true);
  assert.equal(ready.category, 'egg');
  assert.equal(ready.metadataRevision, 4);
  assert.deepEqual(f.reopen().prepare({ ...f.input, candidateTokenIds: ['4', '3', '2', '1'] }, 2000), result);
  assert.throws(() => f.store.prepare({ ...f.input, sourceSha256: 'b'.repeat(64) }), /replay changed/);
});

test('bulk owner reads preserve canonical payloads and slot order across bounded pages', t => {
  const f = fixture(t);
  f.store.prepare(f.input, 1000);
  f.store.hatch('4', 2000);
  const ids = ['4', ...Array.from({ length: 101 }, (_, index) => String(index + 10)), '1', '4'];
  const expected = new Map([['1', f.store.canonical('1')!], ['4', f.store.canonical('4')!]]);
  const changes = f.database.prepare('SELECT total_changes() AS changes').get()!.changes;
  const canonical = f.observe(() => f.store.canonicals(ids));
  assert.deepEqual(canonical.value, expected);
  assert.equal(canonical.queries.length, 2);
  assert.ok(canonical.queries.every(entry => entry.bindings <= 100 && entry.query.startsWith('SELECT')));
  for (const [tokenId, value] of canonical.value) {
    const row = f.database.prepare('SELECT canonical_json FROM owner_hatching_tokens WHERE token_id=?').get(tokenId)!;
    assert.deepEqual(value, parseMetadataJson(String(row.canonical_json)));
  }
  const origins = Array.from({ length: 51 }, (_, index) => ({ category: 'painting' as const, assetId: index + 1 }));
  origins.push(origins[0]);
  const overrides = f.observe(() => f.store.slotOverrides(origins));
  assert.deepEqual(overrides.value, [{ category: 'egg', assetId: 55_304 }, ...Array(50).fill(null), { category: 'egg', assetId: 55_304 }]);
  assert.equal(overrides.queries.length, 2);
  assert.ok(overrides.queries.every(entry => entry.bindings <= 100 && entry.query.startsWith('SELECT')));
  assert.equal(f.database.prepare('SELECT total_changes() AS changes').get()!.changes, changes);
  assert.deepEqual(f.observe(() => f.store.canonicals([])), { value: new Map(), queries: [] });
  assert.deepEqual(f.observe(() => f.store.slotOverrides([])), { value: [], queries: [] });
});

test('grail hatch retires its egg, preserves frozen identity, and survives repeated requests and restart', t => {
  const f = fixture(t);
  f.store.prepare(f.input, 1000);
  const original = f.database.prepare('SELECT * FROM original_tokens').all();
  const hatched = f.store.hatch('1', 2000);
  assert.equal(hatched.kind, 'hatched');
  if (hatched.kind !== 'hatched') return;
  assert.equal(hatched.artwork.category, 'animated');
  assert.equal(hatched.artwork.image, 'https://example.com/animated/422.png');
  assert.deepEqual(hatched.artwork.observation, observation);
  assert.equal(f.store.isRetiredEgg(1), true);
  assert.equal(f.store.claimedArtwork({ category: 'animated', assetId: 422 }), true);
  assert.deepEqual(f.store.slotOverride({ category: 'egg', assetId: 1 }), { category: 'animated', assetId: 422 });
  assert.deepEqual(f.store.readyTokenIds(), ['4']);
  assert.equal('readyToHatch' in JSON.parse(f.store.canonical('1')!.metadataJson), false);
  assert.equal(f.draws(), 0);
  assert.deepEqual(f.reopen().hatch('1', 3000), hatched);
  assert.equal(f.builds(), 1);
  assert.deepEqual(f.database.prepare('SELECT * FROM original_tokens').all(), original);
  assert.throws(() => f.database.exec('DELETE FROM owner_hatching_retired_eggs'), /cannot be deleted/);
  assert.throws(() => f.database.exec("UPDATE owner_hatching_tokens SET egg_id=2 WHERE token_id='1'"), /immutable/);
});

test('ordinary hatch draws live, replaces the free slot with a fresh egg, and preserves capacity', t => {
  const f = fixture(t);
  f.store.prepare(f.input, 1000);
  f.database.exec("DELETE FROM free_assets WHERE category='painting' AND asset_id=1; UPDATE pool_counts SET available=available-1 WHERE category='painting'");
  const before = f.database.prepare('SELECT * FROM pool_counts ORDER BY category').all();
  const hatched = f.store.hatch('4', 2000);
  assert.equal(hatched.kind, 'hatched');
  if (hatched.kind !== 'hatched') return;
  assert.equal(hatched.artwork.image, 'https://example.com/painting/2.png');
  assert.equal(f.store.isRetiredEgg(4), true);
  assert.deepEqual(f.store.slotOverride({ category: 'egg', assetId: 4 }), { category: 'painting', assetId: 2 });
  assert.deepEqual(f.store.slotOverride({ category: 'painting', assetId: 2 }), { category: 'egg', assetId: 55_304 });
  assert.deepEqual(f.database.prepare('SELECT * FROM free_assets ORDER BY category,asset_id').all().map(row => ({ ...row })),
    [{ category: 'egg', asset_id: 55_304 }, { category: 'painting', asset_id: 3 }]);
  const after = f.database.prepare('SELECT * FROM pool_counts ORDER BY category').all();
  assert.deepEqual(after.map(row => row.total), before.map(row => row.total));
  assert.equal(after.reduce((sum, row) => sum + Number(row.available), 0), before.reduce((sum, row) => sum + Number(row.available), 0));
  assert.deepEqual(f.store.hatch('4', 3000), hatched);
  assert.equal(f.draws(), 1);
  assert.equal(f.store.enrichmentPage(3000).length, 1);
});

test('ordinary exhaustion and blocked eligibility leave readiness and all inventory unchanged', t => {
  const f = fixture(t);
  f.store.prepare(f.input, 1000);
  f.database.exec('DELETE FROM free_assets');
  assert.deepEqual(f.store.hatch('4', 2000), { kind: 'unavailable' });
  assert.equal(f.store.isRetiredEgg(4), false);
  assert.equal(f.database.prepare('SELECT token_id FROM owner_hatching_fresh_eggs').get()!.token_id, null);
  assert.deepEqual(f.store.readyTokenIds(), ['1', '4']);
  f.block(true);
  assert.deepEqual(f.store.hatch('1', 2000), { kind: 'not-ready' });
  assert.deepEqual(f.store.hatch('2', 2000), { kind: 'not-ready' });
  f.block(false);
  assert.equal(f.store.hatch('1', 2000).kind, 'hatched');
  f.database.exec("INSERT INTO free_assets VALUES('painting',3)");
  assert.equal(f.store.hatch('4', 3000).kind, 'hatched');
});

test('ordinary hatch failure rolls back asset consumption, fresh egg use, overrides, and retirement', t => {
  const f = fixture(t);
  f.store.prepare(f.input, 1000);
  const before = f.database.prepare('SELECT * FROM free_assets ORDER BY asset_id').all();
  const counts = f.database.prepare('SELECT * FROM pool_counts ORDER BY category').all();
  f.failBuild(true);
  assert.throws(() => f.store.hatch('4', 2000), /injected build failure/);
  assert.deepEqual(f.database.prepare('SELECT * FROM free_assets ORDER BY asset_id').all(), before);
  assert.deepEqual(f.database.prepare('SELECT * FROM pool_counts ORDER BY category').all(), counts);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM owner_hatching_slot_overrides').get()!.count, 0);
  assert.equal(f.store.isRetiredEgg(4), false);
  assert.equal(f.database.prepare('SELECT token_id FROM owner_hatching_fresh_eggs').get()!.token_id, null);
  f.failBuild(false);
  assert.equal(f.store.hatch('4', 3000).kind, 'hatched');
});

test('stale readiness publication cannot acknowledge or overwrite hatch publication', t => {
  const f = fixture(t);
  f.store.prepare(f.input, 1000);
  const stale = f.store.claimPublications(1000);
  f.store.hatch('1', 2000);
  assert.equal(f.store.completePublications(stale.map(job => ({ job, status: 'published' })), 3000).length, 1);
  const jobs = f.store.claimPublications(3000);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].token_id, '1');
  assert.equal(jobs[0].metadata_revision, 6);
  assert.equal(JSON.parse(jobs[0].expected_jsons_json!).length, 3);
  f.store.completePublications(jobs.map(job => ({ job, status: 'retry' })), 3000);
  assert.equal(f.store.publicationError(), 'publication-unavailable');
  assert.equal(f.store.claimPublications(4000).length, 0);
  const resumed = f.reopen().claimPublications(5000);
  assert.equal(resumed.length, 1);
  f.store.completePublications(resumed.map(job => ({ job, status: 'published' })), 5000);
  assert.equal(f.store.batchStatus()!.phase, 'complete');
  assert.equal(f.store.publicationError(), null);
});

test('ordinary enrichment is durable, fenced by revision, and cannot change the chosen artwork', t => {
  const f = fixture(t);
  f.store.prepare(f.input, 1000);
  f.store.hatch('4', 2000);
  const job = f.store.enrichmentPage(3000)[0];
  assert.equal(job.assetId, 1);
  assert.equal(f.store.enrichmentPage(4000).length, 0);
  assert.equal(f.store.failEnrichment(job.tokenId, job.metadataRevision, 4000, 'source-unavailable'), true);
  assert.equal(f.reopen().enrichmentPage(5000).length, 0);
  assert.equal(f.store.enrichmentPage(6000).length, 1);
  const base = JSON.parse(job.baseJson);
  const enriched = JSON.stringify({ ...base, attributes: [{ trait_type: 'artist', value: 'Regular Artist' }] }) + '\n';
  assert.equal(f.store.acceptEnrichment(job.tokenId, job.metadataRevision - 1, enriched), false);
  assert.throws(() => f.store.acceptEnrichment(job.tokenId, job.metadataRevision,
    JSON.stringify({ ...base, image: 'https://example.com/wrong.png', attributes: [{ trait_type: 'artist', value: 'Wrong' }] })), /cannot change/);
  assert.equal(f.store.acceptEnrichment(job.tokenId, job.metadataRevision, enriched), true);
  assert.equal(f.store.acceptEnrichment(job.tokenId, job.metadataRevision, enriched), false);
  const canonical = f.store.canonical(job.tokenId)!;
  assert.equal(canonical.assetId, 1);
  assert.equal(canonical.metadataRevision, 7);
  assert.equal(canonical.expectedJsons.length, 4);
  assert.deepEqual(JSON.parse(canonical.metadataJson).attributes, [{ trait_type: 'artist', value: 'Regular Artist' }]);
  assert.equal(canonical.artwork.attributes, undefined);
  assert.equal(f.store.enrichmentPage(100_000).length, 0);
  assert.equal(f.draws(), 1);
});

test('enrichment errors survive reopening, follow retry backoff, and clear only after accepted success', t => {
  const f = fixture(t);
  f.store.prepare(f.input, 1000);
  f.store.hatch('4', 2000);
  let now = 3000;
  let job = f.store.enrichmentPage(now)[0];
  assert.equal(job.lastError, null);
  assert.deepEqual(f.store.enrichmentSummary(), { pending: 1, failed: 0, completed: 0, errors: {} });
  const reasons: OwnerHatchingEnrichmentError[] = ['invalid', 'source-unavailable', 'enrichment-failed'];
  for (const reason of reasons) {
    assert.equal(f.store.failEnrichment(job.tokenId, job.metadataRevision - 1, now, reason), false);
    assert.equal(f.store.failEnrichment(job.tokenId, job.metadataRevision, now, reason), true);
    const retryAt = now + 1000 * 2 ** job.attempts;
    f.reopen();
    assert.deepEqual(f.store.enrichmentSummary(), { pending: 1, failed: 1, completed: 0, errors: { [reason]: 1 } });
    assert.equal(f.store.enrichmentPage(retryAt - 1).length, 0);
    job = f.store.enrichmentPage(retryAt)[0];
    assert.equal(job.lastError, reason);
    now = retryAt;
  }
  const enriched = JSON.stringify({ ...JSON.parse(job.baseJson), attributes: [{ trait_type: 'artist', value: 'Regular Artist' }] }) + '\n';
  assert.equal(f.store.acceptEnrichment(job.tokenId, job.metadataRevision - 1, enriched), false);
  assert.deepEqual(f.store.enrichmentSummary().errors, { 'enrichment-failed': 1 });
  assert.equal(f.store.acceptEnrichment(job.tokenId, job.metadataRevision, enriched), true);
  assert.equal(f.store.failEnrichment(job.tokenId, job.metadataRevision, now, 'invalid'), false);
  assert.equal(f.store.failEnrichment(job.tokenId, job.metadataRevision + 1, now, 'invalid'), false);
  assert.deepEqual(f.reopen().enrichmentSummary(), { pending: 0, failed: 0, completed: 1, errors: {} });
  assert.equal(f.database.prepare('SELECT last_error FROM owner_hatching_enrichment WHERE token_id=?').get(job.tokenId)!.last_error, null);
});

test('base hatch publication remains immediate while batch enrichment is pending or failed', t => {
  const f = fixture(t);
  f.store.prepare(f.input, 1000);
  const hatched = f.store.hatch('4', 2000);
  assert.equal(hatched.kind, 'hatched');
  const publications = f.store.claimPublications(2000);
  assert.equal(publications.length, 2);
  f.store.completePublications(publications.map(job => ({ job, status: 'published' })), 2000);
  assert.equal(f.store.batchStatus()!.phase, 'complete');
  assert.equal(f.store.batchStatus()!.pendingEnrichment, 1);
  assert.equal(f.store.batchStatus()!.failedEnrichment, 0);
  const job = f.store.enrichmentPage(3000)[0];
  f.store.failEnrichment(job.tokenId, job.metadataRevision, 3000, 'invalid');
  assert.equal(f.store.batchStatus()!.phase, 'complete');
  assert.equal(f.store.batchStatus()!.pendingPublication, 0);
  assert.equal(f.store.batchStatus()!.pendingEnrichment, 1);
  assert.equal(f.store.batchStatus()!.failedEnrichment, 1);
  assert.deepEqual(f.store.hatch('4', 4000), hatched);
  assert.equal(f.builds(), 1);
  assert.equal(f.draws(), 1);
});

test('busy enrichment defers only enrichment wakes and retains durable claim recovery', t => {
  const f = fixture(t);
  f.store.prepare({ ...f.input, readyCount: 3, grails: [], freshEggIds: [55_304, 55_305, 55_306] }, 1000);
  for (const tokenId of f.store.readyTokenIds()) assert.equal(f.store.hatch(tokenId, 2000).kind, 'hatched');
  assert.equal(f.store.nextWake(2000, true), 2000);
  f.store.completePublications(f.store.claimPublications(2000).map(job => ({ job, status: 'published' })), 2000);
  const [job] = f.store.enrichmentPage(3000, 1);
  assert.equal(f.store.nextWake(3000), 3000);
  assert.equal(f.store.nextWake(3000, true), 63_000);
  const enriched = JSON.stringify({ ...JSON.parse(job.baseJson), attributes: [{ trait_type: 'artist', value: 'Regular Artist' }] });
  assert.equal(f.store.acceptEnrichment(job.tokenId, job.metadataRevision, enriched), true);
  assert.equal(f.store.nextWake(4000, true), 4000);
  f.store.completePublications(f.store.claimPublications(4000).map(value => ({ job: value, status: 'published' })), 4000);
  const pending = f.reopen().enrichmentPage(5000);
  assert.equal(pending.length, 2);
  assert.equal(f.reopen().nextWake(5000), 65_000);
  assert.equal(f.store.enrichmentPage(64_999).length, 0);
  assert.equal(f.store.enrichmentPage(65_000).length, 2);
});

test('legacy enrichment jobs remain readable and migrate additively without losing retry state', t => {
  const f = fixture(t);
  f.store.prepare(f.input, 1000);
  f.store.hatch('4', 2000);
  const pending = f.store.enrichmentPage(3000)[0];
  f.store.failEnrichment(pending.tokenId, pending.metadataRevision, 3000, 'source-unavailable');
  f.store.prepare({ ...f.input, batchId: 'batch-2', candidateTokenIds: ['2'], readyCount: 1, grails: [], freshEggIds: [55_305] }, 4000);
  f.store.hatch('2', 4000);
  const completed = f.store.enrichmentPage(4000)[0];
  const enriched = JSON.stringify({ ...JSON.parse(completed.baseJson), attributes: [{ trait_type: 'artist', value: 'Regular Artist' }] }) + '\n';
  f.store.acceptEnrichment(completed.tokenId, completed.metadataRevision, enriched);
  f.database.exec('ALTER TABLE owner_hatching_enrichment DROP COLUMN last_error');
  const before = f.database.prepare('SELECT * FROM owner_hatching_enrichment ORDER BY token_id').all();
  const legacy = f.reopen(false);
  assert.deepEqual(legacy.enrichmentSummary(), { pending: 1, failed: 0, completed: 1, errors: {} });
  assert.deepEqual(legacy.enrichmentSummary('batch-1'), { pending: 1, failed: 0, completed: 0, errors: {} });
  assert.deepEqual(legacy.enrichmentSummary('batch-2'), { pending: 0, failed: 0, completed: 1, errors: {} });
  assert.deepEqual(legacy.enrichmentSummary('absent'), { pending: 0, failed: 0, completed: 0, errors: {} });
  assert.equal(legacy.batchStatus('batch-1')!.pendingEnrichment, 1);
  assert.equal(legacy.batchStatus('batch-1')!.failedEnrichment, 0);
  assert.equal(legacy.initialized, false);
  assert.equal(f.database.prepare('PRAGMA table_info(owner_hatching_enrichment)').all().some(row => row.name === 'last_error'), false);
  f.reopen();
  assert.deepEqual(f.database.prepare('SELECT token_id,metadata_revision,status,attempts,next_check_ms FROM owner_hatching_enrichment ORDER BY token_id').all(), before);
  assert.deepEqual(f.store.enrichmentSummary(), { pending: 1, failed: 0, completed: 1, errors: {} });
  assert.equal(f.store.enrichmentPage(4999).length, 0);
  const retry = f.store.enrichmentPage(5000)[0];
  assert.equal(retry.tokenId, pending.tokenId);
  assert.equal(retry.attempts, 2);
  assert.equal(retry.lastError, null);
  f.store.failEnrichment(retry.tokenId, retry.metadataRevision, 5000, 'invalid');
  assert.deepEqual(f.reopen().enrichmentSummary('batch-1'), { pending: 1, failed: 1, completed: 0, errors: { invalid: 1 } });
});

test('additive batches cannot reuse ready tokens, grails, fresh eggs, or retired eggs', t => {
  const f = fixture(t);
  f.store.prepare(f.input, 1000);
  assert.throws(() => f.store.prepare({ ...f.input, batchId: 'batch-2' }), /unavailable assets/);
  const second = { ...f.input, batchId: 'batch-2', grails: [{ category: 'animated' as const, assetId: 423 }], freshEggIds: [55_305] };
  f.store.prepare(second, 2000);
  assert.deepEqual(f.store.readyTokenIds(), ['1', '2', '3', '4']);
  assert.throws(() => f.store.prepare({ ...second, batchId: 'batch-3', grails: [], freshEggIds: [55_306, 55_307] }), /Not enough/);
  assert.equal(f.store.batchStatus('batch-3'), null);
  assert.equal(f.store.usedFreshEgg(55_306), false);
  f.store.hatch('1', 3000);
  assert.equal(f.store.hasProtectedEgg(1), true);
});

test('a fresh replacement egg can be minted and hatched in a later batch without reusing its retired artwork', t => {
  const f = fixture(t);
  f.store.prepare(f.input, 1000);
  f.store.hatch('4', 2000);
  f.mintFresh('5', 55_304, 1);
  f.reopen().prepare({ batchId: 'batch-2', sourceSha256: 'b'.repeat(64), candidateTokenIds: ['5'], readyCount: 1,
    grails: [], freshEggIds: [55_305] }, 3000);
  const result = f.store.hatch('5', 4000);
  assert.equal(result.kind, 'hatched');
  if (result.kind !== 'hatched') return;
  assert.equal(result.artwork.image, 'https://example.com/painting/2.png');
  assert.equal(f.store.isRetiredEgg(55_304), true);
  assert.deepEqual(f.store.slotOverride({ category: 'painting', assetId: 1 }), { category: 'painting', assetId: 2 });
  assert.deepEqual(f.store.slotOverride({ category: 'painting', assetId: 2 }), { category: 'egg', assetId: 55_305 });
  const history = f.database.prepare("SELECT asset_id FROM owner_hatching_slot_history WHERE origin_category='painting' AND origin_asset_id=1 ORDER BY created_at_ms").all();
  assert.deepEqual(history.map(row => row.asset_id), [55_304, 2]);
  assert.equal(f.store.usedFreshEgg(55_304), true);
  assert.throws(() => f.database.exec('DELETE FROM owner_hatching_slot_history'), /cannot be deleted/);
});

test('a read-only owner store tolerates a pre-feature ledger without creating tables', t => {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  const sql: RevealSql = { exec<T extends Record<string, string | number | null | ArrayBuffer>>(query: string,
    ...bindings: Array<string | number | null | ArrayBuffer>) {
    const statement = database.prepare(query);
    const params = bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    const rows = statement.columns().length ? statement.all(...params) : (statement.run(...params), []);
    return { toArray: () => rows as T[] };
  } };
  const unexpected = (): never => { throw new Error('Read-only inspection called a mutation hook.'); };
  const store = new EthereumOwnerHatchingStore(sql, unexpected, { canonical: unexpected, build: unexpected,
    takeOrdinary: unexpected, originForToken: unexpected, transitionSlot: unexpected, releaseReplacement: unexpected,
    freshEggAvailable: unexpected, eligibleEgg: unexpected });
  assert.equal(store.available, false);
  assert.equal(store.initialized, false);
  assert.equal(store.canonical('1'), null);
  assert.deepEqual(store.canonicals(['2', '1', '1']), new Map());
  assert.equal(store.slotOverride({ category: 'egg', assetId: 1 }), null);
  assert.deepEqual(store.slotOverrides([{ category: 'egg', assetId: 2 }, { category: 'painting', assetId: 1 }]), [null, null]);
  assert.equal(store.batchStatus(), null);
  assert.deepEqual(store.enrichmentSummary(), { pending: 0, failed: 0, completed: 0, errors: {} });
  assert.equal(store.hasProtectedEgg(1), false);
  assert.deepEqual(store.readyTokenIds(), []);
  assert.equal(store.nextWake(1000), null);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM sqlite_schema').get()!.count, 0);
  const writer = new EthereumOwnerHatchingStore(sql, action => action(), { canonical: unexpected, build: unexpected,
    takeOrdinary: unexpected, originForToken: unexpected, transitionSlot: unexpected, releaseReplacement: unexpected,
    freshEggAvailable: unexpected, eligibleEgg: unexpected });
  writer.initialize();
  assert.equal(store.available, true);
  assert.equal(store.initialized, false);
});

test('enriched exact numeric traits persist while repeated hatch artwork stays compact', t => {
  const f = fixture(t);
  f.store.prepare(f.input, 1000);
  f.store.hatch('4', 2000);
  const job = f.store.enrichmentPage(3000)[0];
  const enriched = job.baseJson.replace('"attributes":[]',
    '"attributes":[{"trait_type":"large","value":9007199254740993},{"trait_type":"exact","value":1.00},' +
    '{"trait_type":"full","value":"' + 'x'.repeat(64 * 1024) + '"}]');
  assert.equal(f.store.acceptEnrichment(job.tokenId, job.metadataRevision, enriched), true);
  const saved = f.reopen().canonical('4')!;
  assert.deepEqual(f.store.canonicals(['4', '1', '4']).get('4'), saved);
  const metadata = parseMetadataJson(saved.metadataJson);
  assert.match(JSON.stringify(metadata), /9007199254740993/);
  assert.match(JSON.stringify(metadata), /"value":1\.00/);
  const repeated = f.store.hatch('4', 4000);
  assert.equal(repeated.kind, 'hatched');
  if (repeated.kind === 'hatched') assert.ok(JSON.stringify(repeated.artwork).length < 1024);
  assert.equal(saved.metadataJson, enriched);
});
