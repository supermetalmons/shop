import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createCommerceD1Harness, seedCommerceDocuments, type CommerceD1Harness } from '../cloud/workers/api/test/commerceD1Harness.ts';
import { commerceKeys, D1CommerceRepository } from '../cloud/workers/api/src/commerceRepository.ts';
import { ETHEREUM_111K_CONTROL_SQL, ethereum111kControlAllows, isEthereum111kFenceError, parseEthereum111kControl } from '../shared/ethereum/control.ts';
import { buildEthereum111kResetBatch, buildEthereum111kResetPlan, createEthereum111kMaintenanceRunner, ethereum111kResetOutcome, ethereum111kScope, readEthereum111kSnapshot,
  requireZeroEthereum111kHistory, type Ethereum111kQueryBatch, type Ethereum111kResetPlan } from '../scripts/shared/ethereum111kMaintenance.ts';
import { buildEthereum111kControlMutation, parseEthereum111kControlArgs, runEthereum111kControl } from '../scripts/ops/ethereum111kControl.ts';
import { parseResetEthereum111kArgs, runResetEthereum111k, writeEthereum111kResetBackup } from '../scripts/ops/resetEthereum111k.ts';

const SCOPE = { chainId: 11155111, contractAddress: '0x6acc38d2ab61a06882be5d964a69efefe23058b3' };
const NEXT = { ...SCOPE, contractAddress: `0x${'12'.repeat(20)}` };
const RESET = '00000000-0000-4000-8000-000000000041';
const ORDER = commerceKeys.deliveryOrder('111k_devnet', '42');
const OTHER = commerceKeys.deliveryOrder('mi-note', '43');

function query(harness: CommerceD1Harness) {
  return (sql: string) => harness.database.prepare(sql).all();
}

function queryBatch(harness: CommerceD1Harness): Ethereum111kQueryBatch {
  return queries => {
    harness.database.exec('BEGIN');
    try {
      const results = Object.fromEntries(Object.entries(queries).map(([key, sql]) => [key, harness.database.prepare(sql).all()]));
      harness.database.exec('COMMIT');
      return results;
    } catch (error) {
      harness.database.exec('ROLLBACK');
      throw error;
    }
  };
}

function activate(harness: CommerceD1Harness, scope = SCOPE) {
  harness.database.prepare(`UPDATE ethereum_111k_control SET paused = 0, paused_at_ms = NULL,
    chain_id = ?, contract_address = ?, revision = revision + 1`).run(scope.chainId, scope.contractAddress);
}

function pause(harness: CommerceD1Harness) {
  harness.database.exec(`UPDATE ethereum_111k_control SET paused = 1, revision = revision + 1,
    paused_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 65000`);
}

function fixture(context: test.TestContext) {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  return harness;
}

function seed(harness: CommerceD1Harness) {
  activate(harness);
  harness.database.prepare(`INSERT INTO ethereum_delivery_quotes
    (chain_id, contract_address, order_id, request_id, wallet, address_id, address_json, token_ids_json,
      items_json, fee_wei, deadline, status, created_at_ms, updated_at_ms)
    VALUES (?, ?, 42, 'request', 'wallet', 'private-address', '{"address":"private"}', '[]', '[]', '0', 2000, 'prepared', 1000, 1000)`)
    .run(SCOPE.chainId, SCOPE.contractAddress);
  harness.database.prepare(`INSERT INTO ethereum_crate_claims
    (chain_id, contract_address, receipt_id, crate_id, order_id, code_hash, code, claim_id, status, updated_at_ms)
    VALUES (?, ?, '2000001', 1, 42, 'code-hash', 'private-code', 'claim-id', 'available', 1000)`)
    .run(SCOPE.chainId, SCOPE.contractAddress);
  harness.database.prepare('INSERT INTO ethereum_reconciliation_cursor (chain_id, contract_address, next_block) VALUES (?, ?, 123)')
    .run(SCOPE.chainId, SCOPE.contractAddress);
  seedCommerceDocuments(harness, [{ key: ORDER, data: { source: 'ethereum', ...SCOPE, owner: 'wallet', status: 'prepared' } },
    { key: OTHER, data: { source: 'solana', owner: 'other-wallet', status: 'prepared' } }]);
  pause(harness);
}

async function plan(harness: CommerceD1Harness) {
  const snapshot = await readEthereum111kSnapshot(queryBatch(harness), SCOPE);
  return buildEthereum111kResetPlan(snapshot, SCOPE, snapshot.control.revision, RESET);
}

function resetArgs(resetPlan: Ethereum111kResetPlan) {
  return ['--chain-id', String(SCOPE.chainId), '--old-contract', SCOPE.contractAddress, '--expected-revision', String(resetPlan.expectedRevision)];
}

test('control migration starts paused without a scope and parser fails closed for malformed or zero scopes', context => {
  const harness = fixture(context);
  const row = query(harness)(ETHEREUM_111K_CONTROL_SQL)[0];
  const control = parseEthereum111kControl(row);
  assert.equal(control.paused, true);
  assert.equal(control.revision, 1);
  assert.equal(control.chainId, null);
  assert.equal(control.contractAddress, null);
  assert.equal(ethereum111kControlAllows(control, SCOPE), false);
  for (const change of [{ paused: 0 }, { revision: 0 }, { paused_at_ms: null }, { chain_id: SCOPE.chainId },
    { chain_id: 1, contract_address: `0x${'0'.repeat(40)}` }, { chain_id: 1, contract_address: SCOPE.contractAddress.toUpperCase() }]) {
    assert.throws(() => parseEthereum111kControl({ ...row, ...change }), /Invalid Ethereum/);
  }
  assert.throws(() => ethereum111kScope(1, `0x${'0'.repeat(40)}`));
  assert.throws(() => harness.database.exec('DELETE FROM ethereum_111k_control'), /cannot be deleted/);
  activate(harness);
  assert.equal(ethereum111kControlAllows(parseEthereum111kControl(query(harness)(ETHEREUM_111K_CONTROL_SQL)[0]), SCOPE), true);
  assert.equal(isEthereum111kFenceError(new Error('D1_ERROR', { cause: new Error('ethereum 111k is paused or scope is unavailable') })), true);
});

test('native insert, update and delete fences require active scope or a matching paused reset guard', context => {
  const harness = fixture(context);
  seed(harness);
  const mutations = [
    `UPDATE ethereum_delivery_quotes SET deadline = deadline + 1`,
    `UPDATE ethereum_crate_claims SET code = 'new'`,
    `UPDATE ethereum_reconciliation_cursor SET next_block = next_block + 1`,
    `DELETE FROM ethereum_delivery_quotes`, `DELETE FROM ethereum_crate_claims`, `DELETE FROM ethereum_reconciliation_cursor`,
    `INSERT INTO ethereum_reconciliation_cursor (chain_id, contract_address, next_block) VALUES (1, '${NEXT.contractAddress}', 0)`,
  ];
  for (const sql of mutations) assert.throws(() => harness.database.exec(sql), /ethereum 111k is paused/);
  harness.database.exec(`UPDATE ethereum_111k_control SET reset_guard_id = 'missing'`);
  assert.throws(() => harness.database.exec('DELETE FROM ethereum_reconciliation_cursor'), /ethereum 111k is paused/);
  harness.database.exec(`INSERT INTO commerce_commit_guards (guard_id, expectations_json, expected_documents_revision, created_at_ms)
    VALUES ('wrong', '[]', NULL, 0)`);
  assert.throws(() => harness.database.exec('DELETE FROM ethereum_reconciliation_cursor'), /ethereum 111k is paused/);
  harness.database.exec(`UPDATE ethereum_111k_control SET reset_guard_id = 'wrong'`);
  assert.equal(harness.database.prepare('DELETE FROM ethereum_reconciliation_cursor').run().changes, 1);
  assert.throws(() => harness.database.exec('UPDATE ethereum_delivery_quotes SET deadline = 4'), /ethereum 111k is paused/);
});

test('document fences inspect old and new scope and reject late old writers after a new deployment resumes', async context => {
  const harness = fixture(context);
  seed(harness);
  for (const sql of [
    `UPDATE commerce_documents SET drop_id = 'other' WHERE document_path = '${ORDER.path}'`,
    `UPDATE commerce_documents SET drop_id = '111k_devnet' WHERE document_path = '${OTHER.path}'`,
  ]) assert.throws(() => harness.database.exec(sql), /ethereum 111k is paused/);
  const resetPlan = await plan(harness);
  await queryBatch(harness)(buildEthereum111kResetBatch(resetPlan));
  const control = parseEthereum111kControl(query(harness)(ETHEREUM_111K_CONTROL_SQL)[0]);
  harness.database.exec(buildEthereum111kControlMutation({ command: 'resume', write: true, expectedRevision: control.revision, scope: NEXT }, control));
  assert.throws(() => harness.database.prepare('INSERT INTO ethereum_reconciliation_cursor (chain_id, contract_address, next_block) VALUES (?, ?, 1)')
    .run(SCOPE.chainId, SCOPE.contractAddress), /ethereum 111k is paused/);
  assert.throws(() => seedCommerceDocuments(harness, [{ key: ORDER, data: { source: 'ethereum', ...SCOPE } }]), /ethereum 111k is paused/);
  harness.database.prepare('INSERT INTO ethereum_reconciliation_cursor (chain_id, contract_address, next_block) VALUES (?, ?, 1)')
    .run(NEXT.chainId, NEXT.contractAddress);
  assert.throws(() => harness.database.prepare('UPDATE ethereum_reconciliation_cursor SET contract_address = ?').run(SCOPE.contractAddress), /ethereum 111k is paused/);
});

test('reset atomically deletes only old-scope rows and recovery while keeping other drops and revision tombstones', async context => {
  const harness = fixture(context);
  seed(harness);
  const resetPlan = await plan(harness);
  const batch = buildEthereum111kResetBatch(resetPlan);
  assert.match(batch.guard, /NULL/);
  assert.doesNotMatch(batch.guard, /commerce_wipe_guards/);
  const repository = new D1CommerceRepository(harness.db);
  await repository.run(Date.now(), async unit => { await unit.update(OTHER, { status: 'processing' }); });
  const globalRevision = Number(query(harness)('SELECT documents_revision FROM commerce_authority_control')[0].documents_revision);
  const ownerBefore = query(harness)(`SELECT * FROM commerce_delivery_owner_revisions WHERE owner = 'other-wallet'`);
  const pathBefore = Number(query(harness)(`SELECT revision FROM commerce_document_path_revisions WHERE document_path = '${ORDER.path}'`)[0].revision);
  await queryBatch(harness)(batch);
  const after = await readEthereum111kSnapshot(queryBatch(harness), SCOPE);
  assert.equal(ethereum111kResetOutcome(resetPlan, after), 'completed');
  assert.equal((await repository.get(OTHER))!.data.status, 'processing');
  assert.deepEqual(query(harness)(`SELECT * FROM commerce_delivery_owner_revisions WHERE owner = 'other-wallet'`), ownerBefore);
  assert.equal(Number(query(harness)('SELECT documents_revision FROM commerce_authority_control')[0].documents_revision), globalRevision + 1);
  assert.equal(Number(query(harness)(`SELECT revision FROM commerce_document_path_revisions WHERE document_path = '${ORDER.path}'`)[0].revision), globalRevision + 1);
  assert.ok(globalRevision + 1 > pathBefore);
  assert.equal(query(harness)('SELECT * FROM commerce_commit_guards').length, 0);
  assert.equal(query(harness)('SELECT authority_state FROM commerce_authority_control')[0].authority_state, 'd1');
});

test('stale document, recovery, native, count, cursor and control expectations abort every mutation', async context => {
  const changes = [
    { drop: [], sql: `UPDATE commerce_document_path_revisions SET revision = revision + 1 WHERE document_path = '${ORDER.path}'` },
    { drop: ['commerce_documents_ethereum_111k_update', 'commerce_delivery_recovery_parent_update_guard'],
      sql: `UPDATE commerce_documents SET version = version + 1 WHERE document_path = '${ORDER.path}'` },
    { drop: ['commerce_delivery_recovery_update_guard'],
      sql: `UPDATE commerce_delivery_recovery SET revision = revision + 1 WHERE parent_path = '${ORDER.path}'` },
    { drop: ['ethereum_reconciliation_cursor_control_update'], sql: 'UPDATE ethereum_reconciliation_cursor SET next_block = next_block + 1' },
    { drop: ['ethereum_delivery_quotes_control_update'], sql: 'UPDATE ethereum_delivery_quotes SET verified_at_block = 55' },
    { drop: ['ethereum_crate_claims_control_update'], sql: "UPDATE ethereum_crate_claims SET code_hash = 'changed-hash'" },
    { drop: ['ethereum_reconciliation_cursor_control_delete'], sql: 'DELETE FROM ethereum_reconciliation_cursor' },
    { drop: [], sql: 'UPDATE ethereum_111k_control SET revision = revision + 1' },
  ];
  for (const change of changes) {
    const h = fixture(context);
    seed(h);
    const resetPlan = await plan(h);
    for (const trigger of change.drop) h.database.exec(`DROP TRIGGER ${trigger}`);
    h.database.exec(change.sql);
    const before = await readEthereum111kSnapshot(queryBatch(h), SCOPE);
    await assert.rejects(async () => queryBatch(h)(buildEthereum111kResetBatch(resetPlan)));
    const after = await readEthereum111kSnapshot(queryBatch(h), SCOPE);
    assert.deepEqual({ ...after, databaseNowMs: 0 }, { ...before, databaseNowMs: 0 });
    assert.equal(query(h)('SELECT * FROM commerce_commit_guards').length, 0);
  }
});

test('any failure after document deletion rolls back documents, recovery, native rows, and control claim', async context => {
  const h = fixture(context);
  seed(h);
  const resetPlan = await plan(h);
  const batch = buildEthereum111kResetBatch(resetPlan);
  batch.quotes = "SELECT json('forced failure after deletions')";
  await assert.rejects(async () => queryBatch(h)(batch), /malformed JSON/);
  assert.equal(ethereum111kResetOutcome(resetPlan, await readEthereum111kSnapshot(queryBatch(h), SCOPE)), 'unchanged');
  assert.equal(query(h)('SELECT * FROM commerce_commit_guards').length, 0);
});

test('operator commands default to dry-run, enforce revision and scope, and refuse populated scope replacement', async context => {
  const h = fixture(context);
  seed(h);
  assert.equal(parseEthereum111kControlArgs(['pause', '--chain-id', '1', '--contract', NEXT.contractAddress, '--expected-revision', '1']).write, false);
  assert.throws(() => parseEthereum111kControlArgs(['pause', '--write']), /expected-revision/);
  assert.throws(() => parseResetEthereum111kArgs(['--write']), /expected-revision/);
  const control = parseEthereum111kControl(query(h)(ETHEREUM_111K_CONTROL_SQL)[0]);
  const args = ['resume', '--chain-id', String(SCOPE.chainId), '--contract', SCOPE.contractAddress, '--expected-revision', String(control.revision)];
  const dry = await runEthereum111kControl(args, { query: query(h) });
  assert.equal('dryRun' in dry && dry.dryRun, true);
  assert.deepEqual(parseEthereum111kControl(query(h)(ETHEREUM_111K_CONTROL_SQL)[0]), control);
  await assert.rejects(runEthereum111kControl(['resume', '--chain-id', String(NEXT.chainId), '--contract', NEXT.contractAddress,
    '--expected-revision', String(control.revision), '--write'], { query: query(h) }), /not confirmed/);
  await runEthereum111kControl([...args, '--write'], { query: query(h) });
  assert.equal(parseEthereum111kControl(query(h)(ETHEREUM_111K_CONTROL_SQL)[0]).paused, false);
});

test('reset preflight requires drain, no unsupported documents or durable side effects, and read-only external checks', async context => {
  const h = fixture(context);
  seed(h);
  const resetPlan = await plan(h);
  for (const key of ['notifications', 'pack_outbox', 'inventory', 'available_dudes']) {
    assert.throws(() => buildEthereum111kResetPlan({ ...resetPlan.snapshot, counts: { ...resetPlan.snapshot.counts, [key]: 1 } }, SCOPE, resetPlan.expectedRevision, RESET), /blocked/);
  }
  assert.throws(() => buildEthereum111kResetPlan({ ...resetPlan.snapshot, databaseNowMs: resetPlan.snapshot.control.pausedAtMs! + 64999 }, SCOPE, resetPlan.expectedRevision, RESET), /65 seconds/);
  assert.throws(() => buildEthereum111kResetPlan({ ...resetPlan.snapshot, documents: [{ ...resetPlan.snapshot.documents[0], document_kind: 'stripe_checkout' }] }, SCOPE, resetPlan.expectedRevision, RESET), /unsupported/);
  requireZeroEthereum111kHistory([{ events: 0, history: 0 }], 'DATA');
  assert.throws(() => requireZeroEthereum111kHistory([{ history: 1 }], 'DATA'), /blocked/);
  let reads = 0;
  const result = await runResetEthereum111k(resetArgs(resetPlan), { queryBatch: queryBatch(h), resetId: () => RESET,
    queryData: sql => { assert.match(sql, /^SELECT/); reads++; return [{ events: 0, history: 0 }]; },
    queryOps: sql => { assert.match(sql, /^SELECT/); reads++; return [{ reveals: 0 }]; },
    backup: () => assert.fail('dry-run must not write a backup'),
  });
  assert.equal(result.dryRun, true);
  assert.equal(reads, 2);
  assert.doesNotMatch(JSON.stringify(result), /private-address|private-code|document_json/);
  assert.equal(ethereum111kResetOutcome(resetPlan, await readEthereum111kSnapshot(queryBatch(h), SCOPE)), 'unchanged');
});

test('reset reconciles a lost response without a second mutation and backups precede writes', async context => {
  const h = fixture(context);
  seed(h);
  const resetPlan = await plan(h);
  let backedUp = false;
  let mutations = 0;
  const result = await runResetEthereum111k([...resetArgs(resetPlan), '--write'], {
    queryBatch: async queries => {
      if ('guard' in queries) { assert.equal(backedUp, true); mutations++; await queryBatch(h)(queries); throw new Error('lost response'); }
      return queryBatch(h)(queries);
    }, queryData: () => [{ events: 0, history: 0 }], queryOps: () => [{ reveals: 0 }], resetId: () => RESET,
    backup: () => { backedUp = true; return '/private/backup.json'; },
  });
  assert.equal(result.completed, true);
  assert.equal(result.reconciled, true);
  assert.equal(mutations, 1);
  const replay = await runResetEthereum111k([...resetArgs(resetPlan), '--write', '--reset-id', RESET], {
    queryBatch: queries => { assert.equal('guard' in queries, false); return queryBatch(h)(queries); },
    backup: () => assert.fail('completed retry must not create another backup'),
  });
  assert.equal(replay.completed, true);
  await assert.rejects(runResetEthereum111k(['--chain-id', String(NEXT.chainId), '--old-contract', NEXT.contractAddress,
    '--expected-revision', String(resetPlan.expectedRevision), '--reset-id', RESET], { queryBatch: queryBatch(h) }), /cannot be confirmed/);
});

test('reset keeps a private, exclusive backup outside all Git worktrees', async context => {
  const h = fixture(context);
  seed(h);
  const resetPlan = await plan(h);
  const directory = mkdtempSync(join(tmpdir(), 'ethereum111k-backup-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = writeEthereum111kResetBackup(resetPlan, directory);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), JSON.parse(JSON.stringify(resetPlan)));
  assert.throws(() => writeEthereum111kResetBackup(resetPlan, directory), /EEXIST/);
  assert.throws(() => writeEthereum111kResetBackup(resetPlan, resolve('.cache', 'backup')), /outside/);
  const linked = join(directory, 'repository');
  symlinkSync(resolve('.'), linked, 'dir');
  assert.throws(() => writeEthereum111kResetBackup(resetPlan, join(linked, '.cache', 'backup')), /outside/);
});


test('reset preserves shared profiles, addresses, auth sessions, and DATA pack-status baselines', async context => {
  const h = fixture(context);
  seed(h);
  const resetPlan = await plan(h);
  const ops = new DatabaseSync(':memory:');
  const data = new DatabaseSync(':memory:');
  context.after(() => { ops.close(); data.close(); });
  ops.exec(readFileSync('cloud/workers/api/ops-migrations/0001_current_schema.sql', 'utf8'));
  ops.exec(readFileSync('cloud/workers/api/ops-migrations/0008_ethereum_profiles.sql', 'utf8'));
  data.exec(readFileSync('cloud/workers/api/migrations/0001_current_schema.sql', 'utf8'));
  ops.prepare('INSERT INTO profiles (wallet, email, created_at_ms, updated_at_ms) VALUES (?, ?, 0, 0)')
    .run('A'.repeat(32), 'private@example.test');
  ops.prepare('INSERT INTO ethereum_profiles (wallet, email, created_at_ms, updated_at_ms) VALUES (?, ?, 0, 0)')
    .run(SCOPE.contractAddress, 'private@example.test');
  ops.prepare('INSERT INTO ethereum_profile_addresses (wallet, address_id, address_json, created_at_ms) VALUES (?, ?, ?, 0)')
    .run(SCOPE.contractAddress, 'A'.repeat(20), '{"street":"private"}');
  ops.prepare(`INSERT INTO ethereum_auth_sessions
    (session_id, challenge_id, secret_hash, wallet, chain_id, drop_id, origin, created_at_ms, expires_at_ms)
    VALUES ('session', 'challenge', 'private-hash', ?, ?, '111k_devnet', 'https://mons.shop', 0, 1000)`)
    .run(SCOPE.contractAddress, SCOPE.chainId);
  ops.prepare(`INSERT INTO anonymous_auth_sessions
    (session_id, secret_hash, auth_subject, origin_hostname, created_at_ms, refreshed_at_ms, expires_at_ms)
    VALUES (?, ?, ?, 'mons.shop', 0, 0, 1000)`).run(RESET, 'a'.repeat(64), `anon:${RESET}`);
  data.exec(`INSERT INTO pack_status (drop_id, version, total_initial_supply, total_cards, cards_per_pack, updated_at_ms)
    VALUES ('111k_devnet', 1, 5555, 11110, 2, 0), ('other', 1, 100, 200, 2, 0)`);
  const tables = ['profiles', 'ethereum_profiles', 'ethereum_profile_addresses', 'ethereum_auth_sessions', 'anonymous_auth_sessions'];
  const before = tables.map(table => ops.prepare(`SELECT * FROM ${table}`).all());
  const status = data.prepare('SELECT * FROM pack_status').all();
  await runResetEthereum111k([...resetArgs(resetPlan), '--write'], { queryBatch: queryBatch(h), resetId: () => RESET,
    queryData: sql => { assert.match(sql, /^SELECT/); return data.prepare(sql).all(); },
    queryOps: sql => { assert.match(sql, /^SELECT/); return ops.prepare(sql).all(); },
    backup: () => '/private/backup.json',
  });
  assert.deepEqual(tables.map(table => ops.prepare(`SELECT * FROM ${table}`).all()), before);
  assert.deepEqual(data.prepare('SELECT * FROM pack_status').all(), status);
});

test('reset failures reconcile unchanged or unknown outcomes without automatic retry', async context => {
  for (const unknown of [false, true]) {
    const h = fixture(context);
    seed(h);
    const resetPlan = await plan(h);
    let mutations = 0;
    await assert.rejects(runResetEthereum111k([...resetArgs(resetPlan), '--write'], {
      queryBatch: queries => {
        if ('guard' in queries) {
          mutations++;
          if (unknown) h.database.exec('UPDATE ethereum_111k_control SET revision = revision + 1');
          throw new Error('network error');
        }
        return queryBatch(h)(queries);
      }, queryData: () => [{ events: 0, history: 0 }], queryOps: () => [{ reveals: 0 }], resetId: () => RESET,
      backup: () => '/private/backup.json',
    }), unknown ? /outcome is unknown/ : /was not applied/);
    assert.equal(mutations, 1);
    assert.equal(query(h)("SELECT * FROM commerce_documents WHERE drop_id = '111k_devnet'").length, 1);
  }
});


test('paused reset cannot delete native rows belonging to another contract', async context => {
  const h = fixture(context);
  seed(h);
  activate(h, NEXT);
  h.database.prepare('INSERT INTO ethereum_reconciliation_cursor (chain_id, contract_address, next_block) VALUES (?, ?, 9)')
    .run(NEXT.chainId, NEXT.contractAddress);
  activate(h);
  pause(h);
  const resetPlan = await plan(h);
  const forbidden = buildEthereum111kResetBatch(resetPlan);
  forbidden.cursors = 'DELETE FROM ethereum_reconciliation_cursor';
  await assert.rejects(async () => queryBatch(h)(forbidden), /ethereum 111k is paused/);
  assert.equal(ethereum111kResetOutcome(resetPlan, await readEthereum111kSnapshot(queryBatch(h), SCOPE)), 'unchanged');
  await queryBatch(h)(buildEthereum111kResetBatch(resetPlan));
  assert.equal(query(h)(`SELECT next_block FROM ethereum_reconciliation_cursor WHERE contract_address = '${NEXT.contractAddress}'`)[0].next_block, 9);
});


test('private row values stay out of Wrangler arguments, logs, and failure errors', async context => {
  const h = fixture(context);
  seed(h);
  const resetPlan = await plan(h);
  const batch = buildEthereum111kResetBatch(resetPlan);
  const privateAddress = String(resetPlan.snapshot.quotes[0].address_json);
  const privateCode = String(resetPlan.snapshot.claims[0].code);
  for (const sql of Object.values(batch)) {
    assert.equal(sql.includes(privateAddress), false);
    assert.equal(sql.includes(privateCode), false);
  }
  let calls = 0;
  const runner = createEthereum111kMaintenanceRunner((_file, args, options) => {
    calls++;
    assert.equal(options.env!.WRANGLER_LOG_SANITIZE, 'true');
    assert.equal(args.join(' ').includes(privateAddress), false);
    assert.equal(args.join(' ').includes(privateCode), false);
    if (calls === 1) return JSON.stringify(Object.keys(batch).map(() => ({ success: true, results: [] })));
    throw { stdout: JSON.stringify(resetPlan.snapshot), stderr: privateCode };
  });
  runner.queryBatch(batch);
  assert.throws(() => runner.query('SELECT * FROM ethereum_delivery_quotes'), error => {
    assert.equal(String(error).includes(privateAddress), false);
    assert.equal(String(error).includes(privateCode), false);
    return true;
  });
});
