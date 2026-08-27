import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { loadRevealSubmissionStorageControl } from '../src/revealSubmissionD1.ts';
import { d1Database } from './commerceD1Harness.ts';

test('reveal-submission control reader loads the current Ops schema', async () => {
  const database = new DatabaseSync(':memory:');
  database.exec(readFileSync(
    'cloud/workers/api/ops-migrations/0001_current_schema.sql',
    'utf8',
  ));
  assert.deepEqual(
    await loadRevealSubmissionStorageControl(d1Database(database)),
    {
      paused: false,
      revision: 1,
      updatedAtMs: 0,
    },
  );
});
