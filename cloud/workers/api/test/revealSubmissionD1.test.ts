import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { loadRevealSubmissionStorageControl } from '../src/revealSubmissionD1.ts';
import { d1Database } from './commerceD1Harness.ts';

function preCutoverDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  for (const name of readdirSync('cloud/workers/api/ops-migrations').sort()) {
    if (name === '0016_remove_migration_controls.sql') continue;
    database.exec(readFileSync(`cloud/workers/api/ops-migrations/${name}`, 'utf8'));
  }
  const insert = database.prepare(`INSERT INTO reveal_submissions (
    drop_id, box_asset_id, schema_version, owner_wallet, signature,
    recent_blockhash, blockhash_context_slot, dude_ids_json,
    reservation_id, status, revision, created_at_ms, updated_at_ms, confirmed_at_ms
  ) VALUES ('baseline', ?, 1, ?, ?, ?, 1, '[1]', ?, 'confirmed', 1, 1, 1, 1)`);
  for (let index = 0; index < 14; index += 1) {
    insert.run(
      String(index).padStart(32, '0'),
      '11111111111111111111111111111111',
      '2'.repeat(64),
      '3'.repeat(32),
      `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    );
  }
  return database;
}

test('reveal-submission control reader supports both sides of the final Ops migration', async () => {
  const database = preCutoverDatabase();
  const db = d1Database(database);
  const before = await loadRevealSubmissionStorageControl(db);
  database.exec(readFileSync(
    'cloud/workers/api/ops-migrations/0016_remove_migration_controls.sql',
    'utf8',
  ));
  const after = await loadRevealSubmissionStorageControl(db);
  assert.deepEqual(after, before);
});
