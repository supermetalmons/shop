import assert from 'node:assert/strict';
import test from 'node:test';
import { executeGuardedCommerceRead } from '../src/commerceGuardedRead.ts';
import { CommerceRepositoryError } from '../src/commerceRepositoryTypes.ts';

const primaryStatement = {} as D1PreparedStatement;
const dataStatement = {} as D1PreparedStatement;
const additionalStatement = {} as D1PreparedStatement;
const invalidResult = () => new Error('Invalid read result.');

function batchDatabase(batch: (statements: D1PreparedStatement[]) => unknown): Pick<D1Database, 'batch'> {
  return { batch } as unknown as Pick<D1Database, 'batch'>;
}

test('guarded reads validate every guard before returning the unchanged data result', async () => {
  const response = [
    { success: true, results: [{ primary: true }] },
    { success: true, results: [{ document_json: '{invalid JSON' }] },
    { success: true, results: [{ additional: true }] },
  ];
  const validations: string[] = [];
  let batches = 0;
  const result = await executeGuardedCommerceRead(batchDatabase((statements) => {
    batches += 1;
    assert.equal(statements.length, 3);
    assert.strictEqual(statements[0], primaryStatement);
    assert.strictEqual(statements[1], dataStatement);
    assert.strictEqual(statements[2], additionalStatement);
    return response;
  }), () => dataStatement, {
    guards: [{
      createStatement: () => primaryStatement,
      validate: (value) => { assert.strictEqual(value, response[0]); validations.push('primary'); },
    }, {
      createStatement: () => additionalStatement,
      validate: (value) => { assert.strictEqual(value, response[2]); validations.push('additional'); },
    }],
    invalidResult,
  });
  assert.equal(batches, 1);
  assert.deepEqual(validations, ['primary', 'additional']);
  assert.strictEqual(result, response[1]);
});

test('every preparation and execution failure is logged once with its original cause', async (t) => {
  for (const phase of ['primary guard', 'data', 'additional guard', 'batch']) {
    await t.test(phase, async (t) => {
      const cause = new Error(`${phase} failed`);
      const log = t.mock.method(console, 'error', () => {});
      const createStatement = (name: string) => () => {
        if (phase === name) throw cause;
        return dataStatement;
      };
      await assert.rejects(executeGuardedCommerceRead(batchDatabase(() => {
        assert.equal(phase, 'batch');
        throw cause;
      }), createStatement('data'), {
        guards: [{
          createStatement: createStatement('primary guard'),
          validate: () => assert.fail('Failed reads must not validate guards'),
        }, {
          createStatement: createStatement('additional guard'),
          validate: () => assert.fail('Failed reads must not validate guards'),
        }],
        invalidResult,
      }), (error: unknown) => {
        assert.ok(error instanceof CommerceRepositoryError);
        assert.equal(error.code, 'unavailable');
        assert.equal(error.cause, cause);
        return true;
      });
      assert.deepEqual(log.mock.calls.map(({ arguments: args }) => args), [[{
        event: 'commerce_d1_read_failed',
        error: { name: 'Error', message: cause.message },
      }]]);
    });
  }
});

test('guard rejection keeps the original error and is not logged as a D1 failure', async (t) => {
  for (const rejectedGuard of ['primary', 'additional']) {
    await t.test(rejectedGuard, async (t) => {
      const error = new Error(`${rejectedGuard} unavailable`);
      const log = t.mock.method(console, 'error', () => {});
      const validate = (name: string) => () => {
        if (rejectedGuard === name) throw error;
      };
      await assert.rejects(executeGuardedCommerceRead(batchDatabase(() => [
        { success: true, results: [] },
        { success: true, results: [{ sensitive: 'data' }] },
        { success: true, results: [] },
      ]), () => dataStatement, {
        guards: [{ createStatement: () => primaryStatement, validate: validate('primary') },
          { createStatement: () => additionalStatement, validate: validate('additional') }],
        invalidResult,
      }), (actual) => actual === error);
      assert.equal(error.cause, undefined);
      assert.equal(log.mock.callCount(), 0);
    });
  }
});
