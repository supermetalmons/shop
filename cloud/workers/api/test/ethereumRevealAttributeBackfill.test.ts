import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { backfillRevealAttributePage } from '../src/ethereumRevealAttributeBackfill.ts';
import { acknowledgedEnrichmentHash, EthereumRevealEnrichmentStore, REVEAL_ENRICHMENT_SCHEMA } from '../src/ethereumRevealEnrichmentStore.ts';
import { parseRevealAttributeBackfillRequest } from '../src/ethereumRevealMaintenanceSupport.ts';
import type { RevealSql } from '../src/ethereumRevealStore.ts';

function revealSql(db: DatabaseSync): RevealSql {
  return { exec<T>(query: string, ...args: Array<string | number | null | ArrayBuffer>) {
    const rows = db.prepare(query).all(...args.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value));
    return { toArray: () => rows as T[] };
  } };
}

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
  for (const changed of [{ write: 'false' }, { deploymentId: null }, { expectedRevision: -1 }, { afterTokenId: 0 },
    { afterTokenId: '0001' }, { afterTokenId: '111112' }, { afterTokenId: undefined }, { retryBlocked: 'true' },
    { recheckTokenId: '01' }, { recheckTokenId: '111112' }, { recheckTokenId: '42', retryBlocked: true },
    { recheckTokenId: '42', afterTokenId: '1' }, { force: true }]) {
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
