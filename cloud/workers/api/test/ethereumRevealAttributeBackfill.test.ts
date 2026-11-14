import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { backfillRevealAttributePage } from '../src/ethereumRevealAttributeBackfill.ts';
import { acknowledgedEnrichmentHash, EthereumRevealEnrichmentStore, REVEAL_ENRICHMENT_SCHEMA } from '../src/ethereumRevealEnrichmentStore.ts';
import { parseRevealAttributeBackfillRequest } from '../src/ethereumRevealMaintenanceSupport.ts';
import { EthereumRevealStore, type RevealSql } from '../src/ethereumRevealStore.ts';
import { buildNewRevealedArtwork, buildRevealedArtwork } from '../src/ethereumRevealCatalog.ts';
import { getRevealCatalog } from '../../../../shared/ethereum/revealCatalogRegistry.ts';
import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.ts';
import { EthereumOwnerHatchingStore, type OwnerHatchingCanonical } from '../src/ethereumOwnerHatchingStore.ts';

function revealSql(db: DatabaseSync): RevealSql {
  return { exec<T>(query: string, ...args: Array<string | number | null | ArrayBuffer>) {
    const rows = db.prepare(query).all(...args.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value));
    return { toArray: () => rows as T[] };
  } };
}

test('source failures retain durable retry alarms indefinitely with a five-minute backoff cap', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const sql = revealSql(db);
  db.exec(`CREATE TABLE assignments(token_id TEXT PRIMARY KEY,category TEXT,asset_id INTEGER,metadata_json TEXT,assignment_revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE publication(token_id TEXT PRIMARY KEY,status TEXT);
    INSERT INTO assignments VALUES('1','painting',41171,'{"attributes":[]}',0);
    INSERT INTO publication VALUES('1','published');`);
  for (const statement of REVEAL_ENRICHMENT_SCHEMA) db.exec(statement);
  db.exec("INSERT INTO reveal_enrichment(token_id,version) VALUES('1','v0')");
  let now = 1_000;
  for (let attempt = 1; attempt <= 100; attempt++) {
    const store = new EthereumRevealEnrichmentStore(sql, action => action());
    const [job] = store.claim(now);
    assert.equal(job.attempts, attempt);
    assert.equal(store.complete(job, 'source-unavailable', now), true);
    assert.deepEqual(store.summary(), { 'source-unavailable': 1 });
    const wake = store.nextWake(now, false)!;
    assert.equal(wake - now, Math.min(300_000, 1_000 * 2 ** Math.min(attempt, 9)));
    assert.deepEqual(store.claim(wake - 1), []);
    now = wake;
  }
  const store = new EthereumRevealEnrichmentStore(sql, action => action());
  const [job] = store.claim(now);
  const target = '{"attributes":[{"trait_type":"collection block","value":"little swag"}]}';
  assert.equal(store.stage(job, target, createHash('sha256').update(target).digest('hex')), true);
  assert.equal(store.complete(job, 'published', now), true);
  assert.deepEqual(store.summary(), { published: 1 });
  assert.equal(store.nextWake(now, false), null);
});

test('backfill skips fresh egg origins and never rechecks their obsolete artwork traits', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const sql = revealSql(db);
  db.exec(`CREATE TABLE assignments(token_id TEXT PRIMARY KEY,category TEXT,asset_id INTEGER,metadata_json TEXT,assignment_revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE publication(token_id TEXT PRIMARY KEY,status TEXT);
    CREATE TABLE owner_hatching_slot_overrides(origin_category TEXT,origin_asset_id INTEGER);
    INSERT INTO assignments VALUES('1','painting',7,'fresh egg',0),('2','painting',8,'ordinary artwork',0);
    INSERT INTO publication VALUES('1','published'),('2','published');
    INSERT INTO owner_hatching_slot_overrides VALUES('painting',7);`);
  for (const statement of REVEAL_ENRICHMENT_SCHEMA) db.exec(statement);
  const page = backfillRevealAttributePage(sql, { afterTokenId: null, write: true });
  assert.equal(page.eligible, 1);
  assert.equal(page.enqueued, 1);
  assert.deepEqual(db.prepare('SELECT token_id FROM reveal_enrichment').all().map(row => row.token_id), ['2']);
  db.prepare(`INSERT INTO reveal_enrichment(token_id,version,status,target_json,target_sha256,last_error)
    VALUES('1','v0','published','obsolete',?,'conflict-recheck')`).run('a'.repeat(64));
  const before = db.prepare('SELECT * FROM reveal_enrichment ORDER BY token_id').all();
  assert.equal(backfillRevealAttributePage(sql, { afterTokenId: null, write: true, recheckTokenId: '1' }).eligible, 0);
  assert.equal(backfillRevealAttributePage(sql, { afterTokenId: null, write: false }).conflictRechecks, 0);
  assert.deepEqual(db.prepare('SELECT * FROM reveal_enrichment ORDER BY token_id').all(), before);
});

test('overridden enrichment cannot keep alarms active or finish an obsolete in-flight claim', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const sql = revealSql(db);
  db.exec(`CREATE TABLE assignments(token_id TEXT PRIMARY KEY,category TEXT,asset_id INTEGER,metadata_json TEXT,assignment_revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE publication(token_id TEXT PRIMARY KEY,status TEXT);
    CREATE TABLE owner_hatching_slot_overrides(origin_category TEXT,origin_asset_id INTEGER);
    INSERT INTO assignments VALUES('1','painting',7,'fresh egg',0),('2','painting',8,'ordinary artwork',0);
    INSERT INTO publication VALUES('1','published'),('2','published');
    INSERT INTO owner_hatching_slot_overrides VALUES('painting',7);`);
  for (const statement of REVEAL_ENRICHMENT_SCHEMA) db.exec(statement);
  db.exec("INSERT INTO reveal_enrichment(token_id,version,next_check_ms) VALUES('1','v0',0),('2','v0',1000)");
  const store = new EthereumRevealEnrichmentStore(sql, action => action());
  assert.deepEqual(store.claim(0), []);
  assert.equal(store.nextWake(0, false), 1000);
  assert.deepEqual(store.summary(), { pending: 1 });
  const [claim] = store.claim(1000);
  assert.equal(claim.token_id, '2');
  db.exec("INSERT INTO owner_hatching_slot_overrides VALUES('painting',8)");
  assert.equal(store.stage(claim, 'obsolete target', 'b'.repeat(64)), false);
  assert.equal(store.complete(claim, 'conflict', 1001), false);
  assert.equal(store.nextWake(1001, false), null);
  assert.deepEqual(store.summary(), {});
});

test('enrichment work is bound to its assignment revision across preparation and completion', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const sql = revealSql(db);
  db.exec(`CREATE TABLE assignments(token_id TEXT PRIMARY KEY,category TEXT,asset_id INTEGER,metadata_json TEXT,assignment_revision INTEGER);
    CREATE TABLE publication(token_id TEXT PRIMARY KEY,status TEXT);
    INSERT INTO assignments VALUES('1','painting',1,'base',0);
    INSERT INTO publication VALUES('1','published');`);
  for (const statement of REVEAL_ENRICHMENT_SCHEMA) db.exec(statement);
  db.exec("INSERT INTO reveal_enrichment(token_id,version) VALUES('1','v0')");
  const store = new EthereumRevealEnrichmentStore(sql, action => action());
  const [old] = store.claim(1000);
  assert.equal(old.metadata_revision, 1);
  db.exec('UPDATE assignments SET assignment_revision=2');
  assert.equal(store.stage(old, 'old target', 'a'.repeat(64)), false);
  assert.equal(store.complete(old, 'published', 1001), false);
  db.exec("UPDATE reveal_enrichment SET assignment_revision=2,claim_id=NULL,next_check_ms=0");
  const [current] = store.claim(1002);
  assert.equal(current.metadata_revision, 5);
  assert.equal(store.stage(current, 'current target', 'b'.repeat(64)), true);
  assert.equal(store.complete(old, 'conflict', 1003), false);
  assert.equal(store.complete(current, 'published', 1003), true);
  assert.equal(db.prepare("SELECT target_json FROM reveal_enrichment WHERE token_id='1'").get()?.target_json, 'current target');
});

test('private attribute backfill requires an explicit mode, pinned identity and bounded cursor', () => {
  const request = { deploymentId: 'sepolia-17', expectedRevision: 3, write: false, afterTokenId: null };
  assert.deepEqual(parseRevealAttributeBackfillRequest(request), request);
  assert.deepEqual(parseRevealAttributeBackfillRequest({ ...request, retryBlocked: true }), { ...request, retryBlocked: true });
  assert.deepEqual(parseRevealAttributeBackfillRequest({ ...request, recheckTokenId: '42' }), { ...request, recheckTokenId: '42' });
  assert.deepEqual(parseRevealAttributeBackfillRequest({ ...request, audit: true, frozenThroughMs: 1000 }), { ...request, audit: true, frozenThroughMs: 1000 });
  for (const changed of [{ write: 'false' }, { deploymentId: null }, { expectedRevision: -1 }, { afterTokenId: 0 },
    { afterTokenId: '0001' }, { afterTokenId: '111112' }, { afterTokenId: undefined }, { retryBlocked: 'true' },
    { recheckTokenId: '01' }, { recheckTokenId: '111112' }, { recheckTokenId: '42', retryBlocked: true },
    { recheckTokenId: '42', afterTokenId: '1' }, { force: true }, { audit: 'true' }, { audit: true }, { frozenThroughMs: 1000 },
    { audit: true, frozenThroughMs: 1000, write: true }, { audit: true, frozenThroughMs: 1000, retryBlocked: true },
    { audit: true, frozenThroughMs: 1000, recheckTokenId: '42' }, { audit: true, frozenThroughMs: Date.now() + 100_000 }]) {
    assert.throws(() => parseRevealAttributeBackfillRequest({ ...request, ...changed }));
  }
});

test('recheck preserves the original acknowledgment and only retries the named token', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const sql = revealSql(db);
  db.exec(`CREATE TABLE assignments(token_id TEXT PRIMARY KEY,category TEXT,asset_id INTEGER,metadata_json TEXT,assignment_revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE publication(token_id TEXT PRIMARY KEY,status TEXT);
    INSERT INTO assignments(token_id,category,asset_id,metadata_json) VALUES ('1','painting',12,'base'),('2','painting',4,'base'),('3','egg',10,'base');
    INSERT INTO publication VALUES('1','published'),('2','published'),('3','published');`);
  for (const statement of REVEAL_ENRICHMENT_SCHEMA) db.exec(statement);
  const target = '{"attributes":[]}';
  const hash = createHash('sha256').update(target).digest('hex');
  const insert = db.prepare('INSERT INTO reveal_enrichment(token_id,version,status,target_json,target_sha256) VALUES(?,?,?,?,?)');
  for (const id of ['1','3']) insert.run(id, 'v0', 'published', target, hash);
  insert.run('2', 'v0', 'conflict', target, hash);
  const recheck = (tokenId: string, write: boolean) => backfillRevealAttributePage(sql, { afterTokenId: null, recheckTokenId: tokenId, write });
  db.exec('PRAGMA query_only=ON');
  assert.equal(recheck('1', false).eligible, 1);
  assert.equal(acknowledgedEnrichmentHash(sql, '1', 'v0'), undefined);
  db.exec('PRAGMA query_only=OFF');
  for (const id of ['2','3','4']) assert.equal(recheck(id, true).eligible, 0);
  assert.equal(recheck('1', true).requeued, 1);
  assert.equal(acknowledgedEnrichmentHash(sql, '1', 'v0'), hash);
  const store = new EthereumRevealEnrichmentStore(sql, action => action());
  const [claimed] = store.claim(Date.now(), 1);
  assert.equal(claimed.target_json, target);
  assert.equal(recheck('1', true).requeued, 0);
  assert.equal(store.complete(claimed, 'conflict', Date.now()), true);
  assert.equal(recheck('1', false).conflict, 1);
  assert.equal(recheck('1', true).requeued, 1);
  const [retry] = store.claim(Date.now(), 1);
  assert.equal(retry.target_json, target);
  assert.equal(store.complete(retry, 'published', Date.now()), true);
  assert.equal(acknowledgedEnrichmentHash(sql, '1', 'v0'), hash);
  const tampered = '{"attributes":[1]}';
  db.prepare("UPDATE reveal_enrichment SET target_json=?,target_sha256=? WHERE token_id='1'")
    .run(tampered, createHash('sha256').update(tampered).digest('hex'));
  assert.throws(() => recheck('1', false), /acknowledged enrichment checksum/);
  assert.equal(recheck('1', true).conflict, 1);
  assert.equal(acknowledgedEnrichmentHash(sql, '1', 'v0'), hash);
});

for (const acknowledged of [false, true]) test(`a write-mode checksum failure commits a conflict (acknowledged=${acknowledged})`, t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const sql = revealSql(db);
  db.exec(`CREATE TABLE assignments(token_id TEXT PRIMARY KEY,category TEXT,asset_id INTEGER,metadata_json TEXT,assignment_revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE publication(token_id TEXT PRIMARY KEY,status TEXT);
    INSERT INTO assignments(token_id,category,asset_id,metadata_json) VALUES('9','painting',1,'base'),('10','painting',2,'base');
    INSERT INTO publication VALUES('9','published'),('10','published');`);
  for (const statement of REVEAL_ENRICHMENT_SCHEMA) db.exec(statement);
  const goodHash = createHash('sha256').update('original').digest('hex');
  db.prepare(`INSERT INTO reveal_enrichment(token_id,version,status,target_json,target_sha256,last_error,claim_id)
    VALUES('9','v0',?,'corrupt',?,?,?),('10','v0','published','original',?,NULL,NULL)`)
    .run(acknowledged ? 'pending' : 'published', goodHash, acknowledged ? 'conflict-recheck' : null,
      acknowledged ? 'old-claim' : null, goodHash);
  if (acknowledged) db.prepare("INSERT INTO reveal_enrichment_acknowledgments(token_id,version,target_sha256) VALUES('9','v0',?)").run(goodHash);
  const evidence = () => db.prepare('SELECT token_id,version,target_json,target_sha256,attempts FROM reveal_enrichment ORDER BY token_id').all();
  const original = evidence();
  const acknowledgments = db.prepare('SELECT * FROM reveal_enrichment_acknowledgments').all();
  const request = { afterTokenId: null, recheckTokenId: '9', write: false };
  db.exec('PRAGMA query_only=ON');
  assert.throws(() => backfillRevealAttributePage(sql, request), /checksum/);
  assert.equal(db.prepare("SELECT status FROM reveal_enrichment WHERE token_id='9'").get()?.status, acknowledged ? 'pending' : 'published');
  db.exec('PRAGMA query_only=OFF');
  db.exec('BEGIN');
  try {
    const result = backfillRevealAttributePage(sql, { ...request, write: true });
    assert.deepEqual(result, { eligible: 1, missing: 0, invalid: 0, conflict: 1, conflictRechecks: 0,
      enqueued: 0, requeued: 0, nextCursor: null });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  assert.deepEqual({ ...db.prepare("SELECT status,last_error,claim_id FROM reveal_enrichment WHERE token_id='9'").get() },
    { status: 'conflict', last_error: 'conflict', claim_id: null });
  assert.deepEqual(evidence(), original);
  assert.deepEqual(db.prepare('SELECT * FROM reveal_enrichment_acknowledgments').all(), acknowledgments);
  assert.equal(backfillRevealAttributePage(sql, { afterTokenId: null, write: false }).conflict, 1);
  const store = new EthereumRevealEnrichmentStore(sql, action => action());
  assert.deepEqual(store.claim(Date.now()), []);
  db.prepare("UPDATE reveal_enrichment SET target_json='original' WHERE token_id='9'").run();
  assert.equal(backfillRevealAttributePage(sql, { afterTokenId: null, write: true, retryBlocked: true }).requeued, 1);
  assert.equal(store.claim(Date.now())[0].target_json, 'original');
});

test('paged backfill counts a legacy ledger without writes and resumes enrollment without duplicating jobs', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const sql = revealSql(db);
  db.exec(`CREATE TABLE assignments(token_id TEXT PRIMARY KEY,category TEXT);
    CREATE TABLE publication(token_id TEXT PRIMARY KEY,status TEXT);
    WITH RECURSIVE n(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM n WHERE id<260)
    INSERT INTO assignments SELECT id,CASE WHEN id=13 THEN 'egg' ELSE 'painting' END FROM n;
    INSERT INTO publication SELECT token_id,CASE WHEN token_id='20' THEN 'conflict' WHEN token_id='30' THEN 'pending'
      ELSE 'published' END FROM assignments;`);
  function traverse(write: boolean) {
    let afterTokenId: string | null = null;
    let eligible = 0, missing = 0, enqueued = 0, pages = 0;
    do {
      const page = backfillRevealAttributePage(sql, { afterTokenId, write });
      eligible += page.eligible;
      missing += page.missing;
      enqueued += page.enqueued;
      pages++;
      if (page.nextCursor !== null) assert.ok(page.nextCursor > (afterTokenId ?? ''));
      afterTokenId = page.nextCursor;
    } while (afterTokenId !== null);
    return { eligible, missing, enqueued, pages };
  }
  db.exec('PRAGMA query_only=ON');
  assert.deepEqual(traverse(false), { eligible: 257, missing: 257, enqueued: 0, pages: 2 });
  db.exec('PRAGMA query_only=OFF');
  db.exec('ALTER TABLE assignments ADD COLUMN assignment_revision INTEGER NOT NULL DEFAULT 0');
  for (const statement of REVEAL_ENRICHMENT_SCHEMA) db.exec(statement);
  db.exec("INSERT INTO reveal_enrichment(token_id,version,status) VALUES('1','v0','invalid'), ('2','old','pending')");
  const interrupted = backfillRevealAttributePage(sql, { write: true, afterTokenId: null });
  assert.ok(interrupted.nextCursor);
  assert.ok(interrupted.enqueued > 0);
  assert.deepEqual(traverse(true), { eligible: 257, missing: 256 - interrupted.enqueued, enqueued: 256 - interrupted.enqueued, pages: 2 });
  assert.deepEqual(traverse(true), { eligible: 257, missing: 0, enqueued: 0, pages: 2 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reveal_enrichment WHERE token_id IN ('13','20','30')").get()?.n, 0);
  db.exec("UPDATE publication SET status='published' WHERE token_id='30'");
  assert.equal(db.prepare("SELECT token_id FROM reveal_enrichment WHERE status='pending' AND version='v0' ORDER BY next_check_ms,token_id LIMIT 1").get()?.token_id, '30');
  assert.equal(traverse(true).enqueued, 0);
  assert.equal(db.prepare("SELECT status FROM reveal_enrichment WHERE token_id='1' AND version='v0'").get()?.status, 'invalid');
});

test('repair requeues only eligible terminal v0 jobs and preserves the conflict target across reruns', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const sql = revealSql(db);
  db.exec(`CREATE TABLE assignments(token_id TEXT PRIMARY KEY, category TEXT,asset_id INTEGER, metadata_json TEXT,assignment_revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE publication(token_id TEXT PRIMARY KEY,status TEXT);
    WITH RECURSIVE n(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM n WHERE id<7)
    INSERT INTO assignments(token_id,category,asset_id,metadata_json) SELECT id,CASE WHEN id=6 THEN 'egg' ELSE 'painting' END,id,'base' FROM n;
    INSERT INTO publication SELECT token_id,CASE WHEN token_id='7' THEN 'conflict' ELSE 'published' END FROM assignments;`);
  for (const statement of REVEAL_ENRICHMENT_SCHEMA) db.exec(statement);
  db.exec(`INSERT INTO reveal_enrichment(token_id,version,status,last_error,attempts,claim_id,target_json,target_sha256) VALUES
    ('1','v0','invalid','invalid',3,NULL,NULL,NULL),
    ('2','v0','conflict','conflict',2,NULL,'frozen target','digest'),
    ('3','v0','pending','publication-unavailable',1,'active claim',NULL,NULL),
    ('4','v0','published',NULL,1,NULL,'published target','published digest'),
    ('1','old','invalid','invalid',1,NULL,NULL,NULL),
    ('6','v0','invalid','invalid',1,NULL,NULL,NULL),
    ('7','v0','invalid','invalid',1,NULL,NULL,NULL)`);
  const inspect = () => db.prepare('SELECT * FROM reveal_enrichment ORDER BY token_id,version').all();
  const originals = inspect();
  const request = { write: false, afterTokenId: null, retryBlocked: true };
  const expected = { eligible: 5, missing: 1, invalid: 1, conflict: 1, conflictRechecks: 0, enqueued: 0, requeued: 0, nextCursor: null };
  db.exec('PRAGMA query_only=ON');
  assert.deepEqual(backfillRevealAttributePage(sql, request), expected);
  db.exec('PRAGMA query_only=OFF');
  assert.deepEqual(backfillRevealAttributePage(sql, { ...request, write: true }), { ...expected, requeued: 2 });
  const repaired = inspect();
  assert.equal(repaired.length, originals.length);
  for (const [i, row] of originals.entries()) {
    if (row.version === 'v0' && (row.token_id === '1' || row.token_id === '2')) {
      assert.ok(Number(repaired[i].next_check_ms) > 0);
      assert.deepEqual({ ...repaired[i] }, { ...row, status: 'pending', last_error: row.status === 'conflict' ? 'conflict-recheck' : null,
        next_check_ms: repaired[i].next_check_ms });
    } else assert.deepEqual(repaired[i], row);
  }
  assert.deepEqual(backfillRevealAttributePage(sql, { ...request, write: true }), { ...expected, invalid: 0, conflict: 0, conflictRechecks: 1 });
  assert.deepEqual(inspect(), repaired);
  const store = new EthereumRevealEnrichmentStore(sql, action => action());
  db.prepare("UPDATE reveal_enrichment SET next_check_ms=0 WHERE token_id='2' AND version='v0'").run();
  const [check] = store.claim(Date.now(), 1);
  assert.equal(check.target_json, 'frozen target');
  assert.equal(store.complete(check, 'publication-unavailable', Date.now()), true);
  const lastError = () => db.prepare("SELECT last_error FROM reveal_enrichment WHERE token_id='2' AND version='v0'").get()?.last_error;
  assert.equal(lastError(), 'conflict-recheck');
  assert.equal(backfillRevealAttributePage(sql, request).conflictRechecks, 1);
  db.prepare("UPDATE reveal_enrichment SET next_check_ms=0 WHERE token_id='2' AND version='v0'").run();
  const [retry] = store.claim(Date.now(), 1);
  assert.equal(retry.target_json, check.target_json);
  assert.equal(store.complete(retry, 'published', Date.now()), true);
  assert.equal(lastError(), null);
  assert.equal(backfillRevealAttributePage(sql, request).conflictRechecks, 0);
});

test('attribute audit is query-only, bounded, frozen, and resolves owner metadata independently of the assignment origin', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const sql = revealSql(db);
  const templateJson = JSON.stringify({ name: '{{tokenId}}', description: '', image: 'https://cdn.lil.org/nft/111k/placeholder.png', attributes: [] });
  const deployment: EthereumRevealDeployment = { deploymentId: 'mainnet-audit', chainId: 1, dropId: '111k',
    contractAddress: `0x${'ab'.repeat(20)}`, metadataBaseUri: 'https://cdn.mons.shop/111k/mainnet-audit/', deploymentBlock: 100,
    catalogVersion: '111k-v9', templateJson, templateSha256: createHash('sha256').update(templateJson).digest('hex'),
    state: 'active', revision: 3, createdAtMs: 1, updatedAtMs: 3, activatedAtMs: 3, provisionedAtMs: 2, lastError: null };
  const store = new EthereumRevealStore(sql, action => action());
  store.configure(deployment);
  db.exec("INSERT INTO crates(crate_token_id) VALUES('111112')");
  const catalog = getRevealCatalog('111k-v9')!;
  const observation = { transactionHash: `0x${'1'.repeat(64)}`, blockHash: `0x${'2'.repeat(64)}`, blockNumber: 101 };
  const values = new Map<string, ReturnType<typeof buildRevealedArtwork>>();
  for (let id = 1; id <= 260; id++) {
    const tokenId = String(id);
    const category = id === 13 || id === 14 ? 'egg' : 'painting';
    const built = buildRevealedArtwork({ category: id === 15 ? 'egg' : category, assetId: id === 15 ? 70000 : id,
      tokenId, crateTokenId: '111112', templateJson, observation, catalog, allocatedEgg: id === 15 });
    values.set(tokenId, built);
    db.prepare(`INSERT INTO assignments(category,asset_id,crate_token_id,slot,token_id,artwork_json,metadata_json,placeholder_json,frozen_at_ms)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(category, id, '111112', id - 1, tokenId, JSON.stringify(built.artwork), built.metadataJson, built.placeholderJson, id >= 259 ? 2001 : 1000);
    db.prepare('INSERT INTO publication(token_id,status) VALUES(?,?)').run(tokenId, id === 259 ? 'pending' : 'published');
  }
  const largeAttributes = [{ trait_type: 'collection block', value: 'plane of existence' }, { trait_type: 'large', value: 'x'.repeat(512 * 1024 - 1024) }];
  const target = JSON.stringify({ ...JSON.parse(values.get('1')!.metadataJson), attributes: largeAttributes }) + '\n';
  const targetSha256 = createHash('sha256').update(target).digest('hex');
  db.prepare(`INSERT INTO reveal_enrichment(token_id,version,status,target_json,target_sha256,attempts) VALUES('1','v0','published',?,?,2)`)
    .run(target, targetSha256);
  const thirdTarget = JSON.stringify({ ...JSON.parse(values.get('3')!.metadataJson), attributes: largeAttributes }) + '\n';
  const thirdSha256 = createHash('sha256').update(thirdTarget).digest('hex');
  db.prepare(`INSERT INTO reveal_enrichment(token_id,version,status,target_json,target_sha256,attempts) VALUES('3','v0','published',?,?,2)`)
    .run(thirdTarget, thirdSha256);
  db.exec("INSERT INTO reveal_enrichment(token_id,version,status,last_error,attempts) VALUES('2','v0','invalid','invalid',1)");
  const owner = buildRevealedArtwork({ category: 'painting', assetId: 41171, tokenId: '14', crateTokenId: '111112', templateJson, observation, catalog });
  const ownerHash = createHash('sha256').update(owner.metadataJson).digest('hex');
  const canonical = { tokenId: '14', category: 'painting', assetId: 41171, assignmentRevision: 0, metadataRevision: 4,
    artwork: owner.artwork, metadataJson: owner.metadataJson, targetSha256: ownerHash,
    expectedJsons: [values.get('14')!.metadataJson], allowMissing: false, migration: false };
  db.prepare(`INSERT INTO owner_hatching_batches(batch_id,source_sha256,input_sha256,ready_count,grail_count,fresh_egg_count,created_at_ms)
    VALUES('owner-audit',?,?,1,0,1,1000)`).run('a'.repeat(64), 'b'.repeat(64));
  db.prepare(`INSERT INTO owner_hatching_tokens(token_id,batch_id,egg_id,original_json,status,canonical_json,metadata_revision,hatched_at_ms)
    VALUES('14','owner-audit',14,?,'hatched',?,4,1001)`).run(JSON.stringify(canonical), JSON.stringify(canonical));
  db.exec("INSERT INTO owner_hatching_publication(token_id,metadata_revision,status) VALUES('14',4,'published')");
  db.exec(`INSERT INTO owner_hatching_slot_overrides(origin_category,origin_asset_id,category,asset_id,token_id)
    VALUES('painting',15,'egg',70000,'14');
    INSERT INTO reveal_enrichment(token_id,version,status,last_error)
      VALUES('14','v0','invalid','obsolete-owner-job'),('15','v0','invalid','obsolete-replaced-slot');`);
  const before = db.prepare('SELECT * FROM reveal_enrichment ORDER BY token_id').all();
  db.exec('PRAGMA query_only=ON');
  const auditSql: RevealSql = { exec<T extends Record<string, string | number | null | ArrayBuffer>>(query: string,
    ...args: Array<string | number | null | ArrayBuffer>) {
    const records = sql.exec<T>(query, ...args).toArray();
    if (records.length > 1) assert.ok(records.reduce((bytes, row) => bytes + JSON.stringify(row).length, 0) < 128 * 1024,
      'Audit must not materialize large metadata bodies for a full page');
    return { toArray: () => records };
  } };
  const first = backfillRevealAttributePage(auditSql, { afterTokenId: null, write: false, audit: true, frozenThroughMs: 2000 });
  assert.equal(first.tokens!.length, 256);
  assert.ok(first.nextCursor);
  const second = backfillRevealAttributePage(auditSql, { afterTokenId: first.nextCursor, write: false, audit: true, frozenThroughMs: 2000 });
  assert.equal(second.nextCursor, null);
  const tokens = [...first.tokens!, ...second.tokens!];
  assert.equal(tokens.length, 258);
  assert.equal(new Set(tokens.map(row => row.tokenId)).size, 258);
  assert.equal(tokens.some(row => row.tokenId === '259' || row.tokenId === '260'), false);
  const enriched = tokens.find(row => row.tokenId === '1')!;
  assert.equal(enriched.metadataSha256, targetSha256);
  assert.equal(enriched.metadataRevision, 1);
  assert.equal(enriched.frozenMetadataSha256, createHash('sha256').update(values.get('1')!.metadataJson).digest('hex'));
  assert.deepEqual(enriched.enrichment, { status: 'published', assignmentRevision: 0, attempts: 2,
    lastError: null, targetSha256, checksumValid: true });
  assert.equal(tokens.find(row => row.tokenId === '2')!.enrichment!.status, 'invalid');
  assert.equal(tokens.find(row => row.tokenId === '3')!.metadataSha256, thirdSha256);
  assert.equal(tokens.find(row => row.tokenId === '13')!.collectionBlock, null);
  const hatched = tokens.find(row => row.tokenId === '14')!;
  assert.equal(hatched.category, 'painting');
  assert.equal(hatched.assetId, 41171);
  assert.equal(hatched.collectionBlock, 'little swag');
  assert.equal(hatched.metadataSha256, ownerHash);
  assert.equal(hatched.metadataRevision, 4);
  assert.equal(hatched.enrichment, null);
  assert.equal(tokens.find(row => row.tokenId === '15')!.category, 'egg');
  assert.equal(tokens.find(row => row.tokenId === '15')!.enrichment, null);
  assert.equal(first.invalid + second.invalid, 1);
  assert.deepEqual(db.prepare('SELECT * FROM reveal_enrichment ORDER BY token_id').all(), before);
});

test('audit rejects unsettled pre-cutoff publications on every page instead of silently skipping them', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const sql = revealSql(db);
  db.exec(`CREATE TABLE settings(id INTEGER,deployment_json TEXT);
    CREATE TABLE assignments(token_id TEXT PRIMARY KEY,category TEXT,asset_id INTEGER,crate_token_id TEXT,
      artwork_json TEXT,metadata_json TEXT,placeholder_json TEXT,frozen_at_ms INTEGER,assignment_revision INTEGER);
    CREATE TABLE publication(token_id TEXT PRIMARY KEY,status TEXT,metadata_revision INTEGER);`);
  db.prepare('INSERT INTO settings VALUES(1,?)').run(JSON.stringify({ catalogVersion: '111k-v9' }));
  for (const statement of REVEAL_ENRICHMENT_SCHEMA) db.exec(statement);
  for (let id = 1; id <= 259; id++) {
    const base = JSON.stringify({ name: String(id), category: 'painting', attributes: [] });
    const target = JSON.stringify({ name: String(id), category: 'painting', attributes: [{ trait_type: 'collection block', value: 'plane of existence' }] });
    db.prepare('INSERT INTO assignments VALUES(?,?,?,?,?,?,?,?,0)').run(String(id), 'painting', id, '111112', base, base, 'placeholder', id === 259 ? 2001 : 1000);
    db.prepare('INSERT INTO publication VALUES(?,?,0)').run(String(id), id === 100 || id === 259 ? 'pending' : 'published');
    if (id !== 100 && id !== 259) db.prepare(`INSERT INTO reveal_enrichment(token_id,version,status,target_json,target_sha256)
      VALUES(?,'v0','published',?,?)`).run(String(id), target, createHash('sha256').update(target).digest('hex'));
  }
  const audit = (afterTokenId: string | null = null) => backfillRevealAttributePage(sql,
    { audit: true, write: false, frozenThroughMs: 2000, afterTokenId });
  for (const status of ['pending', 'conflict', null]) {
    db.exec('PRAGMA query_only=OFF');
    if (status === null) db.exec("DELETE FROM publication WHERE token_id='100'");
    else db.prepare("UPDATE publication SET status=? WHERE token_id='100'").run(status);
    db.exec('PRAGMA query_only=ON');
    assert.throws(() => audit(), /complete metadata publication/);
    assert.throws(() => audit('200'), /complete metadata publication/);
  }
  db.exec(`PRAGMA query_only=OFF;
    INSERT INTO publication VALUES('100','published',0);
    INSERT INTO reveal_enrichment(token_id,version,status,last_error) VALUES('100','v0','invalid','invalid');
    PRAGMA query_only=ON;`);
  const first = audit();
  assert.equal(first.tokens!.length, 256);
  assert.ok(first.nextCursor);
  assert.equal(first.tokens!.find(row => row.tokenId === '100')!.enrichment!.status, 'invalid');
  db.exec("PRAGMA query_only=OFF;UPDATE publication SET status='pending' WHERE token_id='1';PRAGMA query_only=ON;");
  assert.throws(() => audit(first.nextCursor), /complete metadata publication/);
  db.exec("PRAGMA query_only=OFF;UPDATE publication SET status='published' WHERE token_id='1';PRAGMA query_only=ON;");
  const second = audit(first.nextCursor);
  assert.equal(second.nextCursor, null);
  const tokens = [...first.tokens!, ...second.tokens!];
  assert.equal(tokens.length, 258);
  assert.equal(new Set(tokens.map(row => row.tokenId)).size, 258);
  assert.equal(tokens.some(row => row.tokenId === '259'), false);
  assert.equal(first.invalid + second.invalid, 1);
  assert.equal(first.missing + second.missing, 0);
});

test('audit follows owner publication through takeover and ignores superseded initial publication state', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const sql = revealSql(db);
  db.exec(`CREATE TABLE settings(id INTEGER,deployment_json TEXT);
    CREATE TABLE assignments(token_id TEXT PRIMARY KEY,category TEXT,asset_id INTEGER,crate_token_id TEXT,
      artwork_json TEXT,metadata_json TEXT,placeholder_json TEXT,frozen_at_ms INTEGER,assignment_revision INTEGER);
    CREATE TABLE publication(token_id TEXT PRIMARY KEY,status TEXT,metadata_revision INTEGER);`);
  db.prepare('INSERT INTO settings VALUES(1,?)').run(JSON.stringify({ catalogVersion: '111k-v9' }));
  const templateJson = JSON.stringify({ name: '{{tokenId}}', image: 'https://cdn.lil.org/nft/111k/placeholder.png', attributes: [] });
  const observation = { transactionHash: `0x${'1'.repeat(64)}`, blockHash: `0x${'2'.repeat(64)}`, blockNumber: 101 };
  const catalog = getRevealCatalog('111k-v9')!;
  const base = buildRevealedArtwork({ templateJson, tokenId: '1', crateTokenId: '111112', category: 'egg', assetId: 1, observation, catalog });
  db.prepare('INSERT INTO assignments VALUES(?,?,?,?,?,?,?,?,0)').run('1', 'egg', 1, '111112', JSON.stringify(base.artwork),
    base.metadataJson, base.placeholderJson, 1000);
  db.exec("INSERT INTO publication VALUES('1','pending',0)");
  const original: OwnerHatchingCanonical = { tokenId: '1', category: 'egg', assetId: 1, assignmentRevision: 0, metadataRevision: 0,
    artwork: base.artwork, metadataJson: base.metadataJson, targetSha256: createHash('sha256').update(base.metadataJson).digest('hex'),
    expectedJsons: [base.placeholderJson, base.metadataJson], allowMissing: true, migration: false };
  const owners = new EthereumOwnerHatchingStore(sql, action => action(), {
    canonical: tokenId => tokenId === '1' ? original : null,
    originForToken: () => ({ category: 'egg', assetId: 1 }),
    build: (tokenId, asset) => buildNewRevealedArtwork({ templateJson, tokenId, crateTokenId: '111112',
      category: asset.category, assetId: asset.assetId, observation, catalog, ownerHatching: true }),
    takeOrdinary: () => ({ origin: { category: 'painting', assetId: 41171 }, effective: { category: 'painting', assetId: 41171 } }),
    transitionSlot: () => {}, releaseReplacement: () => {}, freshEggAvailable: eggId => eggId === 70000, eligibleEgg: () => true,
  }, () => 0);
  owners.initialize();
  owners.prepare({ batchId: 'owner-audit-takeover', sourceSha256: 'a'.repeat(64), candidateTokenIds: ['1'], readyCount: 1,
    grails: [], freshEggIds: [70000] }, 1500);
  assert.equal(owners.hatch('1', 2000).kind, 'hatched');
  const audit = (afterTokenId: string | null = null) => backfillRevealAttributePage(sql,
    { audit: true, write: false, frozenThroughMs: 2500, afterTokenId });
  const mutate = (statement: string) => db.exec(`PRAGMA query_only=OFF;${statement};PRAGMA query_only=ON;`);
  db.exec('PRAGMA query_only=ON');
  assert.throws(() => audit(), /complete metadata publication/);
  mutate("UPDATE publication SET status='published' WHERE token_id='1'");
  assert.throws(() => audit(), /complete metadata publication/);
  db.exec("PRAGMA query_only=OFF;UPDATE publication SET status='pending' WHERE token_id='1';");
  const jobs = owners.claimPublications(2001);
  assert.equal(owners.completePublications(jobs.map(job => ({ job, status: 'published' as const })), 2002).length, 1);
  db.exec('PRAGMA query_only=ON');
  for (const initialState of ['pending', 'conflict', null, 'published']) {
    mutate(initialState === null ? "DELETE FROM publication WHERE token_id='1'"
      : `INSERT INTO publication VALUES('1','${initialState}',0) ON CONFLICT(token_id) DO UPDATE SET status=excluded.status`);
    const page = audit();
    assert.equal(page.tokens!.length, 1);
    assert.equal(page.tokens![0].category, 'painting');
    assert.equal(page.tokens![0].assetId, 41171);
    assert.equal(page.tokens![0].metadataSha256, owners.canonical('1')!.targetSha256);
    assert.equal(page.tokens![0].collectionBlock, 'little swag');
  }
  for (const ownerState of ['pending', 'conflict', null]) {
    mutate(ownerState === null ? "DELETE FROM owner_hatching_publication WHERE token_id='1'"
      : `UPDATE owner_hatching_publication SET status='${ownerState}' WHERE token_id='1'`);
    assert.throws(() => audit(), /complete metadata publication/);
    assert.throws(() => audit('2'), /complete metadata publication/);
  }
  mutate("INSERT INTO owner_hatching_publication(token_id,metadata_revision,status) VALUES('1',999,'published')");
  assert.throws(() => audit(), /complete metadata publication/);
});
