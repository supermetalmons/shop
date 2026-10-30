import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { EthereumRevealStore, type RevealSql } from '../src/ethereumRevealStore.ts';
import { buildRevealedArtwork, REVEAL_ARTWORK_COUNT, REVEAL_CATEGORY_COUNTS,
  revealCrateSize, revealRandomInteger, validateRevealCatalog } from '../src/ethereumRevealCatalog.ts';
import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.ts';
import type { EthereumRevealObservation } from '../../../../shared/ethereum/reveal.ts';

const REVEAL_TRANSIENT_TRANSACTION_LIMIT = 10_000;
const REVEAL_TRANSIENT_TRANSACTION_TTL_MS = 15 * 60_000;
const templateJson = JSON.stringify({ name: '{{tokenId}}', description: 'Preserved description',
  image: 'https://wip.lil.org/111k/artwork_placeholder.png', attributes: [{ trait_type: 'type', value: 'painting' }, { trait_type: 'series', value: '111K' }] });
const deployment: EthereumRevealDeployment = { deploymentId: 'test-sepolia-1', dropId: '111k_devnet', chainId: 11155111,
  contractAddress: `0x${'ab'.repeat(20)}`, metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/test-sepolia-1/',
  deploymentBlock: 100, catalogVersion: '111k-v1', templateJson,
  templateSha256: createHash('sha256').update(templateJson).digest('hex'), state: 'active', revision: 3,
  createdAtMs: 1, updatedAtMs: 3, provisionedAtMs: 2, activatedAtMs: 3, lastError: null };
const crateId = (index: number) => String(111_112 + index);
const ids = (start: number, length = 20) => Array.from({ length }, (_, index) => String(start + index));
const observation = (index: number, blockNumber = 101): EthereumRevealObservation => ({
  transactionHash: `0x${index.toString(16).padStart(64, '0')}`, blockHash: `0x${blockNumber.toString(16).padStart(64, '0')}`, blockNumber,
});

function fixture(t: TestContext, randomInteger: (maximum: number) => number = () => 0, initialize = true) {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys=ON');
  const statements = new Map<string, { statement: StatementSync; returns: boolean }>();
  const sql: RevealSql = { exec<T extends Record<string, string | number | null | ArrayBuffer>>(query: string, ...bindings: Array<string | number | null | ArrayBuffer>) {
    let entry = statements.get(query);
    if (!entry) {
      const statement = database.prepare(query);
      entry = { statement, returns: statement.columns().length > 0 };
      statements.set(query, entry);
    }
    const parameters = bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    const rows = entry.returns ? entry.statement.all(...parameters) : (entry.statement.run(...parameters), []);
    return { toArray: () => rows as T[] };
  } };
  const transaction = <T>(action: () => T): T => {
    database.exec('BEGIN IMMEDIATE');
    try { const value = action(); database.exec('COMMIT'); return value; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  };
  const store = new EthereumRevealStore(sql, transaction, randomInteger);
  store.configure(deployment);
  if (initialize) while (!store.initializeChunk()) {}
  t.after(() => database.close());
  return { database, store, rows: (query: string) => database.prepare(query).all(),
    queries: () => [...statements.keys()],
    reopen: () => new EthereumRevealStore(sql, transaction, randomInteger) };
}

function conservation(database: DatabaseSync, expectedFrozen?: number) {
  const row = database.prepare(`SELECT (SELECT COUNT(*) FROM free_slots) AS free,
    (SELECT COUNT(*) FROM assignments WHERE token_id IS NULL) AS private,
    (SELECT COUNT(*) FROM assignments WHERE token_id IS NOT NULL) AS frozen,
    (SELECT SUM(available) FROM pools) AS available`).get()!;
  assert.equal(Number(row.free) + Number(row.private) + Number(row.frozen), REVEAL_ARTWORK_COUNT);
  assert.equal(row.available, row.free);
  if (expectedFrozen !== undefined) assert.equal(row.frozen, expectedFrozen);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM assignments a JOIN free_slots f
    ON a.category=f.category AND a.asset_id=f.asset_id`).get()!.count, 0);
}

test('catalog preserves all category counts, exact ratios, posters, and immutable template fields', () => {
  validateRevealCatalog();
  assert.equal(Object.values(REVEAL_CATEGORY_COUNTS).reduce<number>((sum, value) => sum + value, 0), REVEAL_ARTWORK_COUNT);
  const imageUrls = new Set<string>();
  const mediaFor = (category: keyof typeof REVEAL_CATEGORY_COUNTS, assetId: number) => buildRevealedArtwork({
    templateJson, tokenId: '1', crateTokenId: crateId(0), category, assetId, observation: observation(1),
  }).artwork;
  for (const [category, count] of Object.entries(REVEAL_CATEGORY_COUNTS)) {
    for (let assetId = 1; assetId <= count; assetId++) {
      const media = mediaFor(category as keyof typeof REVEAL_CATEGORY_COUNTS, assetId);
      assert.ok(media.aspectRatio.width > 0 && media.aspectRatio.height > 0);
      imageUrls.add(media.image);
      if (category === 'video') {
        assert.equal(media.image, `https://wip.lil.org/111k/videos/${assetId}.webp`);
        assert.equal(media.animation_url, `https://wip.lil.org/111k/videos/${assetId}.mp4`);
        assert.deepEqual(media.aspectRatio, { width: 16, height: 9 });
      } else assert.equal(media.animation_url, undefined);
    }
  }
  assert.equal(imageUrls.size, REVEAL_ARTWORK_COUNT);
  assert.deepEqual(mediaFor('painting', 1).aspectRatio, { width: 240, height: 259 });
  const input = { templateJson: templateJson.replace('{{tokenId}}', '{{displayId}}'), tokenId: '71', crateTokenId: crateId(0),
    category: 'video' as const, assetId: 3, observation: observation(1) };
  const result = buildRevealedArtwork(input);
  assert.equal(result.artwork.name, '71');
  assert.equal(result.artwork.description, 'Preserved description');
  assert.deepEqual(result.artwork.attributes, [{ trait_type: 'series', value: '111K' }, { trait_type: 'type', value: 'video' }]);
  assert.equal(JSON.parse(result.metadataJson).animation_url, 'https://wip.lil.org/111k/videos/3.mp4');
  assert.equal(JSON.parse(result.placeholderJson).image, 'https://wip.lil.org/111k/artwork_placeholder.png');
  assert.equal(revealCrateSize('116666'), 31);
  for (const id of ['0111112', '111111', '116667', '1.0']) assert.throws(() => revealCrateSize(id));
  for (const max of [0, -1, 1.5, 0x1_0000_0001]) assert.throws(() => revealRandomInteger(max));
  for (const max of [1, 7, 111111, 0x1_0000_0000]) {
    const value = revealRandomInteger(max);
    assert.ok(Number.isInteger(value) && value >= 0 && value < max);
  }
});

test('provisioning is resumable and deployment identity cannot be replaced', t => {
  const { database, store } = fixture(t, () => 0, false);
  assert.equal(store.ready(), false);
  assert.throws(() => store.reserve([crateId(0)]), /not provisioned/);
  assert.equal(store.initializeChunk(100), false);
  assert.equal(store.summary().seeded, 100);
  store.configure({ ...deployment, state: 'paused', revision: 4 });
  while (!store.initializeChunk(10_000)) {}
  assert.equal(store.summary().seeded, REVEAL_ARTWORK_COUNT);
  assert.equal(store.initializeChunk(), true);
  conservation(database, 0);
  for (const change of [{ chainId: 1 }, { contractAddress: `0x${'cd'.repeat(20)}` }, { deploymentId: 'another' },
    { metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/another/' }, { templateJson: '{}' }, { catalogVersion: 'different' }]) {
    assert.throws(() => store.configure({ ...deployment, ...change }), /identity cannot change/);
  }
});

test('category selection uses initial weights while asset draws use current remaining counts', t => {
  const choices = [0, 22_221, 22_222, 107_777, 107_778, 111_110];
  const maxima: number[] = [];
  let call = 0;
  const { store } = fixture(t, maximum => {
    maxima.push(maximum);
    const index = call++;
    return index % 2 === 0 ? choices[index / 2] ?? 0 : 0;
  });
  store.reserve([crateId(0)]);
  store.freeze(deployment, observation(1), [{ crateTokenId: crateId(0), tokenIds: ids(1) }], 1);
  assert.deepEqual(store.frozen(ids(1, 6)).map(value => value.category), ['egg', 'egg', 'painting', 'painting', 'video', 'video']);
  assert.deepEqual(maxima.slice(0, 12), [111111, 22222, 111111, 22221, 111111, 85556, 111111, 85555, 111111, 3333, 111111, 3332]);
});

test('all 111111 assets remain unique through depletion, reordering, reused token IDs and reservation reclamation', { timeout: 120_000 }, t => {
  const { database, store, rows } = fixture(t);
  const crates = Array.from({ length: 5555 }, (_, index) => crateId(index));
  for (let offset = 0; offset < crates.length; offset += 15) store.reserve(crates.slice(offset, offset + 15));
  assert.equal(store.summary().reserved, REVEAL_ARTWORK_COUNT);
  assert.equal(store.summary().available, 0);
  assert.deepEqual(rows('SELECT category,COUNT(*) AS count FROM assignments GROUP BY category ORDER BY category'), [
    { category: 'egg', count: 22222 }, { category: 'painting', count: 85556 }, { category: 'video', count: 3333 },
  ].map(value => Object.assign(Object.create(null), value)));
  store.freeze(deployment, observation(1), [{ crateTokenId: crates[0], tokenIds: ids(1) }], 1);
  const original = store.frozen(ids(1));
  assert.equal(store.publicationError(), null);
  store.freeze(deployment, observation(1, 102), [{ crateTokenId: crates[0], tokenIds: ids(21) }], 2);
  assert.equal(store.summary().available, 0);
  store.freeze(deployment, observation(2, 102), [{ crateTokenId: crates[1], tokenIds: ids(1) }], 3);
  assert.deepEqual(store.frozen(ids(1)), original);
  assert.equal(store.summary().available, 20);
  let next = 41;
  for (let index = 2; index < crates.length; index++) {
    const count = revealCrateSize(crates[index]);
    store.freeze(deployment, observation(index + 1, 102), [{ crateTokenId: crates[index], tokenIds: ids(next, count) }], index + 2);
    next += count;
  }
  assert.equal(next, REVEAL_ARTWORK_COUNT + 1);
  conservation(database, REVEAL_ARTWORK_COUNT);
  assert.equal(store.summary().reserved, 0);
  assert.equal(store.summary().available, 0);
  assert.equal(store.summary().publication.pending, REVEAL_ARTWORK_COUNT);
  assert.equal(database.prepare('SELECT COUNT(DISTINCT token_id) AS count FROM assignments').get()!.count, REVEAL_ARTWORK_COUNT);
  assert.equal(database.prepare('SELECT MIN(CAST(token_id AS INTEGER)) AS minimum, MAX(CAST(token_id AS INTEGER)) AS maximum FROM assignments').get()!.maximum, REVEAL_ARTWORK_COUNT);
  assert.equal(store.frozen(['111111'])[0].tokenId, '111111');
});


test('existing ledgers replace old scheduler indexes without changing rows', t => {
  const { database, store, rows, reopen } = fixture(t);
  store.freeze(deployment, observation(1), [{ crateTokenId: crateId(0), tokenIds: ids(1) }], 1);
  store.publicationComplete('1');
  database.exec(`UPDATE transactions SET dormant=1;
    DROP INDEX transactions_active_due;
    DROP INDEX publication_due_numeric;
    CREATE INDEX transactions_due ON transactions(next_check_ms);
    CREATE INDEX publication_due ON publication(status,next_check_ms)`);
  const tables = ['assignments', 'publication', 'transactions'];
  const before = tables.map(table => rows(`SELECT * FROM ${table} ORDER BY rowid`));
  for (let attempt = 0; attempt < 2; attempt++) {
    reopen();
    assert.deepEqual(tables.map(table => rows(`SELECT * FROM ${table} ORDER BY rowid`)), before);
    const indexes = rows("SELECT name FROM sqlite_schema WHERE type='index'").map(row => row.name);
    assert.ok(indexes.includes('transactions_active_due'));
    assert.ok(indexes.includes('publication_due_numeric'));
    assert.ok(!indexes.includes('transactions_due'));
    assert.ok(!indexes.includes('publication_due'));
  }
});

test('publication outbox retries frozen bytes and quarantines conflicts without changing assignments', t => {
  const { store } = fixture(t);
  store.freeze(deployment, observation(1), [{ crateTokenId: crateId(0), tokenIds: ids(1) }], 1);
  const original = store.frozen(ids(1));
  const batch = store.claimPublications(2, 20);
  assert.equal(batch.length, 20);
  assert.equal(store.claimPublications(3).length, 0);
  store.publicationComplete(batch[0].token_id);
  store.publicationFailed(batch[1].token_id, 3, batch[1].attempts);
  assert.equal(store.publicationError(), 'publication-unavailable');
  store.publicationFailed(batch[2].token_id, 3, batch[2].attempts, true);
  assert.equal(store.publicationError(), 'metadata-conflict');
  const retry = store.claimPublications(2_003, 20);
  assert.equal(retry.length, 1);
  assert.equal(retry[0].token_id, batch[1].token_id);
  assert.equal(retry[0].metadata_json, batch[1].metadata_json);
  assert.equal(retry[0].placeholder_json, batch[1].placeholder_json);
  assert.equal(retry[0].attempts, 1);
  assert.deepEqual(store.frozen(ids(1)), original);
  assert.deepEqual(store.summary().publication, { conflict: 1, pending: 18, published: 1 });
});

test('publication health clears after retry completion without changing frozen data', t => {
  const { store } = fixture(t);
  store.freeze(deployment, observation(1), [{ crateTokenId: crateId(0), tokenIds: ids(1) }], 1);
  const original = store.frozen(['1']);
  store.publicationFailed('1', 2, 0);
  assert.equal(store.publicationError(), 'publication-unavailable');
  store.publicationComplete('1');
  assert.equal(store.publicationError(), null);
  assert.deepEqual(store.frozen(['1']), original);
});


test('invalid confirmed ranges roll back without partially revealing tokens', t => {
  const { database, store } = fixture(t);
  for (const crates of [
    [{ crateTokenId: crateId(0), tokenIds: ids(1, 19) }],
    [{ crateTokenId: crateId(0), tokenIds: [...ids(1, 19), '1'] }],
    [{ crateTokenId: crateId(0), tokenIds: ids(111100) }],
    [{ crateTokenId: crateId(0), tokenIds: ids(1) }, { crateTokenId: crateId(0), tokenIds: ids(21) }],
  ]) assert.throws(() => store.freeze(deployment, observation(1), crates, 1), /Invalid verified/);
  assert.equal(store.summary().frozen, 0);
  assert.equal(store.claimPublications(2).length, 0);
  conservation(database, 0);
});


function pendingCrates(store: EthereumRevealStore, index: number, crates: string[], now: number) {
  const hash = observation(index).transactionHash;
  assert.equal(store.admitTransaction(hash, deployment.deploymentBlock, now), 'accepted');
  const claim = store.claimReceipt(now, 'active', hash);
  assert.ok(claim);
  assert.equal(store.completeReceipt(deployment, claim, { status: 'pending', seen: true, crates, fromBlock: 500 }, now), true);
  return hash;
}

function confirmed(index: number, crates = [{ crateTokenId: crateId(0), tokenIds: ids(1) }], confirmations = 1) {
  return { status: 'confirmed' as const, observation: observation(index, 500), crates, confirmations };
}

function crateScan(claim: NonNullable<ReturnType<EthereumRevealStore['claimScan']>>, index?: number, blockNumber = 500) {
  return { provenance: index === undefined ? [] : [{ ...observation(index, blockNumber), crateTokenIds: claim.crateTokenIds }],
    scannedRange: { fromBlock: claim.range.fromBlock, toBlock: blockNumber }, remainingRanges: [],
    observedBlock: { number: blockNumber, hash: observation(index ?? 1, blockNumber).blockHash } };
}

test('pending attempts share stable crate jobs and private reservations while retaining every hash', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { database, store, rows, reopen } = fixture(t);
  const hashes = Array.from({ length: 50 }, (_, index) => pendingCrates(store, index + 1, [crateId(0)], now));
  assert.equal(rows('SELECT * FROM crate_recovery_jobs').length, 1);
  assert.equal(rows('SELECT * FROM crate_candidates').length, hashes.length);
  assert.equal(store.opaqueCount(), 0);
  assert.equal(store.summary().reserved, 20);
  for (const hash of hashes) {
    const response = store.transactionResponse(deployment, hash);
    assert.equal(response.status, 'pending');
    assert.deepEqual(response.artworks, []);
    assert.ok(!JSON.stringify(response).includes('wip.lil.org'));
  }
  const reserved = rows('SELECT * FROM assignments ORDER BY category,asset_id');
  now += 2_000;
  const claim = store.claimReceipt(now, 'active', hashes[0]);
  assert.ok(claim);
  store.completeReceipt(deployment, claim, { status: 'reverted', source: 'receipt', observation: observation(1), confirmations: 64 }, now);
  assert.deepEqual(rows('SELECT * FROM assignments ORDER BY category,asset_id'), reserved);
  assert.equal(reopen().opaqueCount(), 0);
  assert.equal(rows('SELECT * FROM crate_candidates').length, hashes.length);
  conservation(database, 0);
});

test('frozen token assignments and bytes survive reorg checks, remints and pending replays', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { database, store, rows } = fixture(t);
  const hash = pendingCrates(store, 1, [crateId(0)], now);
  now += 2_000;
  const first = store.claimReceipt(now, 'active', hash);
  assert.ok(first);
  store.completeReceipt(deployment, first, confirmed(1), now);
  const original = rows('SELECT * FROM assignments WHERE token_id IS NOT NULL ORDER BY token_id');
  now += 15_000;
  const reverted = store.claimReceipt(now, 'active', hash);
  assert.ok(reverted);
  store.completeReceipt(deployment, reverted, { status: 'reverted', source: 'receipt', observation: observation(1, 501), confirmations: 1 }, now);
  assert.deepEqual(rows('SELECT * FROM assignments WHERE token_id IS NOT NULL ORDER BY token_id'), original);
  assert.throws(() => database.exec("UPDATE assignments SET metadata_json='{}' WHERE token_id='1'"), /Frozen reveal cannot change/);
  assert.throws(() => database.exec("DELETE FROM assignments WHERE token_id='1'"), /Frozen reveal cannot be deleted/);
  store.reserve([crateId(0)]);
  assert.equal(store.summary().reserved, 20);
  store.freeze(deployment, observation(2, 502), [{ crateTokenId: crateId(0), tokenIds: ids(1) }], now);
  assert.equal(store.summary().reserved, 0);
  assert.deepEqual(rows('SELECT * FROM assignments WHERE token_id IS NOT NULL ORDER BY token_id'), original);
  assert.equal(store.transactionResponse(deployment, hash).status, 'revealed');
  conservation(database, 20);
});

test('observed opaque transactions survive the unknown TTL, later missing results and restart until confirmation', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const fixtureState = fixture(t);
  let store = fixtureState.store;
  const hash = observation(1).transactionHash;
  assert.equal(store.admitTransaction(hash, 100, now), 'accepted');
  const first = store.claimReceipt(now, 'active', hash);
  assert.ok(first);
  assert.equal(store.recordReceiptPresence(first, now), true);
  assert.equal(store.failReceipt(first, now), true);
  now += REVEAL_TRANSIENT_TRANSACTION_TTL_MS + 86_400_000;
  store = fixtureState.reopen();
  const missing = store.claimReceipt(now, 'background', hash);
  assert.ok(missing);
  assert.equal(store.completeReceipt(deployment, missing, { status: 'pending', seen: false }, now), true);
  assert.equal(store.opaqueCount(), 1);
  assert.equal(store.knownTransaction(hash), true);
  assert.deepEqual(store.transactionResponse(deployment, hash).artworks, []);
  now += 300_000;
  const mined = store.claimReceipt(now, 'background', hash);
  assert.ok(mined);
  assert.equal(store.completeReceipt(deployment, mined, confirmed(1), now), true);
  assert.equal(store.opaqueCount(), 0);
  assert.equal(store.transactionResponse(deployment, hash).artworks.length, 20);
  assert.equal(fixtureState.rows('SELECT * FROM crate_recovery_jobs').length, 1);
});

test('unknown expiry requires a fresh successful absence check and provider failures preserve admission', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store, reopen } = fixture(t);
  const hash = observation(1).transactionHash;
  store.admitTransaction(hash, 100, now);
  now += REVEAL_TRANSIENT_TRANSACTION_TTL_MS + 1;
  assert.equal(reopen().knownTransaction(hash), true);
  const failed = store.claimReceipt(now, 'background', hash);
  assert.ok(failed);
  assert.equal(store.failReceipt(failed, now), true);
  assert.equal(store.opaqueCount(), 1);
  now += 300_000;
  const absent = store.claimReceipt(now, 'background', hash);
  assert.ok(absent);
  assert.equal(store.completeReceipt(deployment, absent, { status: 'pending', seen: false }, now), true);
  assert.equal(store.knownTransaction(hash), false);
  assert.equal(store.opaqueCount(), 0);
  assert.equal(store.admitTransaction(hash, 100, now), 'accepted');
  const replacement = store.claimReceipt(now, 'active', hash);
  assert.ok(replacement);
  assert.notEqual(replacement.claimId, absent.claimId);
  assert.equal(store.recordReceiptPresence(absent, now), false);
  assert.equal(store.completeReceipt(deployment, absent, confirmed(1), now), false);
  assert.equal(store.completeReceipt(deployment, replacement, { status: 'pending', seen: true }, now), true);
  assert.equal(store.opaqueCount(), 1);
  assert.equal(store.summary().frozen, 0);
});

for (const status of ['reverted', 'not_unpack'] as const) test(`recent ${status} receipts remain observed and recoverable until stable evidence resolves the watch`, t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store, reopen } = fixture(t);
  const hash = observation(1).transactionHash;
  store.admitTransaction(hash, 100, now);
  const first = store.claimReceipt(now, 'active', hash);
  assert.ok(first);
  store.completeReceipt(deployment, first, { status, source: 'receipt', observation: observation(1), confirmations: 1 }, now);
  assert.equal(store.opaqueCount(), 1);
  assert.equal(store.transactionResponse(deployment, hash).status, status);
  now += REVEAL_TRANSIENT_TRANSACTION_TTL_MS + 1;
  const restored = reopen();
  const missing = restored.claimReceipt(now, 'background', hash);
  assert.ok(missing);
  restored.completeReceipt(deployment, missing, { status: 'pending', seen: false }, now);
  assert.equal(restored.opaqueCount(), 1);
  now += 300_000;
  const stable = restored.claimReceipt(now, 'background', hash);
  assert.ok(stable);
  restored.completeReceipt(deployment, stable, { status, source: 'receipt', observation: observation(1), confirmations: 64 }, now);
  assert.equal(restored.opaqueCount(), 0);
  assert.equal(restored.claimReceipt(now + 86_400_000, 'background'), null);
  assert.equal(restored.transactionResponse(deployment, hash).status, status);
});

test('opaque admission is capped at 10000 while confirmed and crate-validated bypasses remain durable', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { database, store, reopen } = fixture(t);
  database.prepare(`WITH RECURSIVE ids(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM ids WHERE id<?)
    INSERT INTO transactions(hash,from_block,requested_all,created_at_ms,last_requested_at_ms)
    SELECT printf('0x%064x',id),100,1,?,? FROM ids`).run(REVEAL_TRANSIENT_TRANSACTION_LIMIT, now, now);
  database.prepare(`INSERT INTO receipt_work(hash,requested_all,observed,opaque,active_until_ms,created_at_ms)
    SELECT hash,1,CAST(substr(hash,-1) AS INTEGER)%2,1,?,? FROM transactions`).run(now + 30_000, now);
  const rejected = observation(20_001).transactionHash;
  assert.equal(store.opaqueCount(), REVEAL_TRANSIENT_TRANSACTION_LIMIT);
  assert.equal(store.admitTransaction(rejected, 100, now), 'capacity');
  assert.equal(store.transactionJob(rejected), undefined);
  assert.equal(store.admitTransaction(observation(1).transactionHash, 100, now), 'accepted');
  assert.equal(store.acceptVerified(deployment, rejected, { status: 'pending', seen: true }, now, now), false);
  assert.equal(store.acceptVerified(deployment, rejected, confirmed(20_001), now, now), true);
  assert.equal(store.transactionResponse(deployment, rejected).artworks.length, 20);
  const pending = observation(20_002).transactionHash;
  assert.equal(store.acceptVerified(deployment, pending, { status: 'pending', seen: true, crates: [crateId(1)], fromBlock: 500 }, now, now), true);
  assert.equal(store.opaqueCount(), REVEAL_TRANSIENT_TRANSACTION_LIMIT);
  assert.equal(store.summary().reserved, 20);
  const restored = reopen();
  assert.equal(restored.transactionResponse(deployment, rejected).artworks.length, 20);
  assert.equal(restored.knownTransaction(pending), true);
  assert.equal(restored.admitTransaction(observation(20_003).transactionHash, 100, now), 'capacity');
});

function fillOpaqueWatches(database: DatabaseSync, now: number) {
  database.prepare(`WITH RECURSIVE ids(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM ids WHERE id<?)
    INSERT INTO transactions(hash,from_block,requested_all,created_at_ms,last_requested_at_ms)
    SELECT printf('0x%064x',id),100,1,?,? FROM ids`).run(REVEAL_TRANSIENT_TRANSACTION_LIMIT, now, now);
  database.prepare(`INSERT INTO receipt_work(hash,requested_all,opaque,active_until_ms,created_at_ms)
    SELECT hash,1,1,?,? FROM transactions WHERE hash<=?`).run(now + 30_000, now, observation(REVEAL_TRANSIENT_TRANSACTION_LIMIT).transactionHash);
}

test('token-provenance work needs free opaque capacity before a full transaction upgrade', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { database, store, rows } = fixture(t);
  store.admitTokens(['1'], 100, now);
  const scan = store.claimScan(now, 'active', { tokenIds: ['1'] });
  assert.ok(scan);
  const observed = observation(20_000, 500);
  store.completeTokenScan(scan, { provenance: [{ ...observed, tokenIds: ['1'] }],
    scannedRange: { fromBlock: 100, toBlock: 500 }, remainingRanges: [], mintedThrough: 20,
    observedBlock: { number: 500, hash: observed.blockHash } }, now);
  fillOpaqueWatches(database, now);
  const hash = observed.transactionHash;
  const before = ['transactions', 'receipt_work', 'receipt_token_interest'].map(table => rows(`SELECT * FROM ${table} WHERE hash='${hash}'`));
  now += 1_000;
  assert.equal(store.admitTransaction(hash, 100, now), 'capacity');
  assert.equal(store.knownTransaction(hash), false);
  assert.equal(store.opaqueCount(), REVEAL_TRANSIENT_TRANSACTION_LIMIT);
  assert.deepEqual(['transactions', 'receipt_work', 'receipt_token_interest'].map(table => rows(`SELECT * FROM ${table} WHERE hash='${hash}'`)), before);
  const counted = observation(1).transactionHash;
  assert.equal(store.admitTransaction(counted, 100, now), 'accepted');
  assert.equal(store.opaqueCount(), REVEAL_TRANSIENT_TRANSACTION_LIMIT);
  const terminal = store.claimReceipt(now, 'active', counted);
  assert.ok(terminal);
  store.completeReceipt(deployment, terminal, { status: 'not_unpack', source: 'receipt', observation: observation(1), confirmations: 64 }, now);
  assert.equal(store.admitTransaction(hash, 100, now), 'accepted');
  assert.equal(store.opaqueCount(), REVEAL_TRANSIENT_TRANSACTION_LIMIT);
  assert.equal(rows(`SELECT opaque FROM receipt_work WHERE hash='${hash}'`)[0].opaque, 1);
  assert.equal(store.knownTransaction(hash), true);
});

test('scan-associated crate hashes upgrade their full response without entering the opaque pool', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { database, store, rows } = fixture(t);
  pendingCrates(store, 20_000, [crateId(0)], now);
  const scan = store.claimScan(now, 'active');
  assert.ok(scan);
  const observed = observation(20_001, 500);
  store.completeCrateScan(scan, { provenance: [{ ...observed, crateTokenIds: [crateId(0)] }],
    scannedRange: { fromBlock: scan.range.fromBlock, toBlock: 500 }, remainingRanges: [],
    observedBlock: { number: 500, hash: observed.blockHash } }, now);
  assert.equal(store.transactionJob(observed.transactionHash)!.crates_json, '[]');
  fillOpaqueWatches(database, now);
  now += 1_000;
  assert.equal(store.admitTransaction(observed.transactionHash, 100, now), 'accepted');
  assert.equal(store.opaqueCount(), REVEAL_TRANSIENT_TRANSACTION_LIMIT);
  assert.equal(rows(`SELECT opaque FROM receipt_work WHERE hash='${observed.transactionHash}'`)[0].opaque, 0);
  assert.equal(store.knownTransaction(observed.transactionHash), true);
  const receipt = store.claimReceipt(now, 'active', observed.transactionHash);
  assert.ok(receipt);
  store.completeReceipt(deployment, receipt, confirmed(20_001, [
    { crateTokenId: crateId(0), tokenIds: ids(1) }, { crateTokenId: crateId(1), tokenIds: ids(21) },
  ]), now);
  assert.equal(store.transactionResponse(deployment, observed.transactionHash).artworks.length, 40);
  assert.equal(store.opaqueCount(), REVEAL_TRANSIENT_TRANSACTION_LIMIT);
});

test('reopening a resolved unscoped watch requires capacity again', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { database, store, rows } = fixture(t);
  const hash = observation(20_000).transactionHash;
  store.admitTransaction(hash, 100, now);
  const first = store.claimReceipt(now, 'active', hash);
  assert.ok(first);
  store.completeReceipt(deployment, first, { status: 'reverted', source: 'receipt', observation: observation(20_000), confirmations: 64 }, now);
  assert.equal(store.opaqueCount(), 0);
  fillOpaqueWatches(database, now);
  const before = rows(`SELECT * FROM receipt_work WHERE hash='${hash}'`);
  now += 1_000;
  assert.equal(store.admitTransaction(hash, 100, now), 'capacity');
  assert.deepEqual(rows(`SELECT * FROM receipt_work WHERE hash='${hash}'`), before);
  assert.equal(store.opaqueCount(), REVEAL_TRANSIENT_TRANSACTION_LIMIT);
  const terminal = store.claimReceipt(now, 'active', observation(1).transactionHash);
  assert.ok(terminal);
  store.completeReceipt(deployment, terminal, { status: 'reverted', source: 'receipt', observation: observation(1), confirmations: 64 }, now);
  assert.equal(store.admitTransaction(hash, 100, now), 'accepted');
  assert.equal(store.opaqueCount(), REVEAL_TRANSIENT_TRANSACTION_LIMIT);
  assert.equal(rows(`SELECT resolved FROM receipt_work WHERE hash='${hash}'`)[0].resolved, 0);
});

test('unmigrated legacy watches count toward opaque capacity without evicting accepted work', t => {
  const now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { database, reopen } = fixture(t);
  database.prepare(`WITH RECURSIVE ids(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM ids WHERE id<?)
    INSERT INTO transactions(hash,from_block,requested_all,created_at_ms,last_requested_at_ms)
    SELECT printf('0x%064x',id),100,1,?,? FROM ids`).run(REVEAL_TRANSIENT_TRANSACTION_LIMIT, now, now);
  database.exec('DELETE FROM reveal_recovery_migration');
  const store = reopen();
  const existing = observation(1).transactionHash, rejected = observation(20_001).transactionHash;
  assert.equal(store.migrationReady(), false);
  assert.equal(store.admitTransaction(rejected, 100, now), 'capacity');
  assert.equal(store.transactionJob(rejected), undefined);
  assert.equal(store.opaqueCount(), REVEAL_TRANSIENT_TRANSACTION_LIMIT);
  assert.equal(store.admitTransaction(existing, 100, now), 'accepted');
  assert.equal(store.opaqueCount(), REVEAL_TRANSIENT_TRANSACTION_LIMIT);
  store.migrateChunk(now, 128);
  assert.equal(store.opaqueCount(), REVEAL_TRANSIENT_TRANSACTION_LIMIT);
  assert.equal(reopen().admitTransaction(rejected, 100, now), 'capacity');
  while (!store.migrationReady()) store.migrateChunk(now, 128);
  assert.equal(store.opaqueCount(), REVEAL_TRANSIENT_TRANSACTION_LIMIT);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM transactions').get()!.count, REVEAL_TRANSIENT_TRANSACTION_LIMIT);
  assert.equal(store.admitTransaction(rejected, 100, now), 'capacity');
});

test('receipt claims are exclusive and requests cannot bypass the per-hash cooldown', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store } = fixture(t);
  const hash = observation(1).transactionHash;
  store.admitTransaction(hash, 100, now);
  const first = store.claimReceipt(now, 'active', hash);
  assert.ok(first);
  assert.equal(store.claimReceipt(now, 'active', hash), null);
  store.admitTransaction(hash, 100, now + 1);
  assert.equal(store.claimReceipt(now + 1, 'active', hash), null);
  store.completeReceipt(deployment, first, { status: 'pending', seen: true }, now);
  assert.equal(store.claimReceipt(now + 1_999, 'active', hash), null);
  now += 2_000;
  const second = store.claimReceipt(now, 'active', hash);
  assert.ok(second);
  now = second.leaseUntilMs;
  assert.equal(store.failReceipt(second, now), false);
  assert.equal(store.recordReceiptPresence(second, now), false);
  const third = store.claimReceipt(now, 'background', hash);
  assert.ok(third);
  assert.notEqual(third.claimId, second.claimId);
  assert.equal(store.completeReceipt(deployment, second, confirmed(1), now), false);
  assert.equal(store.completeReceipt(deployment, third, confirmed(1), now), true);
});

test('background completion cannot renew the thirty-second active window and quiet work backs off', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store, rows } = fixture(t);
  const hash = pendingCrates(store, 1, [crateId(0)], now);
  const activeUntil = now + 30_000;
  now += 20_000;
  const active = store.claimReceipt(now, 'active', hash);
  assert.ok(active);
  now += 9_000;
  store.completeReceipt(deployment, active, { status: 'pending', seen: true, crates: [crateId(0)], fromBlock: 500 }, now);
  assert.equal(rows('SELECT active_until_ms FROM crate_recovery_jobs')[0].active_until_ms, activeUntil);
  assert.equal(rows('SELECT active_until_ms FROM receipt_work')[0].active_until_ms, activeUntil);
  now += 2_000;
  assert.equal(store.claimReceipt(now, 'active', hash), null);
  for (let attempt = 0; attempt < 8; attempt++) {
    const quiet = store.claimReceipt(now, 'background', hash);
    assert.ok(quiet);
    store.completeReceipt(deployment, quiet, { status: 'pending', seen: true }, now);
    const due = Number(rows('SELECT next_check_ms FROM receipt_work')[0].next_check_ms);
    assert.ok(due > now && due <= now + 300_000);
    assert.equal(rows('SELECT active_until_ms FROM crate_recovery_jobs')[0].active_until_ms, activeUntil);
    now = due;
  }
  assert.equal(Number(rows('SELECT next_check_ms-last_checked_ms AS delay FROM receipt_work')[0].delay), 300_000);
  store.admitTransaction(hash, 100, now);
  assert.ok(store.claimReceipt(now, 'active', hash));
});

for (const kind of ['tokens', 'crate'] as const) for (const outcome of ['failure', 'completed'] as const) {
  test(`${kind} polling preserves two seconds after a slow ${outcome} scan`, t => {
    let now = 1_000_000;
    t.mock.method(Date, 'now', () => now);
    const { store, rows } = fixture(t);
    const hash = observation(1).transactionHash;
    const promote = () => kind === 'tokens' ? store.admitTokens(['1'], 100, now) : store.admitTransaction(hash, 100, now);
    if (kind === 'tokens') promote();
    else pendingCrates(store, 1, [crateId(0)], now);
    const first = store.claimScan(now, 'active');
    assert.ok(first);
    assert.equal(first.kind, kind);
    now += 3_000;
    if (outcome === 'failure') assert.equal(store.failScan(first, now), true);
    else if (kind === 'crate') assert.equal(store.completeCrateScan(first, crateScan(first), now), true);
    else assert.equal(store.completeTokenScan(first, { ...crateScan(first), mintedThrough: 1, provenance: [] }, now), true);
    const completedAt = now;
    for (const elapsed of [1, 300, 1_999]) {
      now = completedAt + elapsed;
      promote();
      assert.equal(store.claimScan(now, 'active'), null);
      const due = rows(kind === 'tokens' ? 'SELECT next_check_ms AS due FROM recovery_jobs' : 'SELECT scan_due_ms AS due FROM crate_recovery_jobs')[0].due;
      assert.equal(due, completedAt + 2_000);
    }
    now = completedAt + 2_000;
    promote();
    assert.equal(store.claimScan(now, 'active')?.id, first.id);
  });
}

for (const kind of ['tokens', 'crate'] as const) test(`${kind} foreground promotion shortens quiet backoff without delaying genuinely new scope`, t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store, rows } = fixture(t);
  const hash = observation(1).transactionHash;
  if (kind === 'tokens') store.admitTokens(['1'], 100, now);
  else pendingCrates(store, 1, [crateId(0)], now);
  const first = store.claimScan(now, 'active');
  assert.ok(first);
  store.failScan(first, now);
  now += 30_001;
  const quiet = store.claimScan(now, 'background');
  assert.ok(quiet);
  store.failScan(quiet, now);
  const completedAt = now;
  const dueQuery = kind === 'tokens' ? 'SELECT next_check_ms AS due FROM recovery_jobs' : 'SELECT scan_due_ms AS due FROM crate_recovery_jobs';
  assert.ok(Number(rows(dueQuery)[0].due) > now + 2_000);
  now += 1;
  if (kind === 'tokens') store.admitTokens(['1'], 100, now);
  else store.admitTransaction(hash, 100, now);
  assert.equal(rows(dueQuery)[0].due, completedAt + 2_000);
  if (kind === 'tokens') store.admitTokens(['2'], 100, now);
  else pendingCrates(store, 2, [crateId(1)], now);
  const fresh = store.claimScan(now, 'active');
  assert.ok(fresh);
  assert.notEqual(fresh.id, first.id);
  assert.deepEqual(kind === 'tokens' ? fresh.tokenIds : fresh.crateTokenIds, kind === 'tokens' ? ['2'] : [crateId(1)]);
});

for (const kind of ['tokens', 'crate'] as const) test(`${kind} split-range continuation remains immediate through repeated foreground promotion`, t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store } = fixture(t);
  const hash = observation(1).transactionHash;
  const promote = () => kind === 'tokens' ? store.admitTokens(['1'], 100, now) : store.admitTransaction(hash, 100, now);
  if (kind === 'tokens') promote();
  else pendingCrates(store, 1, [crateId(0)], now);
  const first = store.claimScan(now, 'active');
  assert.ok(first);
  now += 3_000;
  const middle = Math.floor((first.range.fromBlock + 1000) / 2);
  const ranges = [{ fromBlock: middle + 1, toBlock: 1000 }, { fromBlock: first.range.fromBlock, toBlock: middle }];
  const split = { provenance: [], scannedRange: null, remainingRanges: ranges,
    observedBlock: { number: 1000, hash: observation(1, 1000).blockHash } };
  if (kind === 'tokens') store.completeTokenScan(first, { ...split, mintedThrough: 1 }, now);
  else store.completeCrateScan(first, split, now);
  now += 1;
  promote();
  const upper = store.claimScan(now, 'active');
  assert.ok(upper);
  assert.deepEqual(upper.range, ranges[0]);
  const scanned = { ...split, scannedRange: ranges[0], remainingRanges: [] };
  if (kind === 'tokens') store.completeTokenScan(upper, { ...scanned, mintedThrough: 1 }, now);
  else store.completeCrateScan(upper, scanned, now);
  promote();
  const lower = store.claimScan(now, 'active');
  assert.ok(lower);
  assert.deepEqual(lower.range, ranges[1]);
});

test('active and background claims remain separate and honor caller exclusions', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store } = fixture(t);
  const quiet = observation(1).transactionHash, active = observation(2).transactionHash;
  store.admitTransaction(quiet, 100, now);
  now += 30_001;
  store.admitTransaction(active, 100, now);
  assert.equal(store.claimReceipt(now, 'active', undefined, [active]), null);
  assert.equal(store.claimReceipt(now, 'active')?.hash, active);
  assert.equal(store.claimReceipt(now, 'background')?.hash, quiet);
});

for (const resultKind of ['pending', 'confirmed'] as const) test(`new scan evidence survives an older ${resultKind} receipt completion`, t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store, rows } = fixture(t);
  const hash = pendingCrates(store, 1, [crateId(0)], now);
  now += 2_000;
  const receipt = store.claimReceipt(now, 'active', hash);
  assert.ok(receipt);
  const scan = store.claimScan(now, 'active');
  assert.ok(scan);
  assert.equal(scan.kind, 'crate');
  const discovered = crateScan(scan, 1, 501);
  assert.equal(store.completeCrateScan(scan, discovered, now), true);
  const before = rows(`SELECT * FROM crate_candidates WHERE hash='${hash}'`)[0];
  assert.ok(Number(before.evidence_version) > Number(before.checked_version));
  now += 1;
  store.completeReceipt(deployment, receipt, resultKind === 'pending' ? { status: 'pending', seen: true } : confirmed(1, undefined, 64), now);
  const after = rows(`SELECT * FROM crate_candidates WHERE hash='${hash}'`)[0];
  assert.equal(after.evidence_key, discovered.provenance[0].blockHash);
  assert.ok(Number(after.evidence_version) > Number(after.checked_version));
  assert.equal(store.summary().frozen, resultKind === 'confirmed' ? 20 : 0);
  now += 2_000;
  assert.equal(store.claimReceipt(now, 'active')?.hash, hash);
});

test('identical log evidence does not continually refresh candidate priority and new blocks do', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store, rows } = fixture(t);
  const hash = pendingCrates(store, 1, [crateId(0)], now);
  const first = store.claimScan(now, 'active');
  assert.ok(first);
  store.completeCrateScan(first, crateScan(first, 1), now);
  const version = Number(rows(`SELECT evidence_version FROM crate_candidates WHERE hash='${hash}'`)[0].evidence_version);
  now += 2_000;
  const receipt = store.claimReceipt(now, 'active', hash);
  assert.ok(receipt);
  store.completeReceipt(deployment, receipt, { status: 'pending', seen: true }, now);
  const second = store.claimScan(now, 'active');
  assert.ok(second);
  store.completeCrateScan(second, crateScan(second, 1), now);
  let row = rows(`SELECT * FROM crate_candidates WHERE hash='${hash}'`)[0];
  assert.equal(row.evidence_version, version);
  assert.ok(Number(row.checked_version) < version);
  now += 2_000;
  const third = store.claimScan(now, 'active');
  assert.ok(third);
  store.completeCrateScan(third, crateScan(third, 1, 501), now);
  row = rows(`SELECT * FROM crate_candidates WHERE hash='${hash}'`)[0];
  assert.equal(row.evidence_version, version + 1);
  assert.ok(Number(row.checked_version) < version);
});

test('confirmed crate jobs preserve all candidate associations and recover after reorg without handoffs', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store, rows, reopen } = fixture(t);
  const first = pendingCrates(store, 1, [crateId(0)], now), later = pendingCrates(store, 2, [crateId(0)], now);
  now += 2_000;
  const receipt = store.claimReceipt(now, 'active', first);
  assert.ok(receipt);
  store.completeReceipt(deployment, receipt, confirmed(1), now);
  const frozen = store.frozen(ids(1));
  assert.equal(rows('SELECT * FROM crate_recovery_jobs').length, 1);
  assert.equal(rows('SELECT * FROM crate_candidates').length, 2);
  now += 15_000;
  const missing = store.claimReceipt(now, 'active', first);
  assert.ok(missing);
  store.completeReceipt(deployment, missing, { status: 'pending', seen: false }, now);
  const restored = reopen();
  now += 2_000;
  const replacement = restored.claimReceipt(now, 'active');
  assert.ok(replacement);
  assert.equal(replacement.hash, later);
  restored.completeReceipt(deployment, replacement, confirmed(2, [{ crateTokenId: crateId(0), tokenIds: ids(21) }]), now);
  assert.deepEqual(restored.frozen(ids(1)), frozen);
  assert.equal(restored.transactionResponse(deployment, later).artworks.length, 20);
  assert.equal(rows('SELECT * FROM crate_recovery_jobs').length, 1);
  assert.equal(rows('SELECT * FROM crate_candidates').length, 2);
});

test('a frozen observation fences stale scan progress while retaining its verified candidates', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store, rows } = fixture(t);
  pendingCrates(store, 1, [crateId(0)], now);
  const scan = store.claimScan(now, 'active');
  assert.ok(scan);
  store.freeze(deployment, observation(2), [{ crateTokenId: crateId(0), tokenIds: ids(1) }], now);
  const state = 'SELECT mode,observed_hash,from_block,ranges_json,scan_due_ms,scan_claim_id,scan_lease_until_ms FROM crate_recovery_jobs';
  const before = rows(state);
  assert.equal(store.completeCrateScan(scan, crateScan(scan, 3), now), false);
  assert.equal(store.failScan(scan, now), false);
  assert.deepEqual(rows(state), before);
  assert.equal(rows(`SELECT * FROM crate_candidates WHERE hash='${observation(3).transactionHash}'`).length, 1);
  assert.equal(store.claimReceipt(now, 'active')?.hash, observation(3).transactionHash);
  assert.equal(store.frozen(ids(1)).length, 20);
});

test('crate scan ranges persist split work and resume after restart without skipping older segments', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store, reopen } = fixture(t);
  pendingCrates(store, 1, [crateId(0)], now);
  const first = store.claimScan(now, 'active');
  assert.ok(first);
  const split = [{ fromBlock: 701, toBlock: 1000 }, { fromBlock: first.range.fromBlock, toBlock: 700 }];
  store.completeCrateScan(first, { provenance: [], scannedRange: null, remainingRanges: split,
    observedBlock: { number: 1000, hash: observation(1, 1000).blockHash } }, now);
  const restored = reopen();
  const upper = restored.claimScan(now, 'active');
  assert.ok(upper);
  assert.deepEqual(upper.range, split[0]);
  restored.completeCrateScan(upper, { ...crateScan(upper, undefined, 1000), scannedRange: split[0] }, now);
  const lower = restored.claimScan(now, 'active');
  assert.ok(lower);
  assert.deepEqual(lower.range, split[1]);
  restored.completeCrateScan(lower, { ...crateScan(lower, undefined, 700), scannedRange: split[1] }, now);
  now += 2_000;
  const tail = restored.claimScan(now, 'active');
  assert.ok(tail);
  assert.equal(tail.range.fromBlock, 936);
});

test('five hundred token IDs use coalesced hundred-token jobs and retain an exact response partition', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store, rows } = fixture(t);
  const requested = ids(1, 500);
  store.admitTokens(requested, 100, now);
  store.admitTokens(requested, 100, now + 1);
  const jobs = rows('SELECT token_ids_json FROM recovery_jobs');
  assert.equal(jobs.length, 5);
  assert.ok(jobs.every(row => JSON.parse(String(row.token_ids_json)).length === 100));
  assert.equal(store.knownTokens(requested, now), true);
  const first = store.claimScan(now, 'active', { tokenIds: ['1'] });
  assert.ok(first);
  assert.equal(first.kind, 'tokens');
  store.completeTokenScan(first, { provenance: [], scannedRange: null, remainingRanges: [], mintedThrough: 0,
    observedBlock: { number: 500, hash: observation(1, 500).blockHash } }, now);
  const response = store.tokensResponse(deployment, requested);
  assert.equal(response.artworks.length, 0);
  assert.equal(response.unresolved.length, 500);
  assert.equal(response.unresolved.filter(row => row.status === 'unminted').length, 100);
  assert.equal(new Set(response.unresolved.map(row => row.tokenId)).size, 500);
  assert.equal(store.knownTokens(['1'], now + 1_999), true);
  assert.equal(store.knownTokens(['1'], now + 2_000), false);
  now += 2_000;
  store.admitTokens(['1'], 100, now);
  assert.equal(store.tokensResponse(deployment, ['1']).unresolved[0].status, 'recovering');
});

test('token provenance reveals only its crate until a transaction request upgrades the full bundled response', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store } = fixture(t);
  store.admitTokens(['1', '2', '100'], 100, now);
  const scan = store.claimScan(now, 'active', { tokenIds: ['1'] });
  assert.ok(scan);
  const observed = observation(1, 500);
  store.completeTokenScan(scan, { provenance: [{ ...observed, tokenIds: ['1', '2'] }],
    scannedRange: { fromBlock: 100, toBlock: 500 }, remainingRanges: [], mintedThrough: 40,
    observedBlock: { number: 500, hash: observed.blockHash } }, now);
  const first = store.claimReceipt(now, 'active');
  assert.ok(first);
  assert.equal(first.hash, observed.transactionHash);
  const result = confirmed(1, [{ crateTokenId: crateId(0), tokenIds: ids(1) }, { crateTokenId: crateId(1), tokenIds: ids(21) }]);
  store.completeReceipt(deployment, first, result, now);
  const partial = store.tokensResponse(deployment, ['1', '2', '100']);
  assert.deepEqual(partial.artworks.map(row => row.tokenId), ['1', '2']);
  assert.deepEqual(partial.unresolved, [{ tokenId: '100', status: 'unminted' }]);
  assert.equal(store.frozen(ids(21)).length, 0);
  assert.equal(store.transactionResponse(deployment, first.hash).status, 'pending');
  assert.deepEqual(store.transactionResponse(deployment, first.hash).artworks, []);
  store.admitTransaction(first.hash, 100, now);
  now += 2_000;
  const full = store.claimReceipt(now, 'active', first.hash);
  assert.ok(full);
  store.completeReceipt(deployment, full, result, now);
  assert.equal(store.transactionResponse(deployment, first.hash).status, 'revealed');
  assert.equal(store.transactionResponse(deployment, first.hash).artworks.length, 40);
});

test('publication ordering remains numeric and covered by its index', t => {
  const { store, database, queries } = fixture(t);
  store.freeze(deployment, observation(1), [{ crateTokenId: crateId(0), tokenIds: ids(1) }], 1);
  assert.deepEqual(store.claimPublications(2, 8).map(job => job.token_id), ids(1, 8));
  const query = queries().find(value => value.startsWith('SELECT p.token_id'));
  assert.ok(query);
  const plan = database.prepare(`EXPLAIN QUERY PLAN ${query}`).all(2, 8).map(row => String(row.detail)).join('\n');
  assert.match(plan, /publication_due_numeric/);
  assert.doesNotMatch(plan, /TEMP B-TREE/);
});

function prepareLegacyLedger(t: TestContext, prototype: boolean) {
  const state = fixture(t);
  const { database, store } = state;
  store.freeze(deployment, observation(9_999), [{ crateTokenId: crateId(0), tokenIds: ids(1) }], 1);
  store.reserve([crateId(499)]);
  store.publicationComplete('1');
  store.publicationFailed('2', 2, 0);
  const original = observation(1).transactionHash;
  database.prepare(`INSERT INTO transactions(hash,crates_json,tokens_json,from_block,requested_all,created_at_ms,last_requested_at_ms,receipt_seen)
    VALUES(?,?,?,?,1,1,1,1)`).run(original, JSON.stringify(Array.from({ length: 260 }, (_, index) => crateId(index + 1))),
    JSON.stringify([{ tokenId: '21', crateTokenId: crateId(261) }]), 800);
  database.prepare(`INSERT INTO transactions(hash,status,from_block,requested_all,created_at_ms,last_requested_at_ms,receipt_seen,failure_json)
    VALUES(?,'reverted',100,1,1,1,1,?)`).run(observation(2).transactionHash,
    JSON.stringify({ status: 'reverted', observation: observation(2), confirmations: 1 }));
  database.prepare(`INSERT INTO transactions(hash,from_block,requested_all,created_at_ms,last_requested_at_ms)
    VALUES(?,100,1,1,1)`).run(observation(3).transactionHash);
  const candidate = database.prepare(`INSERT INTO replacement_candidates(original_hash,transaction_hash,crate_token_id,checked_at_ms,verified_at_ms,discovered_at_ms)
    VALUES(?,?,?,11,12,13)`);
  for (let index = 0; index < 80; index++) candidate.run(original, observation(2_000 + index).transactionHash, crateId(1_000 + index));
  database.prepare(`INSERT INTO replacement_chunks(original_hash,chunk_index,crate_ids_json,from_block,ranges_json,generation,completed)
    VALUES(?,0,?,900,'[]',3,0)`).run(original, JSON.stringify(Array.from({ length: 130 }, (_, index) => crateId(2_000 + index))));
  database.prepare(`INSERT INTO recovery_jobs(id,token_ids_json,ranges_json,next_check_ms,attempts)
    VALUES('old-token-job','["4001","4002"]','[{"fromBlock":100,"toBlock":500}]',20,2)`).run();
  database.prepare(`INSERT INTO token_recovery(token_id,job_id,status,checked_at_ms) VALUES(?,'old-token-job','recovering',20)`).run('4001');
  database.prepare(`INSERT INTO token_recovery(token_id,job_id,status,checked_at_ms) VALUES(?,'old-token-job','recovering',20)`).run('4002');
  database.prepare(`INSERT INTO provenance(token_id,transaction_hash,block_number,block_hash) VALUES('4001',?,500,?)`)
    .run(observation(4_001).transactionHash, observation(4_001, 500).blockHash);
  if (prototype) database.prepare('INSERT INTO crate_recovery_trackers(crate_token_id,transaction_hash) VALUES(?,?)').run(crateId(1), original);
  database.exec(`DROP TABLE receipt_claim_crates;
    DROP TABLE receipt_claim_tokens;
    DROP TABLE receipt_token_interest;
    DROP TABLE crate_candidates;
    DROP TABLE receipt_work;
    DROP TABLE crate_recovery_jobs;
    DROP TABLE reveal_recovery_migration`);
  for (const column of ['active_until_ms', 'claim_id', 'lease_until_ms', 'generation', 'claimed_generation', 'served_ms']) {
    database.exec(`ALTER TABLE recovery_jobs DROP COLUMN ${column}`);
  }
  if (!prototype) database.exec('DROP TABLE crate_recovery_trackers; ALTER TABLE replacement_candidates DROP COLUMN discovered_at_ms');
  return state;
}

for (const prototype of [false, true]) test(`${prototype ? 'prototype' : 'HEAD'} migration is association-bounded and restartable without changing frozen, private or publication records`, t => {
  const now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { rows, reopen, database } = prepareLegacyLedger(t, prototype);
  const preservedTables = ['settings', 'pools', 'free_slots', 'crates', 'assignments', 'observations', 'publication',
    'replacement_candidates', 'replacement_chunks', 'token_recovery', 'provenance'];
  const before = preservedTables.map(table => createHash('sha256').update(JSON.stringify(rows(`SELECT * FROM ${table} ORDER BY rowid`))).digest('hex'));
  const history = rows('SELECT * FROM transactions ORDER BY hash');
  const tokenJobs = rows('SELECT id,token_ids_json,ranges_json,next_check_ms,attempts FROM recovery_jobs ORDER BY id');
  let store = reopen();
  assert.equal(store.migrationReady(), false);
  assert.equal(store.claimReceipt(now, 'background'), null);
  assert.equal(store.claimScan(now, 'background'), null);
  assert.equal(store.frozen(ids(1)).length, 20);
  let chunks = 0;
  while (!store.migrationReady()) {
    const associations = Number(rows('SELECT COUNT(*) AS count FROM crate_candidates')[0].count);
    const progress = store.migrateChunk(now, 128);
    assert.ok(progress.processed <= 128);
    assert.ok(Number(rows('SELECT COUNT(*) AS count FROM crate_candidates')[0].count) - associations <= 128);
    assert.ok(++chunks < 100);
    const cursor = rows('SELECT * FROM reveal_recovery_migration');
    store = reopen();
    assert.deepEqual(rows('SELECT * FROM reveal_recovery_migration'), cursor);
  }
  assert.ok(chunks > 3);
  assert.equal(rows('SELECT COUNT(*) AS count FROM crate_recovery_jobs')[0].count, 473);
  const original = observation(1).transactionHash;
  assert.equal(rows(`SELECT COUNT(*) AS count FROM crate_candidates WHERE hash='${original}'`)[0].count, 471);
  for (const candidate of [observation(2_000).transactionHash, observation(2_079).transactionHash]) {
    assert.equal(rows(`SELECT COUNT(*) AS count FROM crate_candidates WHERE hash='${candidate}'`)[0].count, 1);
  }
  assert.equal(rows("SELECT COUNT(*) AS count FROM receipt_token_interest WHERE token_id='4001'")[0].count, 1);
  assert.equal(rows(`SELECT observed FROM receipt_work WHERE hash='${observation(2).transactionHash}'`)[0].observed, 1);
  assert.equal(rows(`SELECT observed FROM receipt_work WHERE hash='${observation(3).transactionHash}'`)[0].observed, 0);
  assert.deepEqual(preservedTables.map(table => createHash('sha256').update(JSON.stringify(rows(`SELECT * FROM ${table} ORDER BY rowid`))).digest('hex')), before);
  for (const row of history) assert.deepEqual(rows(`SELECT * FROM transactions WHERE hash='${row.hash}'`)[0], row);
  assert.deepEqual(rows('SELECT id,token_ids_json,ranges_json,next_check_ms,attempts FROM recovery_jobs ORDER BY id'), tokenJobs);
  const migrated = rows('SELECT * FROM crate_candidates ORDER BY crate_token_id,hash');
  assert.deepEqual(reopen().migrateChunk(now, 128), { ready: true, processed: 0 });
  assert.deepEqual(rows('SELECT * FROM crate_candidates ORDER BY crate_token_id,hash'), migrated);
  conservation(database, 20);
});

test('migration rolls back its associations and cursor together on a storage failure', t => {
  const { database, rows, reopen } = prepareLegacyLedger(t, true);
  const store = reopen();
  const before = rows('SELECT * FROM reveal_recovery_migration');
  database.exec(`CREATE TRIGGER reject_migration_candidate BEFORE INSERT ON crate_candidates
    BEGIN SELECT RAISE(ABORT,'Migration storage unavailable'); END`);
  assert.throws(() => store.migrateChunk(1_000_000, 128), /Migration storage unavailable/);
  assert.deepEqual(rows('SELECT * FROM reveal_recovery_migration'), before);
  assert.equal(rows('SELECT COUNT(*) AS count FROM crate_candidates')[0].count, 0);
  database.exec('DROP TRIGGER reject_migration_candidate');
  assert.equal(store.migrateChunk(1_000_000, 128).processed, 128);
});

for (const outcome of ['pending', 'confirmed'] as const) test(`same-tick unscoped ${outcome} evidence cannot replace a newer crate watcher`, t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store, rows } = fixture(t);
  const olderHash = observation(1).transactionHash, newerHash = observation(2).transactionHash;
  store.admitTransaction(olderHash, deployment.deploymentBlock, now);
  const older = store.claimReceipt(now, 'active', olderHash);
  assert.ok(older);
  store.admitTransaction(newerHash, deployment.deploymentBlock, now);
  const newer = store.claimReceipt(now, 'active', newerHash);
  assert.ok(newer);
  store.completeReceipt(deployment, newer, { status: 'confirmed', observation: observation(2, 501),
    crates: [{ crateTokenId: crateId(0), tokenIds: ids(1) }], confirmations: 1 }, now);
  const watcher = rows('SELECT * FROM crate_recovery_jobs');
  const frozen = store.frozen(ids(1));
  assert.equal(watcher[0].mode, 'observed');
  assert.equal(watcher[0].observed_hash, newerHash);
  assert.equal(watcher[0].updated_at_ms, now);
  const result = outcome === 'pending'
    ? { status: 'pending' as const, seen: true, crates: [crateId(0)], fromBlock: 500 }
    : { status: 'confirmed' as const, observation: observation(1, 500),
      crates: [{ crateTokenId: crateId(0), tokenIds: ids(21) }], confirmations: 64 };
  assert.equal(store.completeReceipt(deployment, older, result, now), true);
  const retained = rows('SELECT * FROM crate_recovery_jobs')[0];
  assert.deepEqual({ ...retained, receipt_due_ms: watcher[0].receipt_due_ms }, { ...watcher[0] });
  assert.deepEqual(store.frozen(ids(1)), frozen);
  assert.equal(store.summary().reserved, 0);
  assert.equal(store.frozen(ids(21)).length, outcome === 'confirmed' ? 20 : 0);

  now += 2_000;
  assert.equal(store.admitTransaction(olderHash, deployment.deploymentBlock, now), 'accepted');
  const fresh = store.claimReceipt(now, 'active', olderHash);
  assert.ok(fresh);
  assert.equal(store.completeReceipt(deployment, fresh, { status: 'confirmed', observation: observation(1, 502),
    crates: [{ crateTokenId: crateId(0), tokenIds: ids(21) }], confirmations: 1 }, now), true);
  const updated = rows('SELECT * FROM crate_recovery_jobs')[0];
  assert.equal(updated.mode, 'observed');
  assert.equal(updated.observed_hash, olderHash);
  assert.ok(Number(updated.generation) > Number(watcher[0].generation));
  assert.deepEqual(store.frozen(ids(1)), frozen);
  assert.equal(store.frozen(ids(21)).length, 20);
});

for (const outcome of ['pending', 'confirmed', 'reverted'] as const) test(`new canonical evidence for another hash survives a late ${outcome} receipt`, t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store, rows } = fixture(t);
  const olderHash = pendingCrates(store, 1, [crateId(0)], now);
  const replacementHash = observation(2).transactionHash;
  now += 2_000;
  const older = store.claimReceipt(now, 'active', olderHash);
  assert.ok(older);
  const split = store.claimScan(now, 'active');
  assert.ok(split);
  const low = { fromBlock: split.range.fromBlock, toBlock: 450 };
  const high = { fromBlock: 451, toBlock: 501 };
  assert.equal(store.completeCrateScan(split, { provenance: [], scannedRange: null, remainingRanges: [high, low],
    observedBlock: { number: 501, hash: observation(2, 501).blockHash } }, now), true);
  const scan = store.claimScan(now, 'active');
  assert.ok(scan);
  assert.deepEqual(scan.range, high);
  now += 100;
  assert.equal(store.completeCrateScan(scan, { provenance: [{ ...observation(2, 501), crateTokenIds: [crateId(0)] }],
    scannedRange: high, remainingRanges: [], observedBlock: { number: 501, hash: observation(2, 501).blockHash } }, now), true);
  const current = rows('SELECT * FROM crate_recovery_jobs')[0];
  assert.deepEqual(JSON.parse(String(current.ranges_json)), [low]);
  assert.ok(Number(current.generation) > 0);
  now += 100;
  const result = outcome === 'pending'
    ? { status: 'pending' as const, seen: true, crates: [crateId(0)], fromBlock: 500 }
    : outcome === 'confirmed'
      ? { status: 'confirmed' as const, observation: observation(1, 500),
        crates: [{ crateTokenId: crateId(0), tokenIds: ids(1) }], confirmations: 64 }
      : { status: 'reverted' as const, source: 'receipt' as const, observation: observation(1, 500), confirmations: 64 };
  assert.equal(store.completeReceipt(deployment, older, result, now), true);
  const retained = rows('SELECT * FROM crate_recovery_jobs')[0];
  assert.equal(retained.mode, 'recovering');
  assert.equal(retained.generation, current.generation);
  assert.equal(retained.updated_at_ms, current.updated_at_ms);
  assert.deepEqual(JSON.parse(String(retained.ranges_json)), [low]);
  const evidence = rows(`SELECT evidence_version,checked_version FROM crate_candidates WHERE hash='${replacementHash}'`)[0];
  assert.ok(Number(evidence.evidence_version) > Number(evidence.checked_version));
  const frozen = store.frozen(ids(1));
  assert.equal(frozen.length, outcome === 'confirmed' ? 20 : 0);
  const next = store.claimReceipt(now, 'active');
  assert.ok(next);
  assert.equal(next.hash, replacementHash);
  assert.equal(store.completeReceipt(deployment, next, { status: 'confirmed', observation: observation(2, 501),
    crates: [{ crateTokenId: crateId(0), tokenIds: ids(21) }], confirmations: 1 }, now), true);
  assert.equal(rows('SELECT observed_hash FROM crate_recovery_jobs')[0].observed_hash, replacementHash);
  assert.equal(store.frozen(ids(21)).length, 20);
  assert.deepEqual(store.frozen(ids(1)), frozen);
});

test('repeated identical scan evidence preserves the crate generation and remaining ranges', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store, rows } = fixture(t);
  pendingCrates(store, 1, [crateId(0)], now);
  const first = store.claimScan(now, 'active');
  assert.ok(first);
  const evidence = { ...observation(2, 501), crateTokenIds: [crateId(0)] };
  assert.equal(store.completeCrateScan(first, { provenance: [evidence], scannedRange: { fromBlock: first.range.fromBlock, toBlock: 501 },
    remainingRanges: [], observedBlock: { number: 501, hash: evidence.blockHash } }, now), true);
  const generation = rows('SELECT generation FROM crate_recovery_jobs')[0].generation;
  now += 2_000;
  const repeat = store.claimScan(now, 'active');
  assert.ok(repeat);
  assert.equal(store.completeCrateScan(repeat, { provenance: [evidence], scannedRange: { fromBlock: repeat.range.fromBlock, toBlock: 502 },
    remainingRanges: [], observedBlock: { number: 502, hash: observation(2, 502).blockHash } }, now), true);
  assert.equal(rows('SELECT generation FROM crate_recovery_jobs')[0].generation, generation);
  assert.equal(rows('SELECT ranges_json FROM crate_recovery_jobs')[0].ranges_json, '[]');
});

for (const order of ['scan-first', 'receipt-first'] as const) for (const sameHash of [false, true]) for (const sameTick of [false, true]) {
  test(`receipt/scan merge retains evidence and authority: ${order}, sameHash=${sameHash}, sameTick=${sameTick}`, t => {
    let now = 1_000_000;
    t.mock.method(Date, 'now', () => now);
    const { store, rows, reopen } = fixture(t);
    const original = pendingCrates(store, 1, [crateId(0)], now);
    const replacement = observation(sameHash ? 1 : 2, 501);
    now += 2_000;
    const receipt = store.claimReceipt(now, 'active', original), scan = store.claimScan(now, 'active');
    assert.ok(receipt && scan);
    const evidence = crateScan(scan, sameHash ? 1 : 2, 501);
    const finishReceipt = () => store.completeReceipt(deployment, receipt, confirmed(1, undefined, 64), now);
    const finishScan = () => store.completeCrateScan(scan, evidence, now);
    if (order === 'scan-first') {
      assert.equal(finishScan(), true);
      if (!sameTick) now += 100;
      assert.equal(finishReceipt(), true);
      assert.equal(rows('SELECT mode FROM crate_recovery_jobs')[0].mode, 'recovering');
    } else {
      assert.equal(finishReceipt(), true);
      const state = 'SELECT mode,observed_hash,from_block,ranges_json,scan_due_ms,scan_claim_id,scan_lease_until_ms FROM crate_recovery_jobs';
      const before = rows(state);
      if (!sameTick) now += 100;
      assert.equal(finishScan(), false);
      assert.deepEqual(rows(state), before);
    }
    const candidate = rows(`SELECT * FROM crate_candidates WHERE hash='${replacement.transactionHash}'`)[0];
    assert.equal(candidate.evidence_key, replacement.blockHash);
    assert.ok(Number(candidate.evidence_version) > Number(candidate.checked_version));
    const frozen = store.frozen(ids(1));
    assert.equal(frozen.length, 20);
    const restored = reopen();
    now += 2_000;
    const next = restored.claimReceipt(now, 'active');
    assert.ok(next);
    assert.equal(next.hash, replacement.transactionHash);
    assert.equal(restored.completeReceipt(deployment, next, { status: 'confirmed', observation: replacement,
      crates: [{ crateTokenId: crateId(0), tokenIds: ids(21) }], confirmations: 1 }, now), true);
    assert.deepEqual(restored.frozen(ids(1)), frozen);
    assert.equal(restored.frozen(ids(21)).length, 20);
    assert.equal(rows('SELECT observed_hash FROM crate_recovery_jobs')[0].observed_hash, replacement.transactionHash);
  });
}

for (const path of ['normal', 'overflow'] as const) for (const outcome of ['pending', 'confirmed'] as const) {
  for (const timing of ['before', 'same-tick', 'after'] as const) {
    test(`unscoped ${path} ${outcome} uses inspection start ${timing} the current observation`, t => {
      let now = 1_000_000;
      t.mock.method(Date, 'now', () => now);
      const { store, rows, reopen } = fixture(t);
      const hash = observation(1).transactionHash;
      if (timing === 'after') {
        store.freeze(deployment, observation(2, 500), [{ crateTokenId: crateId(0), tokenIds: ids(1) }], now);
        now += 100;
      }
      const startedAtMs = now;
      if (path === 'normal') store.admitTransaction(hash, deployment.deploymentBlock, now);
      const claim = path === 'normal' ? store.claimReceipt(now, 'active', hash) : null;
      if (path === 'normal') assert.ok(claim);
      if (timing !== 'after') {
        if (timing === 'before') now += 100;
        store.freeze(deployment, observation(2, 500), [{ crateTokenId: crateId(0), tokenIds: ids(1) }], now);
      }
      const frozen = store.frozen(ids(1));
      now += 100;
      const result = outcome === 'pending'
        ? { status: 'pending' as const, seen: true, crates: [crateId(0)], fromBlock: 500 }
        : { status: 'confirmed' as const, observation: observation(1, 501),
          crates: [{ crateTokenId: crateId(0), tokenIds: ids(21) }], confirmations: 64 };
      assert.equal(claim ? store.completeReceipt(deployment, claim, result, now)
        : store.acceptVerified(deployment, hash, result, startedAtMs, now), true);
      const job = rows('SELECT * FROM crate_recovery_jobs')[0];
      assert.equal(job.mode, timing === 'after' && outcome === 'pending' ? 'recovering' : 'observed');
      assert.equal(job.observed_hash, timing === 'after' && outcome === 'confirmed' ? hash : observation(2).transactionHash);
      assert.equal(store.summary().reserved, timing === 'after' && outcome === 'pending' ? 20 : 0);
      assert.deepEqual(store.frozen(ids(1)), frozen);
      if (timing !== 'after' || outcome === 'pending') {
        const restored = reopen();
        assert.ok(Number(restored.nextWake(now)) <= now + 2_000);
        now += 2_000;
        const next = restored.claimReceipt(now, 'active');
        assert.ok(next);
        assert.equal(next.hash, hash);
        assert.equal(restored.completeReceipt(deployment, next, { status: 'confirmed', observation: observation(1, 501),
          crates: [{ crateTokenId: crateId(0), tokenIds: ids(21) }], confirmations: 1 }, now), true);
        assert.equal(restored.frozen(ids(21)).length, 20);
        assert.deepEqual(restored.frozen(ids(1)), frozen);
      }
    });
  }
}

test('overflow completion cannot replace a receipt claim or a verification started later', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store, rows } = fixture(t);
  const hash = observation(1).transactionHash, startedAtMs = now;
  store.admitTransaction(hash, deployment.deploymentBlock, now);
  now += 100;
  const claim = store.claimReceipt(now, 'active', hash);
  assert.ok(claim);
  const before = rows('SELECT * FROM receipt_work');
  assert.equal(store.acceptVerified(deployment, hash, confirmed(1), startedAtMs, now), false);
  assert.deepEqual(rows('SELECT * FROM receipt_work'), before);
  assert.equal(store.completeReceipt(deployment, claim, confirmed(1), now), true);
  const complete = rows('SELECT * FROM receipt_work');
  now += 100;
  assert.equal(store.acceptVerified(deployment, hash, confirmed(1), startedAtMs, now), false);
  assert.deepEqual(rows('SELECT * FROM receipt_work'), complete);
});

for (const kind of ['crate', 'tokens'] as const) test(`expired ${kind} scans retain scoped evidence without releasing a newer scan lease`, t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store, rows, reopen } = fixture(t);
  if (kind === 'crate') pendingCrates(store, 1, [crateId(0)], now);
  else store.admitTokens(['1'], 100, now);
  const old = store.claimScan(now, 'active');
  assert.ok(old);
  now += 60_001;
  const current = store.claimScan(now, 'background');
  assert.ok(current);
  const projection = kind === 'crate'
    ? 'SELECT mode,observed_hash,from_block,ranges_json,scan_claim_id,scan_lease_until_ms FROM crate_recovery_jobs'
    : 'SELECT token_ids_json,ranges_json,claim_id,lease_until_ms FROM recovery_jobs';
  const before = rows(projection);
  const discovered = observation(2, 501);
  const complete = () => kind === 'crate' ? store.completeCrateScan(old, crateScan(old, 2, 501), now)
    : store.completeTokenScan(old, { provenance: [{ ...discovered, tokenIds: ['1', '21'] }],
      scannedRange: { fromBlock: 100, toBlock: 501 }, remainingRanges: [], mintedThrough: 40,
      observedBlock: { number: 501, hash: discovered.blockHash } }, now);
  assert.equal(complete(), false);
  assert.deepEqual(rows(projection), before);
  assert.equal(complete(), false);
  assert.deepEqual(rows(projection), before);
  const restored = reopen();
  const receipt = restored.claimReceipt(now, 'background');
  assert.ok(receipt);
  assert.equal(receipt.hash, discovered.transactionHash);
  assert.equal(restored.completeReceipt(deployment, receipt, { status: 'confirmed', observation: discovered,
    crates: [{ crateTokenId: crateId(0), tokenIds: ids(1) }, { crateTokenId: crateId(1), tokenIds: ids(21) }], confirmations: 1 }, now), true);
  assert.equal(restored.frozen(ids(1)).length, 20);
  assert.equal(restored.frozen(ids(21)).length, 0);
});

test('a late scoped confirmation retains distinct evidence without replacing a newer watcher', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store, rows, reopen } = fixture(t);
  const hash = pendingCrates(store, 1, [crateId(0)], now);
  now += 2_000;
  const claim = store.claimReceipt(now, 'active', hash);
  assert.ok(claim);
  store.freeze(deployment, observation(2, 501), [{ crateTokenId: crateId(0), tokenIds: ids(1) }], now);
  const frozen = store.frozen(ids(1));
  const result = { status: 'confirmed' as const, observation: observation(1, 502),
    crates: [{ crateTokenId: crateId(0), tokenIds: ids(21) }], confirmations: 64 };
  assert.equal(store.completeReceipt(deployment, claim, result, now), true);
  assert.equal(rows('SELECT observed_hash FROM crate_recovery_jobs')[0].observed_hash, observation(2).transactionHash);
  const candidate = rows(`SELECT * FROM crate_candidates WHERE hash='${hash}'`)[0];
  assert.equal(candidate.evidence_key, result.observation.blockHash);
  assert.ok(Number(candidate.evidence_version) > Number(candidate.checked_version));
  const restored = reopen();
  now += 2_000;
  const next = restored.claimReceipt(now, 'active');
  assert.ok(next);
  assert.equal(next.hash, hash);
  assert.equal(restored.completeReceipt(deployment, next, result, now), true);
  assert.equal(rows('SELECT observed_hash FROM crate_recovery_jobs')[0].observed_hash, hash);
  assert.deepEqual(restored.frozen(ids(1)), frozen);
  assert.equal(restored.frozen(ids(21)).length, 20);
});

for (const outcome of ['error', 'absent', 'pending', 'reverted', 'not_unpack'] as const) {
  test(`fresh replacement evidence remains retryable after ${outcome} while another hash is observed`, t => {
    let now = 1_000_000;
    t.mock.method(Date, 'now', () => now);
    const { store, rows, reopen } = fixture(t);
    pendingCrates(store, 1, [crateId(0)], now);
    const scan = store.claimScan(now, 'active');
    assert.ok(scan);
    store.freeze(deployment, observation(1, 500), [{ crateTokenId: crateId(0), tokenIds: ids(1) }], now);
    const frozen = store.frozen(ids(1));
    assert.equal(store.completeCrateScan(scan, crateScan(scan, 2, 501), now), false);
    const first = store.claimReceipt(now, 'active');
    assert.ok(first);
    assert.equal(first.hash, observation(2).transactionHash);
    if (outcome === 'error') assert.equal(store.failReceipt(first, now), true);
    else assert.equal(store.completeReceipt(deployment, first,
      outcome === 'reverted' || outcome === 'not_unpack'
        ? { status: outcome, source: 'receipt', observation: observation(2, 501), confirmations: 1 }
        : { status: 'pending', seen: outcome === 'pending' }, now), true);
    const candidate = rows(`SELECT * FROM crate_candidates WHERE hash='${first.hash}'`)[0];
    assert.ok(Number(candidate.evidence_version) > Number(candidate.checked_version));
    const restored = reopen();
    now += outcome === 'reverted' || outcome === 'not_unpack' ? 15_000 : outcome === 'error' ? 4_000 : 2_000;
    const next = restored.claimReceipt(now, 'active');
    assert.ok(next);
    assert.equal(next.hash, first.hash);
    assert.equal(restored.completeReceipt(deployment, next, { status: 'confirmed', observation: observation(2, 502),
      crates: [{ crateTokenId: crateId(0), tokenIds: ids(21) }], confirmations: 1 }, now), true);
    assert.equal(restored.frozen(ids(21)).length, 20);
    assert.deepEqual(restored.frozen(ids(1)), frozen);
    const checked = rows(`SELECT * FROM crate_candidates WHERE hash='${first.hash}'`)[0];
    assert.equal(checked.checked_version, checked.evidence_version);
  });
}

test('terminal non-unpack input releases opaque capacity without deleting its response history', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store, rows, reopen } = fixture(t);
  const hash = observation(1).transactionHash;
  assert.equal(store.admitTransaction(hash, 100, now), 'accepted');
  assert.equal(store.opaqueCount(), 1);
  const claim = store.claimReceipt(now, 'active', hash);
  assert.ok(claim);
  assert.equal(store.recordReceiptPresence(claim, now), true);
  assert.equal(store.completeReceipt(deployment, claim, { status: 'not_unpack', source: 'input' }, now), true);
  assert.equal(store.opaqueCount(), 0);
  assert.deepEqual({ ...rows('SELECT observed,opaque,resolved FROM receipt_work')[0] }, { observed: 1, opaque: 0, resolved: 1 });
  const response = store.transactionResponse(deployment, hash);
  assert.equal(response.status, 'not_unpack');
  assert.deepEqual(response.artworks, []);
  now += 86_400_000;
  const restored = reopen();
  assert.equal(restored.claimReceipt(now, 'background'), null);
  assert.equal(restored.nextWake(now), null);
  assert.deepEqual(restored.transactionResponse(deployment, hash), response);
  assert.equal(restored.knownTransaction(hash), true);
  assert.equal(restored.admitTransaction(observation(2).transactionHash, 100, now), 'accepted');
  assert.equal(restored.opaqueCount(), 1);
});

for (const preferred of [false, true]) test(`polling an ineligible active association cannot strand a shared quiet receipt, preferred=${preferred}`, t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store, rows, reopen } = fixture(t);
  const shared = observation(1).transactionHash, replacement = observation(2).transactionHash;
  const pending = pendingCrates(store, 3, [crateId(1)], now);
  now += 100;
  store.freeze(deployment, observation(1, 501), [
    { crateTokenId: crateId(0), tokenIds: ids(1) }, { crateTokenId: crateId(1), tokenIds: ids(21) },
  ], now);
  now += 40_000;
  const missing = store.claimReceipt(now, 'background', shared);
  assert.ok(missing);
  store.completeReceipt(deployment, missing, { status: 'pending', seen: false }, now);
  now += 100;
  store.admitTransaction(replacement, 100, now);
  const confirmed = store.claimReceipt(now, 'active', replacement);
  assert.ok(confirmed);
  store.completeReceipt(deployment, confirmed, { status: 'confirmed', observation: observation(2, 502),
    crates: [{ crateTokenId: crateId(1), tokenIds: ids(41) }], confirmations: 64 }, now);
  const frozen = store.frozen(ids(1, 60));
  now += 40_000;
  for (let pass = 0; pass < 4; pass++) {
    store.admitTransaction(pending, 100, now);
    const requested = store.claimReceipt(now, 'active', pending);
    assert.ok(requested);
    store.completeReceipt(deployment, requested, { status: 'pending', seen: true }, now);
    now += 2_001;
    assert.equal(store.claimReceipt(now, 'active'), null);
    const quiet = store.claimReceipt(now, 'background', preferred ? shared : undefined);
    assert.ok(quiet);
    assert.equal(quiet.hash, shared);
    assert.equal(quiet.active, false);
    assert.equal(store.claimReceipt(now, 'active', shared), null);
    assert.equal(store.claimReceipt(now, 'background', shared), null);
    store.completeReceipt(deployment, quiet, { status: 'pending', seen: false }, now);
    assert.equal(rows(`SELECT observed_hash FROM crate_recovery_jobs WHERE crate_token_id='${crateId(1)}'`)[0].observed_hash, replacement);
    now += 17_999;
  }
  const restored = reopen();
  const healthy = restored.claimReceipt(now, 'background', preferred ? shared : undefined);
  assert.ok(healthy);
  assert.equal(healthy.hash, shared);
  restored.completeReceipt(deployment, healthy, { status: 'confirmed', observation: observation(1, 503), crates: [
    { crateTokenId: crateId(0), tokenIds: ids(61) }, { crateTokenId: crateId(1), tokenIds: ids(81) },
  ], confirmations: 1 }, now);
  assert.deepEqual(restored.frozen(ids(1, 60)), frozen);
  assert.equal(restored.frozen(ids(61, 40)).length, 40);
});

test('preferred hashes obey monitor due times until explicitly readmitted', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store } = fixture(t);
  const hash = observation(1).transactionHash;
  store.freeze(deployment, observation(1), [{ crateTokenId: crateId(0), tokenIds: ids(1) }], now);
  now += 2_000;
  assert.equal(store.claimReceipt(now, 'background', hash), null);
  store.admitTransaction(hash, 100, now);
  assert.equal(store.claimReceipt(now, 'active', hash, [hash]), null);
  const claim = store.claimReceipt(now, 'active', hash);
  assert.ok(claim);
  assert.equal(claim.hash, hash);
  assert.equal(claim.active, true);
});

test('unminted recovery closes every receipt interest and stale scans cannot recreate it', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store, rows, reopen } = fixture(t);
  store.admitTokens(['21'], 100, now);
  const first = store.claimScan(now, 'active', { tokenIds: ['21'] });
  assert.ok(first);
  const evidence = { provenance: [{ ...observation(1, 500), tokenIds: ['21'] }],
    scannedRange: { fromBlock: 100, toBlock: 500 }, remainingRanges: [], mintedThrough: 40,
    observedBlock: { number: 500, hash: observation(1, 500).blockHash } };
  assert.equal(store.completeTokenScan(first, evidence, now), true);
  now += 2_000;
  const second = store.claimScan(now, 'active', { tokenIds: ['21'] });
  assert.ok(second);
  assert.equal(store.completeTokenScan(second, { ...evidence, provenance: [{ ...observation(2, 501), tokenIds: ['21'] }],
    scannedRange: { fromBlock: 100, toBlock: 501 }, observedBlock: { number: 501, hash: observation(2, 501).blockHash } }, now), true);
  assert.equal(rows('SELECT COUNT(*) AS count FROM receipt_token_interest')[0].count, 2);
  now += 2_000;
  const closing = store.claimScan(now, 'active', { tokenIds: ['21'] });
  assert.ok(closing);
  assert.equal(store.completeTokenScan(closing, { provenance: [], scannedRange: null, remainingRanges: [], mintedThrough: 20,
    observedBlock: { number: 502, hash: observation(2, 502).blockHash } }, now), true);
  assert.deepEqual(store.tokensResponse(deployment, ['21']).unresolved, [{ tokenId: '21', status: 'unminted' }]);
  assert.equal(rows('SELECT COUNT(*) AS count FROM recovery_jobs')[0].count, 0);
  assert.equal(rows('SELECT COUNT(*) AS count FROM receipt_token_interest')[0].count, 0);
  assert.equal(store.completeTokenScan(first, evidence, now), false);
  assert.equal(rows('SELECT COUNT(*) AS count FROM receipt_token_interest')[0].count, 0);
  now += 86_400_000;
  const restored = reopen();
  assert.equal(restored.claimReceipt(now, 'background'), null);
  assert.equal(restored.claimScan(now, 'background'), null);
  assert.equal(restored.summary().frozen, 0);
});

for (const outcome of ['pending', 'confirmed'] as const) test(`an in-flight ${outcome} token receipt cannot revive recovery after it closes as unminted`, t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store, rows, reopen } = fixture(t);
  store.admitTokens(['21'], 100, now);
  const scan = store.claimScan(now, 'active', { tokenIds: ['21'] });
  assert.ok(scan);
  store.completeTokenScan(scan, { provenance: [{ ...observation(1, 500), tokenIds: ['21'] }],
    scannedRange: { fromBlock: 100, toBlock: 500 }, remainingRanges: [], mintedThrough: 40,
    observedBlock: { number: 500, hash: observation(1, 500).blockHash } }, now);
  const receipt = store.claimReceipt(now, 'active', observation(1).transactionHash);
  assert.ok(receipt);
  now += 2_000;
  const closing = store.claimScan(now, 'active', { tokenIds: ['21'] });
  assert.ok(closing);
  store.completeTokenScan(closing, { provenance: [], scannedRange: null, remainingRanges: [], mintedThrough: 20,
    observedBlock: { number: 501, hash: observation(2, 501).blockHash } }, now);
  assert.equal(store.completeReceipt(deployment, receipt, outcome === 'pending'
    ? { status: 'pending', seen: true, crates: [crateId(0)], fromBlock: 501 }
    : confirmed(1, [{ crateTokenId: crateId(0), tokenIds: ids(21) }]), now), true);
  assert.equal(store.transactionJob(receipt.hash)!.crates_json, '[]');
  assert.equal(store.summary().reserved, 0);
  assert.equal(store.summary().frozen, 0);
  assert.equal(rows('SELECT COUNT(*) AS count FROM publication')[0].count, 0);
  assert.equal(rows('SELECT COUNT(*) AS count FROM crate_recovery_jobs')[0].count, 0);
  assert.equal(rows('SELECT COUNT(*) AS count FROM receipt_token_interest')[0].count, 0);
  assert.deepEqual(store.tokensResponse(deployment, ['21']).unresolved, [{ tokenId: '21', status: 'unminted' }]);
  now += 2_000;
  const restored = reopen();
  assert.equal(restored.claimReceipt(now, 'active'), null);
  assert.equal(restored.claimScan(now, 'active'), null);
  assert.equal(restored.nextWake(now), null);
});

for (const authorization of ['full hash', 'crate'] as const) for (const outcome of ['pending', 'confirmed'] as const) test(`closing token recovery preserves independent ${authorization} authorization for ${outcome} receipts`, t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store, rows } = fixture(t);
  const hash = observation(1).transactionHash;
  store.admitTokens(['21'], 100, now);
  const tokenScan = store.claimScan(now, 'active', { tokenIds: ['21'] });
  assert.ok(tokenScan);
  store.completeTokenScan(tokenScan, { provenance: [{ ...observation(1, 500), tokenIds: ['21'] }],
    scannedRange: { fromBlock: 100, toBlock: 500 }, remainingRanges: [], mintedThrough: 40,
    observedBlock: { number: 500, hash: observation(1, 500).blockHash } }, now);
  if (authorization === 'full hash') assert.equal(store.admitTransaction(hash, 100, now), 'accepted');
  else {
    pendingCrates(store, 9, [crateId(0)], now);
    const crate = store.claimScan(now, 'active');
    assert.ok(crate && crate.kind === 'crate');
    store.completeCrateScan(crate, crateScan(crate, 1, 500), now);
    assert.equal(store.transactionJob(hash)!.requested_all, 0);
  }
  const receipt = store.claimReceipt(now, 'active', hash);
  assert.ok(receipt);
  now += 2_000;
  const closing = store.claimScan(now, 'active', { tokenIds: ['21'] });
  assert.ok(closing);
  store.completeTokenScan(closing, { provenance: [], scannedRange: null, remainingRanges: [], mintedThrough: 20,
    observedBlock: { number: 501, hash: observation(2, 501).blockHash } }, now);
  assert.equal(rows('SELECT COUNT(*) AS count FROM receipt_token_interest')[0].count, 0);
  if (outcome === 'pending') {
    store.completeReceipt(deployment, receipt, { status: 'pending', seen: true, crates: [crateId(0), crateId(1)], fromBlock: 501 }, now);
    const expected = authorization === 'full hash' ? [crateId(0), crateId(1)] : [crateId(0)];
    assert.deepEqual(JSON.parse(store.transactionJob(hash)!.crates_json), expected);
    assert.deepEqual(rows('SELECT crate_token_id FROM crate_recovery_jobs ORDER BY crate_token_id').map(row => row.crate_token_id), expected);
    assert.equal(store.summary().reserved, expected.length * 20);
    now += 2_000;
    const next = store.claimReceipt(now, 'active', hash);
    assert.ok(next);
    store.completeReceipt(deployment, next, confirmed(1, [
      { crateTokenId: crateId(0), tokenIds: ids(21) }, { crateTokenId: crateId(1), tokenIds: ids(41) },
    ]), now);
    assert.equal(store.frozen(ids(41)).length, authorization === 'full hash' ? 20 : 0);
  } else assert.equal(store.completeReceipt(deployment, receipt, confirmed(1, [{ crateTokenId: crateId(0), tokenIds: ids(21) }]), now), true);
  assert.equal(store.frozen(ids(21)).length, 20);
  assert.equal(rows(`SELECT observed_hash FROM crate_recovery_jobs WHERE crate_token_id='${crateId(0)}'`)[0].observed_hash, hash);
});

test('token provenance preserves an existing full transaction reservation at capacity', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { database, store, rows, reopen } = fixture(t);
  fillOpaqueWatches(database, now);
  const hash = observation(1).transactionHash;
  store.admitTokens(['1'], 100, now);
  const scan = store.claimScan(now, 'active', { tokenIds: ['1'] });
  assert.ok(scan);
  store.completeTokenScan(scan, { provenance: [{ ...observation(1, 500), tokenIds: ['1'] }],
    scannedRange: { fromBlock: 100, toBlock: 500 }, remainingRanges: [], mintedThrough: 20,
    observedBlock: { number: 500, hash: observation(1, 500).blockHash } }, now);
  assert.equal(rows('SELECT COUNT(*) AS count FROM crate_candidates')[0].count, 0);
  assert.equal(store.opaqueCount(), 10_000);
  assert.equal(store.admitTransaction(observation(20_000).transactionHash, 100, now), 'capacity');
  const restored = reopen();
  assert.equal(restored.admitTransaction(hash, 100, now), 'accepted');
  const receipt = restored.claimReceipt(now, 'active', hash);
  assert.ok(receipt);
  restored.completeReceipt(deployment, receipt, confirmed(1), now);
  assert.equal(restored.opaqueCount(), 9_999);
  assert.equal(restored.admitTransaction(observation(20_000).transactionHash, 100, now), 'accepted');
});

test('legacy provenance import preserves an admitted unresolved reservation', t => {
  const now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { database, rows, reopen } = fixture(t);
  const observed = observation(1, 500);
  database.prepare('INSERT INTO transactions(hash,from_block,requested_all,created_at_ms,last_requested_at_ms) VALUES(?,100,1,?,?)')
    .run(observed.transactionHash, now, now);
  database.exec("INSERT INTO recovery_jobs(id,token_ids_json,ranges_json) VALUES('legacy-token','[\"1\"]','[{\"fromBlock\":100}]')");
  database.exec("INSERT INTO token_recovery(token_id,job_id,status) VALUES('1','legacy-token','recovering')");
  database.prepare("INSERT INTO provenance(token_id,transaction_hash,block_number,block_hash) VALUES('1',?,500,?)")
    .run(observed.transactionHash, observed.blockHash);
  database.exec('DELETE FROM reveal_recovery_migration');
  let store = reopen();
  assert.equal(store.opaqueCount(), 1);
  while (!store.migrationReady()) {
    store.migrateChunk(now, 2);
    assert.equal(store.opaqueCount(), 1);
    store = reopen();
  }
  assert.equal(rows('SELECT opaque FROM receipt_work')[0].opaque, 1);
  assert.equal(rows('SELECT COUNT(*) AS count FROM crate_candidates')[0].count, 0);
  assert.equal(store.admitTransaction(observed.transactionHash, 100, now), 'accepted');
});

test('migrated orphan reservations wake only for discovery after backoff', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { database, store, rows, reopen } = fixture(t);
  store.reserve([crateId(0)]);
  database.exec('DELETE FROM reveal_recovery_migration');
  const migrated = reopen();
  while (!migrated.migrationReady()) migrated.migrateChunk(now, 128);
  assert.equal(rows('SELECT COUNT(*) AS count FROM crate_candidates')[0].count, 0);
  for (let attempt = 0; attempt < 8; attempt++) {
    const scan = migrated.claimScan(now, 'background');
    assert.ok(scan);
    migrated.completeCrateScan(scan, crateScan(scan, undefined, 500), now);
    const job = rows('SELECT receipt_due_ms,scan_due_ms FROM crate_recovery_jobs')[0];
    assert.equal(job.receipt_due_ms, Number.MAX_SAFE_INTEGER);
    assert.equal(migrated.nextWake(now), Number(job.scan_due_ms));
    assert.equal(migrated.claimReceipt(now + 250, 'background'), null);
    assert.equal(migrated.claimScan(now + 250, 'background'), null);
    if (attempt === 7) assert.equal(Number(job.scan_due_ms) - now, 300_000);
    now = Number(job.scan_due_ms);
  }
  assert.equal(migrated.summary().reserved, 20);
});

test('deployed lifecycle repair is bounded and restartable while preserving admitted work and immutable state', t => {
  const now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { database, store, rows, reopen } = fixture(t);
  fillOpaqueWatches(database, now);
  store.freeze(deployment, observation(90_000), [{ crateTokenId: crateId(0), tokenIds: ids(1) }], now);
  store.reserve([crateId(1)]);
  for (const index of [20_000, 20_001]) {
    const hash = observation(index).transactionHash;
    database.prepare('INSERT INTO transactions(hash,from_block,requested_all,created_at_ms,last_requested_at_ms) VALUES(?,100,1,?,?)').run(hash, now, now);
    database.prepare('INSERT INTO receipt_work(hash,requested_all,observed,opaque,created_at_ms) VALUES(?,1,1,0,?)').run(hash, now);
  }
  database.prepare(`INSERT INTO crate_recovery_jobs(crate_token_id,from_block,ranges_json,receipt_due_ms,scan_due_ms,
    scan_claim_id,scan_lease_until_ms,generation,scan_claim_generation) VALUES(?,100,'[{"fromBlock":100,"toBlock":500}]',0,?,'kept-scan',?,3,3)`)
    .run(crateId(1), now + 300_000, now + 30_000);
  database.exec("INSERT INTO recovery_jobs(id,token_ids_json,ranges_json) VALUES('live-token','[\"5001\"]','[{\"fromBlock\":100}]')");
  database.exec("INSERT INTO token_recovery(token_id,job_id,status) VALUES('5001','live-token','recovering')");
  database.prepare("INSERT INTO receipt_token_interest(hash,token_id) VALUES(?,'5001')").run(observation(20_000).transactionHash);
  database.exec(`WITH RECURSIVE ids(id) AS (SELECT 4001 UNION ALL SELECT id+1 FROM ids WHERE id<4200)
    INSERT INTO token_recovery(token_id,status,checked_at_ms) SELECT CAST(id AS TEXT),'unminted',1000000 FROM ids`);
  database.prepare(`INSERT INTO receipt_token_interest(hash,token_id) SELECT ?,token_id FROM token_recovery WHERE status='unminted'`)
    .run(observation(1).transactionHash);
  for (const token of ['1', '6000']) database.prepare('INSERT INTO receipt_token_interest(hash,token_id) VALUES(?,?)').run(observation(1).transactionHash, token);
  database.prepare("UPDATE receipt_work SET claim_id='kept-receipt',lease_until_ms=? WHERE hash=?").run(now + 30_000, observation(1).transactionHash);
  database.prepare("INSERT INTO receipt_claim_tokens(hash,claim_id,token_id) VALUES(?,'kept-receipt','4001')").run(observation(1).transactionHash);
  database.exec("DELETE FROM reveal_migrations WHERE name='reveal-recovery-lifecycle-v1'");
  let restored = reopen();
  assert.equal(restored.migrationReady(), false);
  assert.equal(rows('SELECT phase FROM reveal_recovery_migration')[0].phase, 'repair-watches');
  assert.equal(restored.opaqueCount(), 10_002);
  assert.equal(restored.admitTransaction(observation(30_000).transactionHash, 100, now), 'capacity');
  assert.equal(restored.admitTransaction(observation(20_000).transactionHash, 100, now), 'accepted');
  assert.equal(restored.frozen(ids(1)).length, 20);
  assert.equal(restored.claimPublications(now, 1).length, 1);
  const preserved = ['settings', 'pools', 'free_slots', 'crates', 'assignments', 'observations', 'publication', 'transactions', 'token_recovery', 'recovery_jobs', 'receipt_claim_tokens'];
  const before = preserved.map(table => createHash('sha256').update(JSON.stringify(rows(`SELECT * FROM ${table} ORDER BY rowid`))).digest('hex'));
  const scanState = rows(`SELECT from_block,ranges_json,scan_due_ms,scan_claim_id,scan_lease_until_ms,generation,scan_claim_generation FROM crate_recovery_jobs WHERE crate_token_id='${crateId(1)}'`);
  let batches = 0;
  while (!restored.migrationReady()) {
    assert.equal(restored.claimReceipt(now, 'active'), null);
    const result = restored.migrateChunk(now, 128);
    assert.ok(result.processed <= 128);
    assert.ok(++batches < 100);
    const cursor = rows('SELECT * FROM reveal_recovery_migration');
    restored = reopen();
    assert.deepEqual(rows('SELECT * FROM reveal_recovery_migration'), cursor);
  }
  assert.ok(batches > 2);
  assert.deepEqual(preserved.map(table => createHash('sha256').update(JSON.stringify(rows(`SELECT * FROM ${table} ORDER BY rowid`))).digest('hex')), before);
  assert.deepEqual(rows(`SELECT from_block,ranges_json,scan_due_ms,scan_claim_id,scan_lease_until_ms,generation,scan_claim_generation FROM crate_recovery_jobs WHERE crate_token_id='${crateId(1)}'`), scanState);
  assert.equal(rows(`SELECT receipt_due_ms FROM crate_recovery_jobs WHERE crate_token_id='${crateId(1)}'`)[0].receipt_due_ms, Number.MAX_SAFE_INTEGER);
  assert.equal(restored.opaqueCount(), 10_002);
  assert.equal(rows(`SELECT opaque FROM receipt_work WHERE hash='${observation(20_001).transactionHash}'`)[0].opaque, 1);
  assert.deepEqual(rows('SELECT token_id FROM receipt_token_interest').map(row => row.token_id), ['5001']);
  assert.equal(rows(`SELECT claim_id FROM receipt_work WHERE hash='${observation(1).transactionHash}'`)[0].claim_id, 'kept-receipt');
  assert.equal(rows("SELECT COUNT(*) AS count FROM reveal_migrations WHERE name='reveal-recovery-lifecycle-v1'")[0].count, 1);
  assert.deepEqual(restored.migrateChunk(now, 128), { ready: true, processed: 0 });
  assert.equal(restored.admitTransaction(observation(30_000).transactionHash, 100, now), 'capacity');
  conservation(database, 20);
});

test('lifecycle repair rolls back its changes and cursor together after storage failure', t => {
  const now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { database, store, rows, reopen } = fixture(t);
  store.admitTransaction(observation(1).transactionHash, 100, now);
  database.exec("UPDATE receipt_work SET opaque=0; DELETE FROM reveal_migrations WHERE name='reveal-recovery-lifecycle-v1'");
  const restored = reopen();
  const before = rows('SELECT * FROM reveal_recovery_migration');
  database.exec("CREATE TRIGGER reject_watch_repair BEFORE UPDATE OF opaque ON receipt_work BEGIN SELECT RAISE(ABORT,'Repair unavailable'); END");
  assert.throws(() => restored.migrateChunk(now, 128), /Repair unavailable/);
  assert.deepEqual(rows('SELECT * FROM reveal_recovery_migration'), before);
  assert.equal(rows('SELECT opaque FROM receipt_work')[0].opaque, 0);
  assert.equal(restored.opaqueCount(), 1);
  database.exec('DROP TRIGGER reject_watch_repair');
  while (!restored.migrationReady()) restored.migrateChunk(now, 128);
  assert.equal(rows('SELECT opaque FROM receipt_work')[0].opaque, 1);
});

test('live token-only recovery waits for matching receipt IDs before admitting bundled pending crates', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store, rows, reopen } = fixture(t);
  store.admitTokens(['21'], 100, now);
  const scan = store.claimScan(now, 'active', { tokenIds: ['21'] });
  assert.ok(scan);
  store.completeTokenScan(scan, { provenance: [{ ...observation(1, 500), tokenIds: ['21'] }],
    scannedRange: { fromBlock: 100, toBlock: 500 }, remainingRanges: [], mintedThrough: 40,
    observedBlock: { number: 500, hash: observation(1, 500).blockHash } }, now);
  const pending = store.claimReceipt(now, 'active');
  assert.ok(pending);
  store.completeReceipt(deployment, pending, { status: 'pending', seen: true, crates: [crateId(0), crateId(1)], fromBlock: 501 }, now);
  assert.equal(store.transactionJob(pending.hash)!.crates_json, '[]');
  assert.equal(store.summary().reserved, 0);
  assert.equal(rows('SELECT COUNT(*) AS count FROM crate_recovery_jobs')[0].count, 0);
  assert.equal(rows('SELECT COUNT(*) AS count FROM crate_candidates')[0].count, 0);
  assert.equal(rows('SELECT COUNT(*) AS count FROM receipt_token_interest')[0].count, 1);
  const restored = reopen();
  now += 2_000;
  const receipt = restored.claimReceipt(now, 'active');
  assert.ok(receipt);
  restored.completeReceipt(deployment, receipt, confirmed(1, [
    { crateTokenId: crateId(0), tokenIds: ids(1) }, { crateTokenId: crateId(1), tokenIds: ids(21) },
  ]), now);
  assert.equal(restored.frozen(ids(1)).length, 0);
  assert.equal(restored.frozen(ids(21)).length, 20);
  assert.deepEqual(rows('SELECT crate_token_id FROM crate_recovery_jobs').map(row => row.crate_token_id), [crateId(1)]);
});
