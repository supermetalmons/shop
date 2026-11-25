import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { unstable_splitSqlQuery } from 'wrangler';

const directory = new URL('../cloud/workers/api/ops-migrations/', import.meta.url);
const migrationName = '0017_dmx_sepolia_retirement.sql';
const migration = readFileSync(new URL(migrationName, directory), 'utf8');
const retired = '0x' + 'ab'.repeat(20);
const replacement = '0x' + 'cd'.repeat(20);
const unrelated = '0x' + 'ef'.repeat(20);
const batchId = '11111111-1111-4111-8111-111111111111';
const codeHash = (tokenId: number) => tokenId.toString(16).padStart(64, '0');

function database(t: TestContext, beforeMigration?: (db: DatabaseSync) => void): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  for (const name of readdirSync(directory).filter(name => name.endsWith('.sql') && name < migrationName).sort()) {
    db.exec(readFileSync(new URL(name, directory), 'utf8'));
  }
  beforeMigration?.(db);
  for (const statement of unstable_splitSqlQuery(migration)) db.prepare(statement).run();
  return db;
}

function addCredential(db: DatabaseSync, contractAddress: string, tokenId = 1): void {
  db.prepare('INSERT INTO tarot_claim_codes VALUES (11155111, ?, ?, ?, 1000, NULL)')
    .run(contractAddress, tokenId, codeHash(tokenId));
}

function retire(db: DatabaseSync): void {
  db.prepare('INSERT INTO dmx_retired_sepolia_deployments VALUES (11155111, ?, ?, 2000)').run(retired, replacement);
}

test('Sepolia retirement migration preserves existing credentials and leaves mainnet staging and binding untouched', t => {
  const db = database(t, db => {
    addCredential(db, retired);
    addCredential(db, replacement);
    db.prepare(`INSERT INTO dmx_mainnet_claim_batches VALUES (?, 1, 'dmx-mainnet-v1', 'staged', NULL,
      777, ?, 1000, 2000, NULL)`).run(batchId, 'a'.repeat(64));
    db.prepare('INSERT INTO dmx_mainnet_claim_codes VALUES (?, 1, ?, 1000, NULL)').run(batchId, codeHash(1));
    db.prepare('INSERT INTO dmx_mainnet_bound_claim_codes VALUES (?, 1, ?, 1, ?, 1000, NULL)')
      .run(batchId, retired, codeHash(1));
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM dmx_retired_sepolia_deployments').get()?.count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tarot_claim_codes').get()?.count, 2);
  const snapshots = ['dmx_mainnet_claim_batches', 'dmx_mainnet_claim_codes', 'dmx_mainnet_bound_claim_codes']
    .map(table => ({ table, rows: db.prepare(`SELECT * FROM ${table}`).all() }));
  const controls = db.prepare('SELECT * FROM worker_controls').all();
  retire(db);
  db.prepare('DELETE FROM tarot_claim_codes WHERE chain_id=11155111 AND contract_address=?').run(retired);
  assert.deepEqual(db.prepare('SELECT contract_address FROM tarot_claim_codes').all().map(row => row.contract_address), [replacement]);
  for (const { table, rows } of snapshots) assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(), rows, table);
  assert.deepEqual(db.prepare('SELECT * FROM worker_controls').all(), controls);
  db.prepare('INSERT INTO dmx_mainnet_claim_codes VALUES (?, 2, ?, 1000, NULL)').run(batchId, codeHash(2));
  db.prepare('INSERT INTO dmx_mainnet_bound_claim_codes VALUES (?, 1, ?, 2, ?, 1000, NULL)')
    .run(batchId, retired, codeHash(2));
  db.prepare('UPDATE dmx_mainnet_bound_claim_codes SET revoked_at_ms=2000 WHERE token_id=1').run();
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('retirement markers require Sepolia, distinct normalized nonzero addresses and safe timestamps', t => {
  const db = database(t);
  const insert = db.prepare('INSERT INTO dmx_retired_sepolia_deployments VALUES (?, ?, ?, ?)');
  const valid = [11155111, retired, replacement, 2000] as const;
  const invalid: Array<Array<string | number | null>> = [
    [1, retired, replacement, 2000], [31337, retired, replacement, 2000],
    ...[1, 2].flatMap(index => [null, '', '0x' + '0'.repeat(40), '0x' + 'a'.repeat(39),
      '0X' + 'a'.repeat(40), '0x' + 'A'.repeat(40), '0x' + 'g'.repeat(40)].map(address =>
      valid.map((value, position) => position === index ? address : value))),
    [11155111, retired, retired, 2000],
    ...[null, 0, -1, 1.5, 9007199254740992].map(timestamp => [11155111, retired, replacement, timestamp]),
  ];
  for (const row of invalid) assert.throws(() => insert.run(...row));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM dmx_retired_sepolia_deployments').get()?.count, 0);
  assert.doesNotThrow(() => insert.run(...valid));
});

test('retirement markers cannot be updated, deleted or replaced under either SQLite trigger mode', t => {
  for (const recursive of [0, 1]) {
    const db = database(t);
    db.exec(`PRAGMA recursive_triggers = ${recursive}`);
    retire(db);
    const before = db.prepare('SELECT * FROM dmx_retired_sepolia_deployments').all();
    for (const sql of [
      'UPDATE dmx_retired_sepolia_deployments SET retired_at_ms=retired_at_ms',
      'UPDATE dmx_retired_sepolia_deployments SET retired_at_ms=3000',
      `UPDATE dmx_retired_sepolia_deployments SET contract_address='${unrelated}'`,
      `UPDATE dmx_retired_sepolia_deployments SET replacement_contract_address='${unrelated}'`,
      'DELETE FROM dmx_retired_sepolia_deployments',
      `INSERT OR REPLACE INTO dmx_retired_sepolia_deployments VALUES (11155111, '${retired}', '${unrelated}', 3000)`,
      `INSERT INTO dmx_retired_sepolia_deployments VALUES (11155111, '${retired}', '${replacement}', 2000)
        ON CONFLICT(chain_id,contract_address) DO UPDATE SET retired_at_ms=3000`,
    ]) {
      assert.throws(() => db.exec(sql), /retirement is immutable/);
      assert.deepEqual(db.prepare('SELECT * FROM dmx_retired_sepolia_deployments').all(), before);
    }
  }
});

test('retirement rejects pending inserts, replacements and updates from or into the retired scope while allowing cleanup', t => {
  const db = database(t);
  addCredential(db, retired);
  addCredential(db, replacement);
  const pending = db.prepare('INSERT INTO tarot_claim_codes VALUES (11155111, ?, 2, ?, 1000, NULL)');
  retire(db);
  const before = db.prepare('SELECT * FROM tarot_claim_codes ORDER BY contract_address,token_id').all();
  const fenced = /Retired DMX Sepolia credentials cannot be written/;
  assert.throws(() => pending.run(retired, codeHash(2)), fenced);
  for (const sql of [
    `INSERT OR REPLACE INTO tarot_claim_codes VALUES (11155111, '${retired}', 1, '${codeHash(3)}', 1000, NULL)`,
    `INSERT INTO tarot_claim_codes VALUES (11155111, '${retired}', 1, '${codeHash(3)}', 1000, NULL)
      ON CONFLICT(chain_id,contract_address,token_id) DO UPDATE SET code_hash=excluded.code_hash`,
    `UPDATE tarot_claim_codes SET revoked_at_ms=2000 WHERE contract_address='${retired}'`,
    `UPDATE tarot_claim_codes SET contract_address='${unrelated}' WHERE contract_address='${retired}'`,
    `UPDATE tarot_claim_codes SET contract_address='${retired}',token_id=2 WHERE contract_address='${replacement}'`,
    `UPDATE tarot_claim_codes SET token_id=token_id`,
    `INSERT INTO tarot_claim_codes VALUES
      (11155111, '${unrelated}', 1, '${codeHash(1)}', 1000, NULL),
      (11155111, '${retired}', 2, '${codeHash(2)}', 1000, NULL)`,
  ]) {
    assert.throws(() => db.exec(sql), fenced);
    assert.deepEqual(db.prepare('SELECT * FROM tarot_claim_codes ORDER BY contract_address,token_id').all(), before);
  }
  addCredential(db, replacement, 2);
  db.prepare('UPDATE tarot_claim_codes SET revoked_at_ms=2000 WHERE contract_address=? AND token_id=2').run(replacement);
  db.prepare('DELETE FROM tarot_claim_codes WHERE contract_address=?').run(retired);
  assert.throws(() => pending.run(retired, codeHash(2)), fenced);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tarot_claim_codes WHERE contract_address=?').get(retired)?.count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tarot_claim_codes WHERE contract_address=?').get(replacement)?.count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM dmx_retired_sepolia_deployments').get()?.count, 1);
});
