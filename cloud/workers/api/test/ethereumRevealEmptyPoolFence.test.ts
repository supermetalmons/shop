import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.ts';
import { EthereumRevealStore, type RevealSql } from '../src/ethereumRevealStore.ts';
import { EthereumRevealEmptyPoolFence, ETHEREUM_REVEAL_EMPTY_POOL_DRAIN_MS,
  type EthereumRevealEmptyPoolFenceScope } from '../src/ethereumRevealEmptyPoolFence.ts';

const templateJson = JSON.stringify({ name: '{{tokenId}}', description: '', image: 'https://cdn.lil.org/nft/111k/placeholder.png', attributes: [] });
const deployment: EthereumRevealDeployment = { deploymentId: 'mainnet-empty-test', dropId: '111k', chainId: 1,
  contractAddress: `0x${'ab'.repeat(20)}`, metadataBaseUri: 'https://cdn.mons.shop/111k/', deploymentBlock: 100,
  catalogVersion: '111k-v8', templateJson, templateSha256: createHash('sha256').update(templateJson).digest('hex'),
  state: 'paused', revision: 5, createdAtMs: 1, updatedAtMs: 2, provisionedAtMs: 1, activatedAtMs: 2, lastError: null };
const scope: EthereumRevealEmptyPoolFenceScope = { operationId: 'empty-test', deploymentId: deployment.deploymentId,
  batchSha256: 'a'.repeat(64), expectedRevision: 5 };
const acquiredAt = 1000;
const drainedAt = acquiredAt + ETHEREUM_REVEAL_EMPTY_POOL_DRAIN_MS;

function fixture(t: TestContext, initialized = true) {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys=ON');
  t.after(() => database.close());
  const statements = new Map<string, StatementSync>();
  let fail: string | null = null;
  const sql: RevealSql = { exec<T extends Record<string, string | number | null | ArrayBuffer>>(query: string, ...bindings: Array<string | number | null | ArrayBuffer>) {
    if (fail && query.includes(fail)) throw new Error('injected SQL failure');
    let statement = statements.get(query);
    if (!statement) statements.set(query, statement = database.prepare(query));
    const parameters = bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    const rows = statement.columns().length ? statement.all(...parameters) : (statement.run(...parameters), []);
    return { toArray: () => rows as T[] };
  } };
  let depth = 0;
  const transaction = <T>(action: () => T): T => {
    if (depth) return action();
    database.exec('BEGIN IMMEDIATE');
    depth++;
    try { const value = action(); database.exec('COMMIT'); return value; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
    finally { depth--; }
  };
  const fence = new EthereumRevealEmptyPoolFence(sql, transaction);
  let store: EthereumRevealStore | undefined;
  if (initialized) {
    store = new EthereumRevealStore(sql, transaction, () => 0);
    store.configure(deployment);
    while (!store.initializeChunk()) {}
  }
  const seedTransaction = () => database.prepare(`INSERT INTO transactions(hash,status,from_block,created_at_ms,last_requested_at_ms)
    VALUES('tx','not_unpack',100,0,0)`).run();
  return { database, sql, transaction, fence, store, seedTransaction,
    injectFailure: (value: string | null) => { fail = value; },
    reopen: () => new EthereumRevealEmptyPoolFence(sql, transaction) };
}

test('empty-pool fence inspection is read-only before initialization and validates identities', t => {
  const f = fixture(t, false);
  assert.equal(f.fence.status(), null);
  assert.equal(f.fence.inspect(scope), null);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='table'").get()!.count, 0);
  for (const invalid of [{ ...scope, operationId: 'invalid/name' }, { ...scope, deploymentId: '' },
    { ...scope, batchSha256: 'bad' }, { ...scope, expectedRevision: 0 }]) {
    assert.throws(() => f.fence.acquire(invalid, acquiredAt), /scope/);
  }
});

test('writer fence pins its original scope and drain across restarts and rejects concurrent owners', t => {
  const f = fixture(t);
  const first = f.fence.acquire(scope, acquiredAt);
  assert.equal(first.drainUntilMs, drainedAt);
  assert.deepEqual(f.reopen().acquire(scope, acquiredAt + 100), first);
  assert.deepEqual(f.reopen().status(), first);
  assert.throws(() => f.fence.acquire({ ...scope, operationId: 'another-operation' }, acquiredAt), /Another/);
  for (const changed of [{ ...scope, deploymentId: 'other' }, { ...scope, batchSha256: 'b'.repeat(64) },
    { ...scope, expectedRevision: 6 }]) assert.throws(() => f.fence.inspect(changed), /identity|revision/);
  assert.throws(() => f.fence.assertWritable(), /fenced/);
});

test('persistent SQL triggers fence every user ledger table and block old reservation and writer paths', t => {
  const f = fixture(t);
  f.fence.acquire(scope, acquiredAt);
  const tables = f.database.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()
    .map(row => String(row.name)).filter(name => !name.startsWith('sqlite_') && name !== 'reveal_empty_pool_fences');
  for (const table of tables) {
    const triggers = f.database.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name=? AND name LIKE 'reveal_empty_fence_%'").all(table);
    assert.equal(triggers.length, 3, table);
  }
  assert.throws(() => f.store!.reserve(['111112']), /fenced/);
  assert.throws(() => f.database.exec('UPDATE settings SET ready=1 WHERE id=1'), /fenced/);
  assert.throws(() => f.database.exec("DELETE FROM free_slots WHERE category='egg' AND slot=0"), /fenced/);
  assert.throws(() => f.database.exec("INSERT INTO recovery_jobs(id,token_ids_json,ranges_json) VALUES('late','[1]','[]')"), /fenced/);
  assert.throws(() => f.database.exec("INSERT INTO publication(token_id) VALUES('1')"), /fenced/);
  assert.throws(() => f.database.exec("INSERT INTO reveal_enrichment(token_id,version) VALUES('1','v0')"), /fenced/);
  assert.throws(() => new EthereumRevealStore(f.sql, f.transaction), /fenced/);
  assert.doesNotThrow(() => f.fence.withRebuild(scope, () => new EthereumRevealStore(f.sql, f.transaction)));
});

test('private rebuild writes are synchronous, atomic and never leave bypass enabled', t => {
  const f = fixture(t);
  f.fence.acquire(scope, acquiredAt);
  const before = f.database.prepare("SELECT available FROM pools WHERE category='egg'").get()!.available;
  f.fence.withRebuild(scope, () => f.database.exec('UPDATE settings SET ready=1'));
  assert.throws(() => f.fence.withRebuild(scope, () => {
    f.database.exec("UPDATE pools SET available=available-1 WHERE category='egg'");
    throw new Error('private failure');
  }), /private failure/);
  assert.equal(f.database.prepare("SELECT available FROM pools WHERE category='egg'").get()!.available, before);
  assert.throws(() => f.fence.withRebuild(scope, () => {
    f.database.exec("UPDATE pools SET available=available-1 WHERE category='egg'");
    return Promise.resolve();
  }), /synchronous/);
  assert.equal(f.database.prepare("SELECT available FROM pools WHERE category='egg'").get()!.available, before);
  assert.equal(f.database.prepare('SELECT bypass FROM reveal_empty_pool_fences').get()!.bypass, 0);
  assert.throws(() => f.database.exec('UPDATE settings SET ready=1'), /fenced/);
});

test('failed bypass reset rolls back private writes and remains fenced on restart', t => {
  const f = fixture(t);
  f.fence.acquire(scope, acquiredAt);
  f.injectFailure('SET bypass=0');
  assert.throws(() => f.fence.withRebuild(scope, () => f.database.exec('UPDATE settings SET ready=0')), /injected/);
  f.injectFailure(null);
  assert.equal(f.database.prepare('SELECT ready FROM settings').get()!.ready, 1);
  assert.equal(f.database.prepare('SELECT bypass FROM reveal_empty_pool_fences').get()!.bypass, 0);
  assert.doesNotThrow(() => f.reopen().assertEmpty(scope, drainedAt));
  assert.doesNotThrow(() => f.fence.withRebuild(scope, () => f.database.exec('UPDATE settings SET ready=1')));
});

test('late callback cannot borrow the private bypass and new tables receive persistent guards', async t => {
  const f = fixture(t);
  f.fence.acquire(scope, acquiredAt);
  const late = Promise.resolve().then(() => assert.throws(() => f.database.exec('UPDATE settings SET ready=0'), /fenced/));
  f.fence.withRebuild(scope, () => {
    f.database.exec('CREATE TABLE added_ledger(id INTEGER PRIMARY KEY)');
    f.database.exec('INSERT INTO added_ledger VALUES(1)');
  });
  await late;
  assert.throws(() => f.database.exec('INSERT INTO added_ledger VALUES(2)'), /fenced/);
  assert.throws(() => f.database.exec('UPDATE added_ledger SET id=2'), /fenced/);
  assert.throws(() => f.database.exec('DELETE FROM added_ledger'), /fenced/);
});

test('drain is mandatory and release preserves immutable operation evidence', t => {
  const f = fixture(t);
  f.fence.acquire(scope, acquiredAt);
  assert.equal(f.fence.inspectEmpty(scope, drainedAt - 1).drained, false);
  assert.throws(() => f.fence.assertEmpty(scope, drainedAt - 1), /drain/);
  assert.throws(() => f.fence.release(scope, drainedAt - 1), /drain/);
  const proof = f.fence.assertEmpty(scope, drainedAt);
  assert.equal(proof.ready, true);
  assert.equal(proof.empty, true);
  assert.ok(Object.values(proof.counts).every(value => value === 0));
  const released = f.fence.withRebuild(scope, () => f.fence.release(scope, drainedAt));
  assert.equal(released.releasedAtMs, drainedAt);
  assert.equal(f.fence.status(), null);
  assert.deepEqual(f.reopen().inspect(scope), released);
  assert.deepEqual(f.fence.release(scope, drainedAt + 100), released);
  assert.throws(() => f.fence.acquire(scope, drainedAt), /released/);
  assert.doesNotThrow(() => f.store!.reserve(['111112']));
});

test('private reservations block empty proof and are not removed', t => {
  const f = fixture(t);
  f.store!.reserve(['111112']);
  f.fence.acquire(scope, acquiredAt);
  const proof = f.fence.inspectEmpty(scope, drainedAt);
  assert.equal(proof.counts.assignments, 20);
  assert.equal(proof.counts.reserved, 20);
  assert.equal(proof.counts.frozen, 0);
  assert.throws(() => f.fence.assertEmpty(scope, drainedAt), /not empty/);
  assert.throws(() => f.fence.release(scope, drainedAt), /not empty/);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM assignments').get()!.count, 20);
});

test('confirmed assignments block rebuild even when all ordinary publication has finished', t => {
  const f = fixture(t);
  const tokenIds = Array.from({ length: 20 }, (_, index) => String(index + 1));
  f.store!.freeze(deployment, { transactionHash: `0x${'1'.repeat(64)}`, blockHash: `0x${'2'.repeat(64)}`, blockNumber: 101 },
    [{ crateTokenId: '111112', tokenIds }], 1);
  for (const tokenId of tokenIds) f.store!.publicationComplete(tokenId);
  f.fence.acquire(scope, acquiredAt);
  const proof = f.fence.inspectEmpty(scope, drainedAt);
  assert.equal(proof.counts.reserved, 0);
  assert.equal(proof.counts.frozen, 20);
  assert.throws(() => f.fence.assertEmpty(scope, drainedAt), /not empty/);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM assignments').get()!.count, 20);
});

test('preactivation abort preserves discovered work and waits for writer drain before resuming it', t => {
  const f = fixture(t);
  f.store!.reserve(['111112']);
  const before = f.database.prepare('SELECT * FROM assignments ORDER BY slot').all();
  f.fence.acquire(scope, acquiredAt);
  assert.throws(() => f.fence.abort(scope, drainedAt - 1), /drain/);
  assert.throws(() => f.fence.abort({ ...scope, expectedRevision: 6 }, drainedAt), /identity|revision/);
  const released = f.fence.abort(scope, drainedAt);
  assert.equal(released.releasedAtMs, drainedAt);
  assert.deepEqual(f.database.prepare('SELECT * FROM assignments ORDER BY slot').all(), before);
  assert.doesNotThrow(() => f.fence.assertWritable());
  assert.doesNotThrow(() => f.store!.reserve(['111113']));
});

test('abort cannot reopen ordinary writers after the replacement generation activates', t => {
  const f = fixture(t);
  f.database.prepare(`INSERT INTO reveal_catalog_generations(batch_id,batch_sha256,predecessor_json,target_json,target_manifest_json,
    source_revision,target_revision,mapping_count,mapping_sha256,phase,started_at_ms,activated_at_ms)
    VALUES(?,?, '{}','{}','{}',0,1,1,?,'active',0,1)`).run(scope.operationId, scope.batchSha256, scope.batchSha256);
  f.fence.acquire(scope, acquiredAt);
  assert.throws(() => f.fence.abort(scope, drainedAt), /activated/);
  assert.throws(() => f.fence.assertWritable(), /fenced/);
});

test('terminal receipt and unminted-token history remain intact while proof rejects pending work', t => {
  const f = fixture(t);
  f.seedTransaction();
  f.database.exec("INSERT INTO receipt_work(hash,resolved,created_at_ms) VALUES('tx',1,0)");
  f.database.exec("INSERT INTO token_recovery(token_id,status) VALUES('1','unminted')");
  f.fence.acquire(scope, acquiredAt);
  assert.equal(f.fence.assertEmpty(scope, drainedAt).empty, true);
  f.fence.withRebuild(scope, () => f.database.exec("UPDATE receipt_work SET request_pending=1 WHERE hash='tx'"));
  assert.equal(f.fence.inspectEmpty(scope, drainedAt).counts.pendingReceipts, 1);
  assert.throws(() => f.fence.assertEmpty(scope, drainedAt), /not empty/);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM transactions').get()!.count, 1);
});

for (const [name, seed] of [
  ['recovery_jobs', "INSERT INTO recovery_jobs(id,token_ids_json,ranges_json) VALUES('work','[1]','[]')"],
  ['pendingTokens', "INSERT INTO token_recovery(token_id,status) VALUES('1','recovering')"],
  ['pendingReceipts', "INSERT INTO receipt_work(hash,created_at_ms) VALUES('tx',0)"],
  ['staleReceiptClaim', "INSERT INTO receipt_work(hash,resolved,claim_id,created_at_ms) VALUES('tx',1,'old-claim',0)"],
  ['reveal_overflow_claims', "INSERT INTO reveal_overflow_claims(hash,claim_id,started_at_ms,lease_until_ms) VALUES('tx','expired',0,1)"],
  ['crate_recovery_jobs', "INSERT INTO crate_recovery_jobs(crate_token_id,from_block) VALUES('111112',100)"],
  ['receipt_claim_crates', "INSERT INTO receipt_claim_crates(hash,claim_id,crate_token_id,evidence_version,generation) VALUES('tx','claim','111112',0,0)"],
  ['receipt_claim_tokens', "INSERT INTO receipt_claim_tokens(hash,claim_id,token_id) VALUES('tx','claim','1')"],
  ['publication', "INSERT INTO publication(token_id) VALUES('1')"],
  ['reveal_enrichment', "INSERT INTO reveal_enrichment(token_id,version) VALUES('1','v0')"],
  ['pendingTransactions', "UPDATE transactions SET status='pending' WHERE hash='tx'"],
  ['pendingReplacementChunks', "INSERT INTO replacement_chunks(original_hash,chunk_index,crate_ids_json,from_block,generation) VALUES('tx',0,'[]',100,0)"],
] as const) test(`empty proof rejects ${name} even when nothing is due or assigned`, t => {
  const f = fixture(t);
  f.seedTransaction();
  f.database.exec('PRAGMA foreign_keys=OFF');
  f.database.exec(seed);
  f.fence.acquire(scope, acquiredAt);
  const proof = f.fence.inspectEmpty(scope, drainedAt);
  assert.equal(proof.counts.assignments, 0);
  assert.equal(proof.counts[name === 'staleReceiptClaim' ? 'pendingReceipts' : name], 1);
  assert.throws(() => f.fence.assertEmpty(scope, drainedAt), /not empty/);
});

test('empty proof permits only its own candidate generation and requires ready recovery migration', t => {
  const f = fixture(t);
  f.database.prepare(`INSERT INTO reveal_catalog_generations(batch_id,batch_sha256,predecessor_json,target_json,target_manifest_json,
    source_revision,target_revision,mapping_count,mapping_sha256,phase,started_at_ms)
    VALUES(?,?, '{}','{}','{}',0,1,1,?,'mapping',0)`).run(scope.operationId, scope.batchSha256, scope.batchSha256);
  f.database.prepare('UPDATE settings SET candidate_catalog_generation=?').run(scope.operationId);
  f.fence.acquire(scope, acquiredAt);
  assert.doesNotThrow(() => f.fence.assertEmpty(scope, drainedAt));
  f.fence.withRebuild(scope, () => f.database.exec("UPDATE settings SET candidate_catalog_generation='foreign'"));
  assert.equal(f.fence.inspectEmpty(scope, drainedAt).counts.foreignCandidate, 1);
  assert.throws(() => f.fence.assertEmpty(scope, drainedAt), /not empty/);
  f.fence.withRebuild(scope, () => {
    f.database.prepare('UPDATE settings SET candidate_catalog_generation=?').run(scope.operationId);
    f.database.exec("UPDATE reveal_recovery_migration SET phase='transactions'");
  });
  assert.equal(f.fence.inspectEmpty(scope, drainedAt).ready, false);
  assert.throws(() => f.fence.assertEmpty(scope, drainedAt), /not empty and ready/);
});

test('native Durable Object SQLite fences user tables after a KV journal write and rolls back scoped writes', { timeout: 30_000 }, async () => {
  const source = `import { DurableObject } from 'cloudflare:workers';
    import { EthereumRevealEmptyPoolFence } from ${JSON.stringify(resolve('cloud/workers/api/src/ethereumRevealEmptyPoolFence.ts'))};
    const scope=${JSON.stringify(scope)};
    export class Pool extends DurableObject {
      async run() {
        await this.ctx.storage.put('saved-operation',{phase:'fencing'});
        const journalBefore=await this.ctx.storage.get('saved-operation');
        const sql=this.ctx.storage.sql;
        sql.exec('CREATE TABLE settings(id INTEGER PRIMARY KEY,deployment_json TEXT NOT NULL,ready INTEGER NOT NULL)');
        sql.exec('INSERT INTO settings VALUES(1,?,1)',JSON.stringify({deploymentId:scope.deploymentId}));
        const fence=new EthereumRevealEmptyPoolFence(sql,action=>this.ctx.storage.transactionSync(action));
        fence.acquire(scope,1000);
        let blocked=false;
        try { sql.exec('UPDATE settings SET ready=0'); } catch(error) { blocked=String(error).includes('fenced'); }
        fence.withRebuild(scope,()=>sql.exec('UPDATE settings SET ready=1'));
        try { fence.withRebuild(scope,()=>{sql.exec('UPDATE settings SET ready=0');throw new Error('rollback');}); } catch {}
        return {blocked,journalBefore,journalAfter:await this.ctx.storage.get('saved-operation'),
          internalTables:sql.exec("SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB '_cf_*'").toArray().map(row=>row.name),
          ready:sql.exec('SELECT ready FROM settings').one().ready,
          bypass:sql.exec('SELECT bypass FROM reveal_empty_pool_fences').one().bypass,fence:fence.status()};
      }
    }
    export default {async fetch(request,env){return Response.json(await env.POOL.getByName('test').run());}};`;
  const bundled = await build({ stdin: { contents: source, resolveDir: process.cwd(), sourcefile: 'empty-pool-fence.ts' },
    bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', external: ['cloudflare:workers', 'node:*'] });
  const runtime = new Miniflare({ workers: [{ config: { name: 'empty-pool-fence', compatibilityDate: '2026-08-08',
    manifest: { mainModule: 'pool.mjs', modulesRoot: resolve('.'), modules: { 'pool.mjs': { type: 'esm', contents: bundled.outputFiles[0].text } } },
    env: { POOL: { type: 'durable-object', worker: 'empty-pool-fence', exportName: 'Pool' } },
    exports: { Pool: { type: 'durable-object', storage: 'sqlite' } },
  } }] });
  try {
    const response = await runtime.dispatchFetch('https://test/');
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const value = JSON.parse(text);
    assert.equal(value.blocked, true);
    assert.equal(value.ready, 1);
    assert.equal(value.bypass, 0);
    assert.equal(value.fence.operationId, scope.operationId);
    assert.deepEqual(value.journalBefore, { phase: 'fencing' });
    assert.deepEqual(value.journalAfter, value.journalBefore);
    assert.ok(value.internalTables.includes('_cf_KV'));
  } finally { await runtime.dispose(); }
});
