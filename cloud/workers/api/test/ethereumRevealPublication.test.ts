import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.ts';
import { EthereumRevealStore, type RevealPublicationResult, type RevealSql } from '../src/ethereumRevealStore.ts';

const deployment: EthereumRevealDeployment = {
  deploymentId: 'publication-test', dropId: '111k_devnet', chainId: 11155111,
  contractAddress: `0x${'ab'.repeat(20)}`, metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/publication-test/',
  deploymentBlock: 100, catalogVersion: '111k-v1',
  templateJson: JSON.stringify({ name: '{{tokenId}}', description: '',
    image: 'https://wip.lil.org/111k/artwork_placeholder.png', attributes: [] }),
  templateSha256: '0'.repeat(64), state: 'active', revision: 3, createdAtMs: 1, updatedAtMs: 3,
  provisionedAtMs: 2, activatedAtMs: 3, lastError: null,
};
const NOW = 1_000_000;

function fixture(t: TestContext) {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys=ON');
  const sql: RevealSql = { exec(query, ...bindings) {
    const statement = database.prepare(query);
    const parameters = bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    const result = statement.columns().length ? statement.all(...parameters) : (statement.run(...parameters), []);
    return { toArray: () => result as never[] };
  } };
  const transaction = <T>(action: () => T): T => {
    database.exec('BEGIN');
    try { const result = action(); database.exec('COMMIT'); return result; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  };
  const reopen = () => new EthereumRevealStore(sql, transaction, () => 0);
  const store = reopen();
  store.configure(deployment);
  while (!store.initializeChunk()) {}
  store.freeze(deployment, { transactionHash: `0x${'01'.repeat(32)}`, blockHash: `0x${'02'.repeat(32)}`, blockNumber: 101 },
    [{ crateTokenId: '111112', tokenIds: Array.from({ length: 20 }, (_, index) => String(index + 1)) }], NOW);
  t.after(() => database.close());
  const row = (id: string) => database.prepare('SELECT * FROM publication WHERE token_id=?').get(id);
  const assignments = () => database.prepare('SELECT * FROM assignments ORDER BY token_id').all();
  return { database, store, row, assignments, reopen };
}

test('publication outcomes commit together with existing retry and conflict semantics without changing frozen bytes', t => {
  const { store, row, assignments } = fixture(t);
  const before = assignments();
  const jobs = store.claimPublications(NOW, 3);
  const outcomes: RevealPublicationResult[] = [
    { job: jobs[0], status: 'published' }, { job: jobs[1], status: 'retry' }, { job: jobs[2], status: 'conflict' },
  ];
  assert.deepEqual(store.completePublications(outcomes, NOW + 10), outcomes);
  assert.equal(row('1')?.status, 'published');
  assert.equal(row('1')?.last_error, null);
  assert.equal(row('2')?.status, 'pending');
  assert.equal(row('2')?.last_error, 'publication-unavailable');
  assert.equal(row('2')?.next_check_ms, NOW + 2_010);
  assert.equal(row('3')?.status, 'conflict');
  assert.equal(row('3')?.last_error, 'metadata-conflict');
  assert.deepEqual(assignments(), before);
});

for (const newer of ['published', 'conflict', 'retry'] as const) {
  test(`expired publication outcomes cannot overwrite a newer ${newer} result`, t => {
    const { store, row, assignments } = fixture(t);
    const before = assignments();
    const jobs = store.claimPublications(NOW, 20);
    const original = jobs[0];
    store.completePublications(jobs.slice(1).map(job => ({ job, status: 'published' })), NOW);
    const current = store.claimPublications(NOW + 60_000, 1)[0];
    assert.equal(current.token_id, original.token_id);
    assert.equal(current.attempts, original.attempts + 1);
    const outcome = { job: current, status: newer };
    assert.deepEqual(store.completePublications([outcome], NOW + 60_010), [outcome]);
    const published = row(original.token_id);
    for (const status of ['published', 'conflict', 'retry'] as const) {
      assert.deepEqual(store.completePublications([{ job: original, status }], NOW + 60_020), []);
      assert.deepEqual(row(original.token_id), published);
    }
    assert.deepEqual(assignments(), before);
  });
}

test('stale publication results do not release a newer in-flight attempt or produce applied conflict reports', t => {
  const { store, row } = fixture(t);
  const jobs = store.claimPublications(NOW, 20);
  store.completePublications(jobs.slice(2).map(job => ({ job, status: 'published' })), NOW);
  const current = store.claimPublications(NOW + 60_000, 2);
  const pending = row('1');
  const success = { job: current[1], status: 'published' as const };
  assert.deepEqual(store.completePublications([{ job: jobs[0], status: 'conflict' }, success], NOW + 60_010), [success]);
  assert.deepEqual(row('1'), pending);
  const outcome = { job: current[0], status: 'published' as const };
  assert.deepEqual(store.completePublications([outcome], NOW + 60_020), [outcome]);
  assert.equal(row('1')?.status, 'published');
  assert.deepEqual(store.completePublications([{ job: current[0], status: 'retry' }], NOW + 60_030), []);
  assert.equal(row('1')?.status, 'published');
});

test('a failed outcome batch rolls back every ledger update and remains safely replayable', t => {
  const { database, store, row, assignments } = fixture(t);
  const before = assignments();
  const jobs = store.claimPublications(NOW, 2);
  const first = row('1');
  const second = row('2');
  const outcomes: RevealPublicationResult[] = jobs.map(job => ({ job, status: 'published' }));
  database.exec(`CREATE TRIGGER fail_publication_test BEFORE UPDATE ON publication WHEN NEW.token_id='2'
    BEGIN SELECT RAISE(ABORT,'publication write failed'); END`);
  assert.throws(() => store.completePublications(outcomes, NOW + 10), /publication write failed/);
  assert.deepEqual(row('1'), first);
  assert.deepEqual(row('2'), second);
  database.exec('DROP TRIGGER fail_publication_test');
  assert.deepEqual(store.completePublications(outcomes, NOW + 20), outcomes);
  assert.equal(row('1')?.status, 'published');
  assert.equal(row('2')?.status, 'published');
  assert.deepEqual(assignments(), before);
});

test('undispatched publication claims become immediately eligible without increasing retry attempts or clearing prior errors', t => {
  const { store, row, assignments } = fixture(t);
  const before = assignments();
  const initial = store.claimPublications(NOW, 20);
  store.completePublications(initial.map((job, index) => ({ job, status: index ? 'published' : 'retry' })), NOW + 1);
  const deferred = store.claimPublications(NOW + 2_001, 1)[0];
  assert.equal(deferred.attempts, 1);
  assert.ok(deferred.claim_id);
  assert.equal(row('1')?.attempts, 2);
  store.releasePublicationClaims([deferred], NOW + 2_002);
  assert.equal(row('1')?.attempts, 1);
  assert.equal(row('1')?.next_check_ms, NOW + 2_002);
  assert.equal(row('1')?.last_error, 'publication-unavailable');
  assert.equal(row('1')?.claim_id, null);
  const next = store.claimPublications(NOW + 2_002, 1)[0];
  assert.equal(next.token_id, deferred.token_id);
  assert.equal(next.attempts, deferred.attempts);
  assert.ok(next.claim_id);
  assert.notEqual(next.claim_id, deferred.claim_id);
  assert.deepEqual(assignments(), before);
});

for (const terminal of ['published', 'conflict'] as const) {
  test(`a released publication claim cannot rewind a replacement with the same attempt number or its later ${terminal} state`, t => {
    const { store, row, assignments } = fixture(t);
    const before = assignments();
    const initial = store.claimPublications(NOW, 20);
    store.completePublications(initial.slice(1).map(job => ({ job, status: 'published' })), NOW);
    const stale = initial[0];
    store.releasePublicationClaims([stale], NOW + 1);
    const current = store.claimPublications(NOW + 1, 1)[0];
    assert.equal(current.attempts, stale.attempts);
    assert.notEqual(current.claim_id, stale.claim_id);
    const pending = row('1');
    for (const old of [stale, { ...stale, claim_id: undefined }]) {
      store.releasePublicationClaims([old], NOW + 2);
      assert.deepEqual(row('1'), pending);
      for (const status of ['published', 'conflict', 'retry'] as const) {
        assert.deepEqual(store.completePublications([{ job: old, status }], NOW + 3), []);
        assert.deepEqual(row('1'), pending);
      }
    }
    const outcome = { job: current, status: terminal };
    assert.deepEqual(store.completePublications([outcome], NOW + 4), [outcome]);
    const settled = row('1');
    store.releasePublicationClaims([stale, current], NOW + 5);
    assert.deepEqual(row('1'), settled);
    assert.deepEqual(assignments(), before);
  });
}

test('releasing an undispatched window is atomic and does not change frozen metadata', t => {
  const { database, store, row, assignments } = fixture(t);
  const before = assignments();
  const jobs = store.claimPublications(NOW, 2);
  const first = row('1');
  const second = row('2');
  database.exec(`CREATE TRIGGER fail_publication_release BEFORE UPDATE ON publication WHEN NEW.token_id='2'
    BEGIN SELECT RAISE(ABORT,'publication release failed'); END`);
  assert.throws(() => store.releasePublicationClaims(jobs, NOW + 1), /publication release failed/);
  assert.deepEqual(row('1'), first);
  assert.deepEqual(row('2'), second);
  database.exec('DROP TRIGGER fail_publication_release');
  store.releasePublicationClaims(jobs, NOW + 2);
  for (const id of ['1', '2']) {
    assert.equal(row(id)?.attempts, 0);
    assert.equal(row(id)?.next_check_ms, NOW + 2);
    assert.equal(row(id)?.claim_id, null);
  }
  assert.deepEqual(assignments(), before);
});

test('publication claim migration preserves legacy work while legacy results cannot modify newly claimed jobs', t => {
  const { database, store, row, assignments, reopen } = fixture(t);
  const before = assignments();
  const jobs = store.claimPublications(NOW, 20).map(job => ({ ...job, claim_id: undefined }));
  database.exec('ALTER TABLE publication DROP COLUMN claim_id');
  const restored = reopen();
  assert.equal(row('1')?.claim_id, null);
  const published = { job: jobs[0], status: 'published' as const };
  assert.deepEqual(restored.completePublications([published], NOW + 1), [published]);
  restored.releasePublicationClaims([jobs[1]], NOW + 1);
  const current = restored.claimPublications(NOW + 1, 1)[0];
  assert.equal(current.token_id, '2');
  assert.ok(current.claim_id);
  const pending = row('2');
  restored.releasePublicationClaims([jobs[1]], NOW + 2);
  assert.deepEqual(restored.completePublications([{ job: jobs[1], status: 'conflict' }], NOW + 2), []);
  assert.deepEqual(row('2'), pending);
  assert.deepEqual(assignments(), before);
});
