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

test('pending, cancellation and replacement hashes keep private crate reservations without revealing media', t => {
  const { database, store, rows } = fixture(t);
  const first = observation(1).transactionHash;
  const replacement = observation(2).transactionHash;
  store.registerTransaction(first, deployment.deploymentBlock);
  store.pendingTransaction(first, [crateId(0)], 101, 1);
  const reserved = rows('SELECT category,asset_id,crate_token_id,slot FROM assignments ORDER BY slot');
  store.pendingTransaction(first, [crateId(0)], 102, 2);
  store.finishTransaction(first, 'reverted', 3);
  store.registerTransaction(replacement, deployment.deploymentBlock);
  store.pendingTransaction(replacement, [crateId(0)], 103, 4);
  assert.deepEqual(rows('SELECT category,asset_id,crate_token_id,slot FROM assignments ORDER BY slot'), reserved);
  assert.equal(store.summary().reserved, 20);
  assert.deepEqual(store.frozen(ids(1)), []);
  for (const hash of [first, replacement]) {
    const response = store.transactionResponse(deployment, hash);
    assert.deepEqual(response.artworks, []);
    assert.equal(JSON.stringify(response).includes('wip.lil.org'), false);
  }
  assert.equal(store.claimPublications(10).length, 0);
  conservation(database, 0);
});

test('frozen token assignments and bytes survive repeated receipts, reorganization and pending replays', t => {
  const { database, store, rows } = fixture(t);
  const first = observation(1);
  store.reserve([crateId(0)]);
  store.freeze(deployment, first, [{ crateTokenId: crateId(0), tokenIds: ids(1) }], 1);
  const original = rows('SELECT * FROM assignments WHERE token_id IS NOT NULL ORDER BY token_id');
  store.freeze(deployment, first, [{ crateTokenId: crateId(0), tokenIds: ids(1) }], 2);
  store.finishTransaction(first.transactionHash, 'reverted', 3);
  assert.deepEqual(rows('SELECT * FROM assignments WHERE token_id IS NOT NULL ORDER BY token_id'), original);
  assert.throws(() => database.exec("UPDATE assignments SET metadata_json='{}' WHERE token_id='1'"), /Frozen reveal cannot change/);
  assert.throws(() => database.exec("DELETE FROM assignments WHERE token_id='1'"), /Frozen reveal cannot be deleted/);
  store.reserve([crateId(0)]);
  assert.equal(store.summary().reserved, 20);
  store.freeze(deployment, observation(2, 102), [{ crateTokenId: crateId(0), tokenIds: ids(1) }], 4);
  assert.equal(store.summary().reserved, 0);
  assert.deepEqual(rows('SELECT * FROM assignments WHERE token_id IS NOT NULL ORDER BY token_id'), original);
  assert.equal(store.transactionResponse(deployment, first.transactionHash).status, 'revealed');
  conservation(database, 20);
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

test('partial token recovery does not request other crates until a transaction lookup explicitly upgrades it', t => {
  const { store } = fixture(t);
  const observed = observation(1);
  store.freeze(deployment, observed, [{ crateTokenId: crateId(0), tokenIds: ids(1) }], 1, false);
  assert.equal(store.transactionJob(observed.transactionHash)?.requested_all, 0);
  assert.equal(store.transactionJob(observed.transactionHash)?.revealed_all, 0);
  assert.equal(store.frozen(ids(21)).length, 0);
  assert.equal(store.transactionResponse(deployment, observed.transactionHash).status, 'pending');
  assert.deepEqual(store.transactionResponse(deployment, observed.transactionHash).artworks, []);
  store.registerTransaction(observed.transactionHash, deployment.deploymentBlock, true);
  assert.equal(store.transactionJob(observed.transactionHash)?.requested_all, 1);
  assert.equal(store.transactionJob(observed.transactionHash)?.next_check_ms, 0);
  store.freeze(deployment, observed, [{ crateTokenId: crateId(0), tokenIds: ids(1) }, { crateTokenId: crateId(1), tokenIds: ids(21) }], 2, true);
  assert.equal(store.transactionResponse(deployment, observed.transactionHash).status, 'revealed');
  assert.equal(store.transactionResponse(deployment, observed.transactionHash).artworks.length, 40);
  assert.equal(store.transactionResponse(deployment, observed.transactionHash).retryAfterMs, 0);
});

test('full transaction polling wakes an incomplete historical result after its active lease ends', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store } = fixture(t);
  const observed = observation(1);
  store.freeze(deployment, observed, [{ crateTokenId: crateId(0), tokenIds: ids(1) }], now, false);
  now += 15_000;
  assert.ok(store.claimTransaction(observed.transactionHash, now));
  store.registerTransaction(observed.transactionHash, deployment.deploymentBlock);
  assert.equal(store.claimTransaction(observed.transactionHash, now), null);
  store.freeze(deployment, observed, [{ crateTokenId: crateId(0), tokenIds: ids(1) }], now, false);
  store.retryTransaction(observed.transactionHash, now, 86_400_000);
  now += 2_000;
  store.registerTransaction(observed.transactionHash, deployment.deploymentBlock);
  assert.ok(store.claimTransaction(observed.transactionHash, now));
});

test('existing ledgers repair skipped cursors and incomplete requests once without changing frozen or private assignments', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { database, store, rows, reopen } = fixture(t);
  const pending = observation(1).transactionHash;
  store.registerTransaction(pending, deployment.deploymentBlock);
  store.pendingTransaction(pending, [crateId(0)], 500, now);
  store.replacementRanges(pending, [{ fromBlock: 301, toBlock: 500 }], 1000);
  const observed = observation(2);
  store.freeze(deployment, observed, [{ crateTokenId: crateId(1), tokenIds: ids(1) }], now, false);
  store.registerTransaction(observed.transactionHash, deployment.deploymentBlock);
  store.retryTransaction(observed.transactionHash, now, 86_400_000);
  database.prepare('UPDATE transactions SET lease_until_ms=? WHERE hash=?').run(now + 30_000, observed.transactionHash);
  const assignments = rows('SELECT * FROM assignments ORDER BY category,asset_id');
  const publications = rows('SELECT * FROM publication ORDER BY token_id');
  database.exec('DROP TABLE reveal_migrations');
  const repaired = reopen();
  assert.equal(repaired.transactionJob(pending)!.from_block, deployment.deploymentBlock);
  assert.equal(repaired.transactionJob(pending)!.replacement_ranges_json, '[]');
  assert.equal(repaired.transactionJob(observed.transactionHash)!.next_check_ms, now + 30_000);
  assert.equal(repaired.claimTransaction(observed.transactionHash, now), null);
  assert.deepEqual(rows('SELECT * FROM assignments ORDER BY category,asset_id'), assignments);
  assert.deepEqual(rows('SELECT * FROM publication ORDER BY token_id'), publications);
  conservation(database, 20);
  repaired.replacementRanges(pending, [], 700);
  now += 30_000;
  assert.ok(repaired.claimTransaction(observed.transactionHash, now));
  const again = reopen();
  assert.equal(again.transactionJob(pending)!.from_block, 700);
  assert.equal(again.claimTransaction(observed.transactionHash, now), null);
});

test('existing ledgers replay skipped replacement discoveries once and retain candidate hashes across reopening', t => {
  const { database, store, rows, reopen } = fixture(t);
  const original = observation(1).transactionHash;
  store.registerTransaction(original, deployment.deploymentBlock);
  store.pendingTransaction(original, [crateId(0)], 500, 1);
  store.replacementRanges(original, [{ fromBlock: 901, toBlock: 1000 }], 1000);
  store.freeze(deployment, observation(2), [{ crateTokenId: crateId(1), tokenIds: ids(1) }], 2);
  const assignments = rows('SELECT * FROM assignments ORDER BY category,asset_id');
  const publications = rows('SELECT * FROM publication ORDER BY token_id');
  database.exec("DROP TABLE replacement_candidates; DELETE FROM reveal_migrations WHERE name='replacement-candidates-v1'");
  const upgraded = reopen();
  assert.equal(upgraded.transactionJob(original)!.from_block, deployment.deploymentBlock);
  assert.equal(upgraded.transactionJob(original)!.replacement_ranges_json, '[]');
  assert.equal(upgraded.transactionJob(original)!.requested_all, 1);
  assert.deepEqual(rows('SELECT * FROM assignments ORDER BY category,asset_id'), assignments);
  assert.deepEqual(rows('SELECT * FROM publication ORDER BY token_id'), publications);
  upgraded.rememberReplacementCandidates(original, [
    { transactionHash: observation(3).transactionHash, crateTokenIds: [crateId(0)] },
    { transactionHash: observation(4).transactionHash, crateTokenIds: [crateId(0)] },
  ]);
  upgraded.replacementRanges(original, [], 700);
  const restored = reopen();
  assert.equal(restored.transactionJob(original)!.from_block, 700);
  assert.equal(restored.replacementCandidates(original, [crateId(0)]).length, 2);
  conservation(database, 20);
});

test('incomplete replacement scope checks unvisited candidates before repeatedly verifying completed crates', t => {
  const { store } = fixture(t);
  const original = observation(1).transactionHash, first = observation(2).transactionHash, second = observation(3).transactionHash;
  store.registerTransaction(original, deployment.deploymentBlock);
  store.rememberReplacementCandidates(original, [
    { transactionHash: first, crateTokenIds: [crateId(0)] },
    { transactionHash: second, crateTokenIds: [crateId(1)] },
  ]);
  store.recordReplacementCheck(original, first, [crateId(0)], 10);
  assert.equal(store.replacementCandidates(original, [crateId(0), crateId(1)])[0].transactionHash, second);
});

test('partial freezes preserve every admitted crate across observations and later pending checks', t => {
  const { store } = fixture(t);
  const hash = observation(1).transactionHash;
  store.registerTransaction(hash, 100);
  store.pendingTransaction(hash, [crateId(0), crateId(1)], 100, 1);
  store.freeze(deployment, observation(1), [{ crateTokenId: crateId(0), tokenIds: ids(1) }], 2, false);
  store.freeze(deployment, observation(1, 102), [{ crateTokenId: crateId(0), tokenIds: ids(21) }], 3, false);
  store.pendingTransaction(hash, [crateId(0)], 103, 4);
  assert.deepEqual(JSON.parse(store.transactionJob(hash)!.crates_json), [crateId(0), crateId(1)]);
  assert.equal(store.transactionJob(hash)!.requested_all, 1);
  assert.equal(store.transactionResponse(deployment, hash).status, 'pending');
  assert.deepEqual(JSON.parse(store.transactionJob(hash)!.tokens_json).map((value: { tokenId: string }) => value.tokenId), ids(21));
});

test('replacement chunks persist independent cursors and reject stale generation commits', t => {
  const { store, reopen } = fixture(t);
  const hash = observation(1).transactionHash;
  const crates = Array.from({ length: 31 }, (_, index) => crateId(index));
  store.registerTransaction(hash, 100);
  store.pendingTransaction(hash, crates, 100, 1);
  const generation = store.transactionJob(hash)!.tracking_generation;
  const first = store.replacementChunk(hash, generation, 10)!;
  assert.equal(JSON.parse(first.crate_ids_json).length, 15);
  store.replacementRanges(hash, [{ fromBlock: 101, toBlock: 200 }], 700, generation, first.chunk_index);
  const restored = reopen();
  const second = restored.replacementChunk(hash, generation, 20)!;
  assert.equal(second.chunk_index, 1);
  assert.equal(second.from_block, 100);
  assert.equal(second.ranges_json, '[]');
  assert.equal(restored.completeReplacementChunk(hash, second, new Set(crates.slice(15, 30))), true);
  assert.equal(restored.replacementChunk(hash, generation, 30)!.chunk_index, 2);
  const resumed = restored.replacementChunk(hash, generation, 40)!;
  assert.equal(resumed.chunk_index, 0);
  assert.equal(resumed.from_block, 700);
  assert.deepEqual(JSON.parse(resumed.ranges_json), [{ fromBlock: 101, toBlock: 200 }]);
  restored.freeze(deployment, observation(1), [{ crateTokenId: crateId(0), tokenIds: ids(1) }], 50, false);
  restored.replacementRanges(hash, [], 900, generation, first.chunk_index);
  assert.equal(restored.completeReplacementChunk(hash, first, new Set(crates.slice(0, 15))), false);
  assert.equal(restored.retireReplacedTransaction(hash, generation), false);
  const fresh = restored.replacementChunk(hash, restored.transactionJob(hash)!.tracking_generation, 60)!;
  assert.equal(fresh.from_block, 700);
  assert.equal(fresh.completed, 0);
});

test('old-schema repair restores associated scope and wakes dormant jobs once without changing frozen bytes', t => {
  const { database, store, rows, reopen } = fixture(t);
  const hash = observation(1).transactionHash;
  store.freeze(deployment, observation(1), [{ crateTokenId: crateId(0), tokenIds: ids(1) },
    { crateTokenId: crateId(1), tokenIds: ids(21) }], 1);
  store.reserve([crateId(3)]);
  store.rememberReplacementCandidates(hash, [{ transactionHash: observation(2).transactionHash, crateTokenIds: [crateId(2)] }]);
  database.prepare('UPDATE transactions SET crates_json=?,tokens_json=?,dormant=1,next_check_ms=900000 WHERE hash=?')
    .run(JSON.stringify([crateId(0)]), JSON.stringify(ids(1).map(tokenId => ({ tokenId, crateTokenId: crateId(0) }))), hash);
  const assignments = rows('SELECT * FROM assignments ORDER BY category,asset_id');
  const publication = rows('SELECT * FROM publication ORDER BY token_id');
  database.exec(`DROP TABLE replacement_chunks;
    ALTER TABLE transactions DROP COLUMN tracking_generation;
    ALTER TABLE transactions DROP COLUMN receipt_seen;
    ALTER TABLE transactions DROP COLUMN failure_json;
    DELETE FROM reveal_migrations WHERE name='tracking-scope-v2'`);
  const upgraded = reopen();
  assert.deepEqual(JSON.parse(upgraded.transactionJob(hash)!.crates_json), [crateId(0), crateId(1), crateId(2)]);
  assert.equal(upgraded.transactionJob(hash)!.dormant, 0);
  assert.equal(upgraded.transactionJob(hash)!.receipt_seen, 1);
  assert.equal(upgraded.transactionJob(hash)!.next_check_ms, 0);
  assert.deepEqual(rows('SELECT * FROM assignments ORDER BY category,asset_id'), assignments);
  assert.deepEqual(rows('SELECT * FROM publication ORDER BY token_id'), publication);
  database.prepare('UPDATE transactions SET dormant=1,next_check_ms=1234 WHERE hash=?').run(hash);
  const generation = upgraded.transactionJob(hash)!.tracking_generation;
  const again = reopen();
  assert.equal(again.transactionJob(hash)!.dormant, 1);
  assert.equal(again.transactionJob(hash)!.next_check_ms, 1234);
  assert.equal(again.transactionJob(hash)!.tracking_generation, generation);
});

for (const status of ['reverted', 'not_unpack'] as const) test(`recent ${status} receipts remain recoverable until a stable canonical failure`, t => {
  const { store } = fixture(t);
  const hash = observation(1).transactionHash;
  let now = Date.now();
  store.registerTransaction(hash, 100);
  store.finishTransaction(hash, status, now, { observation: observation(1), confirmations: 1 });
  assert.equal(store.transactionJob(hash)!.dormant, 0);
  assert.equal(store.transactionJob(hash)!.receipt_seen, 1);
  assert.equal(JSON.parse(store.transactionJob(hash)!.failure_json!).confirmations, 1);
  now += 2 * 86_400_000;
  store.retryTransaction(hash, now);
  assert.equal(store.transactionJob(hash)!.dormant, 0);
  store.pendingTransaction(hash, undefined, undefined, now);
  assert.equal(store.transactionJob(hash)!.status, 'pending');
  assert.equal(store.transactionJob(hash)!.dormant, 0);
  store.finishTransaction(hash, status, now, { observation: observation(1, 102), confirmations: 64 });
  assert.equal(store.transactionJob(hash)!.dormant, 1);
  const incompatible = observation(2).transactionHash;
  store.registerTransaction(incompatible, 100);
  store.finishTransaction(incompatible, 'not_unpack', now);
  assert.equal(store.transactionJob(incompatible)!.dormant, 1);
});

test('scheduler indexes match numeric publication order and exclude dormant transaction history', t => {
  const { database, store, queries } = fixture(t);
  store.freeze(deployment, observation(1), [{ crateTokenId: crateId(0), tokenIds: ids(1) }], 1);
  for (const index of [2, 3, 4]) store.registerTransaction(observation(index).transactionHash, 100);
  database.exec('UPDATE transactions SET next_check_ms=1,lease_until_ms=0');
  database.prepare('UPDATE transactions SET dormant=1 WHERE hash=?').run(observation(2).transactionHash);
  database.prepare('UPDATE transactions SET lease_until_ms=1000 WHERE hash=?').run(observation(3).transactionHash);
  assert.deepEqual(store.claimPublications(100, 8).map(job => job.token_id), ids(1, 8));
  assert.deepEqual(store.dueTransactions(100).map(job => job.hash), [observation(1).transactionHash, observation(4).transactionHash]);
  assert.equal(store.nextWake(100), 350);
  const plans = [
    { prefix: 'SELECT p.token_id', parameters: [100, 8], index: 'publication_due_numeric' },
    { prefix: 'SELECT * FROM transactions WHERE next_check_ms', parameters: [100, 100, 8], index: 'transactions_active_due' },
    { prefix: 'SELECT MIN(due)', parameters: [], index: 'transactions_active_due' },
  ];
  for (const { prefix, parameters, index } of plans) {
    const query = queries().find(value => value.startsWith(prefix));
    assert.ok(query);
    const details = database.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...parameters).map(row => String(row.detail)).join('\n');
    assert.ok(details.includes(index), details);
    assert.doesNotMatch(details, /TEMP B-TREE/);
  }
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

test('token recovery jobs coalesce requests and retain unminted results without exposing assignments', t => {
  const { store } = fixture(t);
  store.requestRecovery(['1', '2', '3'], 100, 1);
  store.requestRecovery(['1', '2'], 100, 2);
  const jobs = store.dueRecovery(3);
  assert.equal(jobs.length, 1);
  assert.deepEqual(JSON.parse(jobs[0].token_ids_json), ['1', '2', '3']);
  assert.equal(store.knownTokens(['1', '2'], 3), true);
  const claimed = store.claimRecovery(jobs[0].id, 3)!;
  assert.equal(claimed.attempts, 1);
  assert.equal(store.claimRecovery(jobs[0].id, 3), null);
  store.updateRecovery(jobs[0].id, [], [], ['1', '2', '3'], 4);
  assert.equal(store.dueRecovery(100).length, 0);
  assert.equal(store.tokenStatus('1'), 'unminted');
  assert.equal(store.knownTokens(['1'], 100), true);
  assert.equal(store.knownTokens(['1'], 3000), false);
  assert.deepEqual(store.frozen(['1']), []);
  store.requestRecovery(['1'], 100, 3000);
  assert.equal(store.tokenStatus('1'), 'recovering');
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

test('transaction claims have exclusive leases and active clients cannot bypass their polling interval', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store } = fixture(t);
  const hash = observation(1).transactionHash;
  store.registerTransaction(hash, 100);
  const first = store.claimTransaction(hash, now)!;
  assert.equal(first.attempts, 1);
  assert.equal(first.lease_until_ms, now + 30_000);
  assert.equal(store.claimTransaction(hash, now), null);
  now += 1_000;
  store.registerTransaction(hash, 100);
  assert.equal(store.claimTransaction(hash, now), null);
  assert.equal(store.dueTransactions(now).length, 0);
  store.pendingTransaction(hash, [crateId(0)], 101, now);
  assert.equal(store.transactionJob(hash)?.lease_until_ms, 0);
  now += 500;
  store.registerTransaction(hash, 100);
  assert.equal(store.claimTransaction(hash, now), null);
  now += 500;
  store.registerTransaction(hash, 100);
  assert.equal(store.claimTransaction(hash, now)?.attempts, 2);
  now += 30_000;
  assert.equal(store.claimTransaction(hash, now)?.attempts, 3);
});

test('abandoned unknown hashes back off and expire before another client resumes them', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store } = fixture(t);
  const hash = observation(1).transactionHash;
  store.registerTransaction(hash, 100);
  now += 30_000;
  store.claimTransaction(hash, now);
  store.pendingTransaction(hash, undefined, undefined, now);
  assert.equal(store.transactionJob(hash)?.next_check_ms, now + 4_000);
  now += 4_000;
  store.claimTransaction(hash, now);
  store.pendingTransaction(hash, undefined, undefined, now);
  assert.equal(store.transactionJob(hash)?.next_check_ms, now + 8_000);
  now += 86_400_000;
  store.claimTransaction(hash, now);
  store.pendingTransaction(hash, undefined, undefined, now);
  assert.equal(store.transactionJob(hash)?.dormant, 1);
  store.cleanupTransactions(now);
  assert.equal(store.transactionJob(hash), undefined);
  assert.equal(store.nextWake(now), null);
  assert.deepEqual(store.dueTransactions(now + 86_400_000), []);
  store.registerTransaction(hash, 100);
  assert.equal(store.transactionJob(hash)?.dormant, 0);
  assert.equal(store.transactionJob(hash)?.last_requested_at_ms, now);
  assert.ok(store.claimTransaction(hash, now));
  store.pendingTransaction(hash, undefined, undefined, now);
  assert.equal(store.transactionJob(hash)?.next_check_ms, now + 2_000);
});

test('known crate jobs keep reservations and continue bounded recovery after the client leaves', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store } = fixture(t);
  const hash = observation(1).transactionHash;
  store.registerTransaction(hash, 100);
  store.claimTransaction(hash, now);
  store.pendingTransaction(hash, [crateId(0)], 101, now);
  now += 86_400_000;
  store.claimTransaction(hash, now);
  store.pendingTransaction(hash, undefined, undefined, now);
  assert.equal(store.transactionJob(hash)?.dormant, 0);
  assert.equal(store.transactionJob(hash)?.next_check_ms, now + 60_000);
  assert.equal(store.summary().reserved, 20);
  store.finishTransaction(hash, 'reverted', now);
  assert.equal(store.transactionJob(hash)?.dormant, 0);
  assert.equal(store.transactionJob(hash)?.lease_until_ms, 0);
  assert.equal(store.transactionJob(hash)?.next_check_ms, now + 15_000);
});


test('stable reverted hashes go dormant and RPC failures cannot keep old unknown hashes runnable forever', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store } = fixture(t);
  const reverted = observation(1).transactionHash;
  store.registerTransaction(reverted, 100);
  store.claimTransaction(reverted, now);
  store.finishTransaction(reverted, 'reverted', now, { observation: observation(1), confirmations: 64 });
  assert.equal(store.transactionJob(reverted)?.dormant, 1);
  assert.equal(store.transactionJob(reverted)?.lease_until_ms, 0);
  assert.deepEqual(store.dueTransactions(now + 86_400_000), []);
  store.registerTransaction(reverted, 100);
  assert.ok(store.claimTransaction(reverted, now));
  store.finishTransaction(reverted, 'reverted', now, { observation: observation(1), confirmations: 64 });
  const unavailable = observation(2).transactionHash;
  store.registerTransaction(unavailable, 100);
  store.claimTransaction(unavailable, now);
  store.retryTransaction(unavailable, now);
  assert.equal(store.transactionJob(unavailable)?.next_check_ms, now + 2_000);
  now += 30_000;
  store.claimTransaction(unavailable, now);
  store.retryTransaction(unavailable, now);
  assert.equal(store.transactionJob(unavailable)?.next_check_ms, now + 8_000);
  now += 86_400_000;
  store.claimTransaction(unavailable, now);
  store.retryTransaction(unavailable, now);
  assert.equal(store.transactionJob(unavailable)?.dormant, 1);
  store.cleanupTransactions(now);
  assert.equal(store.nextWake(now), null);
  store.registerTransaction(unavailable, 100);
  assert.ok(store.claimTransaction(unavailable, now));
  store.retryTransaction(unavailable, now);
  assert.equal(store.transactionJob(unavailable)?.next_check_ms, now + 2_000);
});

test('unproven admission has a fixed lifetime and finite capacity across polling and reopening', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store, reopen } = fixture(t, () => 0, false);
  for (let index = 1; index <= REVEAL_TRANSIENT_TRANSACTION_LIMIT; index++) {
    assert.equal(store.registerTransaction(observation(index).transactionHash, 100), true);
  }
  const hash = observation(1).transactionHash;
  const first = store.transactionJob(hash)!;
  assert.equal(first.admission_expires_at_ms, now + REVEAL_TRANSIENT_TRANSACTION_TTL_MS);
  assert.equal(store.registerTransaction(observation(20_000).transactionHash, 100), false);
  now += REVEAL_TRANSIENT_TRANSACTION_TTL_MS - 1;
  assert.equal(store.registerTransaction(hash, 100), true);
  assert.equal(store.transactionJob(hash)!.incarnation, first.incarnation);
  assert.equal(store.transactionJob(hash)!.admission_expires_at_ms, first.admission_expires_at_ms);
  const restored = reopen();
  assert.equal(restored.transientTransactionCount(), REVEAL_TRANSIENT_TRANSACTION_LIMIT);
  now += 2;
  restored.cleanupTransactions(now);
  assert.equal(restored.transientTransactionCount(), REVEAL_TRANSIENT_TRANSACTION_LIMIT - 128);
  assert.equal(restored.transactionJob(hash), undefined);
  assert.equal(restored.registerTransaction(hash, 100), true);
  assert.notEqual(restored.transactionJob(hash)!.incarnation, first.incarnation);
  assert.equal(restored.transientTransactionCount(), REVEAL_TRANSIENT_TRANSACTION_LIMIT - 127);
});

test('recent receipt failures count toward admission capacity until fresh stable evidence allows expiry', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store, database } = fixture(t, () => 0, false);
  const hashes = [1, 2, 3, 4].map(value => observation(value).transactionHash);
  hashes.forEach(hash => store.registerTransaction(hash, 100));
  store.finishTransaction(hashes[0], 'reverted', now, { observation: observation(1), confirmations: 1 });
  store.finishTransaction(hashes[1], 'not_unpack', now, { observation: observation(2), confirmations: 64 });
  store.finishTransaction(hashes[2], 'not_unpack', now);
  database.prepare("UPDATE transactions SET receipt_seen=1,status='not_unpack',failure_json='{}',observation_json='{}' WHERE hash=?").run(hashes[3]);
  now += REVEAL_TRANSIENT_TRANSACTION_TTL_MS + 1;
  store.cleanupTransactions(now);
  assert.equal(store.transientTransactionCount(), 1);
  assert.equal(store.transactionJob(hashes[0])!.transient, 1);
  hashes.slice(1).forEach(hash => assert.equal(store.transactionJob(hash), undefined));
  store.pendingTransaction(hashes[0], undefined, undefined, now);
  now += 60_000;
  store.cleanupTransactions(now);
  assert.ok(store.claimTransaction(hashes[0], now));
  store.finishTransaction(hashes[0], 'not_unpack', now, { observation: observation(1, 102), confirmations: 64 });
  now += 60_000;
  store.cleanupTransactions(now);
  assert.equal(store.transientTransactionCount(), 0);
  assert.equal(store.transactionJob(hashes[0]), undefined);
  assert.equal(store.nextWake(now), null);
});

test('expiry respects an active claim without allowing polling to renew claims beyond the original deadline', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store } = fixture(t, () => 0, false);
  const hash = observation(1).transactionHash;
  store.registerTransaction(hash, 100);
  now += REVEAL_TRANSIENT_TRANSACTION_TTL_MS - 1;
  const claim = store.claimTransaction(hash, now)!;
  now += 2;
  store.cleanupTransactions(now);
  assert.equal(store.transactionJob(hash)!.admission_expires_at_ms, claim.lease_until_ms);
  now = claim.lease_until_ms;
  assert.equal(store.registerTransaction(hash, 100), true);
  assert.equal(store.claimTransaction(hash, now), null);
  store.cleanupTransactions(now);
  assert.equal(store.transactionJob(hash), undefined);
  assert.equal(store.transientTransactionCount(), 0);
});

test('existing over-cap ledgers drain in bounded indexed batches and reject new unproven admissions until below capacity', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store, database, reopen } = fixture(t, () => 0, false);
  database.prepare(`WITH RECURSIVE ids(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM ids WHERE id<?)
    INSERT INTO transactions(hash,from_block,created_at_ms,last_requested_at_ms,status,receipt_seen)
    SELECT printf('0x%064x',id),100,?,?,'not_unpack',1 FROM ids`).run(REVEAL_TRANSIENT_TRANSACTION_LIMIT + 256, now, now);
  const restored = reopen();
  assert.equal(restored.transientTransactionCount(), REVEAL_TRANSIENT_TRANSACTION_LIMIT + 256);
  now += REVEAL_TRANSIENT_TRANSACTION_TTL_MS + 1;
  for (const remaining of [REVEAL_TRANSIENT_TRANSACTION_LIMIT + 128, REVEAL_TRANSIENT_TRANSACTION_LIMIT]) {
    restored.cleanupTransactions(now);
    assert.equal(restored.transientTransactionCount(), remaining);
    assert.equal(restored.registerTransaction(observation(20_000).transactionHash, 100), false);
  }
  restored.cleanupTransactions(now);
  assert.equal(restored.transientTransactionCount(), REVEAL_TRANSIENT_TRANSACTION_LIMIT - 128);
  assert.equal(restored.registerTransaction(observation(20_000).transactionHash, 100), true);
  const plan = database.prepare(`EXPLAIN QUERY PLAN SELECT * FROM transactions WHERE transient=1 AND admission_expires_at_ms<=?
    ORDER BY admission_expires_at_ms,hash LIMIT 128`).all(now).map(row => String(row.detail)).join('\n');
  assert.match(plan, /transient_transactions_expiry/);
  assert.doesNotMatch(plan, /TEMP B-TREE|SCAN transactions/);
  assert.equal(store.transientTransactionCount(), restored.transientTransactionCount());
});

test('legacy classification preserves admitted crates, frozen metadata and both sides of replacement tracking', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store, database, rows, reopen } = fixture(t);
  const hashes = [1, 2, 3, 4, 5].map(value => observation(value).transactionHash);
  store.freeze(deployment, observation(1), [{ crateTokenId: crateId(0), tokenIds: ids(1) }], now);
  store.registerTransaction(hashes[1], 100);
  store.pendingTransaction(hashes[1], [crateId(1)], 100, now);
  store.registerTransaction(hashes[2], 100);
  store.registerTransaction(hashes[3], 100);
  store.rememberReplacementCandidates(hashes[2], [{ transactionHash: hashes[3], crateTokenIds: [crateId(2)] }]);
  store.registerTransaction(hashes[4], 100);
  database.prepare("UPDATE transactions SET crates_json='[]',tokens_json='[]',observation_json=NULL WHERE hash=?").run(hashes[0]);
  database.exec('UPDATE transactions SET transient=1,admission_expires_at_ms=0');
  const frozen = rows('SELECT * FROM assignments ORDER BY category,asset_id');
  const publication = rows('SELECT * FROM publication ORDER BY token_id');
  now += REVEAL_TRANSIENT_TRANSACTION_TTL_MS + 1;
  const restored = reopen();
  restored.cleanupTransactions(now);
  hashes.slice(0, 4).forEach(hash => assert.equal(restored.transactionJob(hash)!.transient, 0));
  assert.equal(restored.transactionJob(hashes[4]), undefined);
  assert.equal(restored.transientTransactionCount(), 0);
  assert.deepEqual(rows('SELECT * FROM assignments ORDER BY category,asset_id'), frozen);
  assert.deepEqual(rows('SELECT * FROM publication ORDER BY token_id'), publication);
});

test('the old transaction schema gains bounded admission accounting without rewriting frozen data', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { store, database, rows, reopen } = fixture(t);
  const frozenHash = observation(1).transactionHash;
  const unknownHash = observation(2).transactionHash;
  store.freeze(deployment, observation(1), [{ crateTokenId: crateId(0), tokenIds: ids(1) }], now);
  store.registerTransaction(unknownHash, 100);
  const frozen = rows('SELECT * FROM assignments ORDER BY category,asset_id');
  database.exec(`DROP TRIGGER transient_transaction_insert;
    DROP TRIGGER transient_transaction_delete;
    DROP TRIGGER transient_transaction_update;
    DROP INDEX transient_transactions_expiry;
    DROP TABLE transaction_admission_count;
    ALTER TABLE transactions DROP COLUMN incarnation;
    ALTER TABLE transactions DROP COLUMN transient;
    ALTER TABLE transactions DROP COLUMN admission_expires_at_ms;`);
  const upgraded = reopen();
  assert.equal(upgraded.transientTransactionCount(), 2);
  assert.equal(upgraded.transactionJob(unknownHash)!.incarnation, '');
  assert.equal(upgraded.transactionJob(frozenHash)!.transient, 1);
  now += REVEAL_TRANSIENT_TRANSACTION_TTL_MS + 1;
  upgraded.cleanupTransactions(now);
  assert.equal(upgraded.transactionJob(unknownHash), undefined);
  assert.equal(upgraded.transactionJob(frozenHash)!.transient, 0);
  assert.equal(upgraded.transientTransactionCount(), 0);
  assert.deepEqual(rows('SELECT * FROM assignments ORDER BY category,asset_id'), frozen);
  assert.equal(upgraded.registerTransaction(unknownHash, 100), true);
  assert.notEqual(upgraded.transactionJob(unknownHash)!.incarnation, '');
  assert.equal(reopen().transientTransactionCount(), 1);
});
