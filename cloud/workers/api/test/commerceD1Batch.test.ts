import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { executeCommerceD1Batch } from '../src/commerceD1Batch.ts';
import { d1Database } from './commerceD1Harness.ts';

const invalidResult = () => new Error('Invalid commerce batch response.');
const statement = {} as D1PreparedStatement;

function batchDatabase(batch: (statements: D1PreparedStatement[]) => unknown): Pick<D1Database, 'batch'> {
  return { batch } as unknown as Pick<D1Database, 'batch'>;
}

test('an empty batch does not call D1 or classify an error', async (t) => {
  const db = batchDatabase(() => assert.fail('Unexpected database call'));
  const options = {
    invalidResult: () => assert.fail('Unexpected invalid result'),
    mapBatchError: () => assert.fail('Unexpected batch failure'),
  };
  assert.deepEqual(await executeCommerceD1Batch(db, [], options), []);
  const prepare = t.mock.fn(() => []);
  assert.deepEqual(await executeCommerceD1Batch(db, prepare, options), []);
  assert.equal(prepare.mock.callCount(), 1);
});

test('a single SQLite batch preserves statement order and observes earlier writes', async (t) => {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  database.exec('CREATE TABLE batch_test (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  const calls: string[] = [];
  const db = d1Database(database, undefined, undefined, ({ method }) => calls.push(method));
  const results = await executeCommerceD1Batch(db, () => [
    db.prepare('INSERT INTO batch_test (id, value) VALUES (?, ?)').bind(1, 'original'),
    db.prepare('SELECT value FROM batch_test WHERE id = ?').bind(1),
    db.prepare('UPDATE batch_test SET value = ? WHERE id = ? RETURNING value').bind('updated', 1),
    db.prepare('SELECT value FROM batch_test WHERE id = ?').bind(1),
  ], { invalidResult, requireMeta: true });
  assert.deepEqual(calls, ['batch']);
  assert.deepEqual(results.map(({ results: rows }) => rows.map((row) => row.value)), [
    [], ['original'], ['updated'], ['updated'],
  ]);
  assert.equal(results[0].meta.changes, 1);
});

test('a failing statement rolls back the whole SQLite batch before its error is mapped', async (t) => {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  database.exec('CREATE TABLE batch_test (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  const db = d1Database(database);
  const mapped = new Error('Commerce write rejected.');
  let mappedCalls = 0;
  await assert.rejects(executeCommerceD1Batch(db, [
    db.prepare('INSERT INTO batch_test (id, value) VALUES (?, ?)').bind(1, 'first'),
    db.prepare('INSERT INTO batch_test (id, value) VALUES (?, ?)').bind(1, 'duplicate'),
  ], {
    invalidResult,
    mapBatchError: (cause) => {
      mappedCalls += 1;
      assert.match(String(cause), /UNIQUE constraint failed/);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM batch_test').get()!.count, 0);
      return mapped;
    },
  }), (error) => error === mapped);
  assert.equal(mappedCalls, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM batch_test').get()!.count, 0);
});

test('valid result objects and opaque domain rows are returned unchanged', async () => {
  const rows = [{ document_json: '{invalid JSON', unexpected_domain_field: null }];
  const response = [{ success: true, results: rows, meta: { changes: 0 } }];
  const actual = await executeCommerceD1Batch(batchDatabase(() => response), [statement], {
    invalidResult,
    mapBatchError: () => assert.fail('Domain rows must not be classified as batch failures'),
    requireMeta: true,
  });
  assert.strictEqual(actual, response);
  assert.strictEqual(actual[0].results, rows);
  assert.throws(() => JSON.parse(String(actual[0].results[0].document_json)), SyntaxError);
});

test('preparation and execution failures preserve their identity unless explicitly mapped', async (t) => {
  const cause = new Error('Database unavailable.');
  const cases = [
    { name: 'preparation', db: batchDatabase(() => assert.fail('Preparation failed before D1')),
      statements: () => { throw cause; } },
    { name: 'synchronous execution', db: batchDatabase(() => { throw cause; }), statements: [statement] },
    { name: 'asynchronous execution', db: batchDatabase(async () => { throw cause; }), statements: [statement] },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      await assert.rejects(executeCommerceD1Batch(entry.db, entry.statements, { invalidResult }),
        (error) => error === cause);
      const mapped = new Error(`Mapped ${entry.name} failure.`);
      let mapperCalls = 0;
      await assert.rejects(executeCommerceD1Batch(entry.db, entry.statements, {
        invalidResult,
        mapBatchError: (error) => {
          mapperCalls += 1;
          assert.strictEqual(error, cause);
          return mapped;
        },
      }), (error) => error === mapped);
      assert.equal(mapperCalls, 1);
    });
  }
});

test('incomplete or unsuccessful responses fail validation without entering the execution error mapper', async (t) => {
  const valid = { success: true, results: [] };
  const cases: Array<[string, unknown]> = [
    ['missing response', undefined],
    ['non-array response', { results: [valid] }],
    ['missing statement response', []],
    ['extra statement response', [valid, valid]],
    ['sparse statement response', new Array(1)],
    ['null statement response', [null]],
    ['unsuccessful statement', [{ success: false, results: [] }]],
    ['truthy success marker', [{ success: 1, results: [] }]],
    ['missing rows', [{ success: true }]],
    ['non-array rows', [{ success: true, results: {} }]],
  ];
  for (const [name, response] of cases) {
    await t.test(name, async () => {
      const invalid = new Error('Invalid response.');
      await assert.rejects(executeCommerceD1Batch(batchDatabase(() => response), [statement], {
        invalidResult: () => invalid,
        mapBatchError: () => assert.fail('Response validation is outside the execution error boundary'),
      }), (error) => error === invalid);
    });
  }
});

test('metadata is optional for reads and required as an object when requested', async (t) => {
  const readResponse = [{ success: true, results: [] }];
  assert.strictEqual(await executeCommerceD1Batch(batchDatabase(() => readResponse), [statement], {
    invalidResult,
  }), readResponse);
  for (const meta of [undefined, null, [], 0, 'metadata']) {
    await t.test(`rejects ${JSON.stringify(meta)} metadata`, async () => {
      const invalid = new Error('Invalid metadata.');
      await assert.rejects(executeCommerceD1Batch(batchDatabase(() => [{ success: true, results: [], meta }]), [statement], {
        invalidResult: () => invalid,
        requireMeta: true,
        mapBatchError: () => assert.fail('Metadata validation is outside the execution error boundary'),
      }), (error) => error === invalid);
    });
  }
});
