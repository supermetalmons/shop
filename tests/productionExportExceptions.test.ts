import assert from 'node:assert/strict';
import test from 'node:test';
import { updateProductionExportExceptions, validateProductionExportExceptions } from '../scripts/lib/productionExportExceptions.ts';

const testException = ['src/example.ts', 'exports', 'example', 'test', 'tests/example.test.ts'] as const;
const platformException = ['cloud/workers/api/src/index.ts', 'exports', 'ExampleObject', 'platform', 'cloud/workers/api/wrangler.jsonc'] as const;
const readEvidence = (path: string) => {
  if (path === 'tests/example.test.ts') return "import { example } from '../src/example.ts';";
  if (path === 'cloud/workers/api/wrangler.jsonc') return '{"class_name":"ExampleObject"}';
  throw new Error(`Missing evidence: ${path}`);
};

test('production export exceptions retain a reason and a current consumer', () => {
  assert.deepEqual(validateProductionExportExceptions([testException, platformException], readEvidence), [testException, platformException]);
  assert.throws(() => validateProductionExportExceptions([testException.slice(0, 3)], readEvidence), /reason, and evidence/);
  assert.throws(() => validateProductionExportExceptions([testException, testException], readEvidence), /Duplicate/);
  assert.throws(() => validateProductionExportExceptions([[...testException.slice(0, 3), 'unreviewed', testException[4]]], readEvidence), /Unknown/);
});

test('production export review rejects missing, stale, or misclassified evidence', () => {
  assert.throws(() => validateProductionExportExceptions([[...testException.slice(0, 4), 'tests/missing.test.ts']], readEvidence), /Missing evidence/);
  assert.throws(() => validateProductionExportExceptions([testException], () => 'exampleOld'), /no longer references/);
  assert.throws(() => validateProductionExportExceptions([[...testException.slice(0, 3), 'tooling', testException[4]]], readEvidence), /does not match/);
  assert.throws(() => validateProductionExportExceptions([[...testException.slice(0, 4), '../outside.ts']], readEvidence), /repository-relative/);
});

test('baseline updates prune resolved findings without silently accepting new exports', () => {
  const baseline = validateProductionExportExceptions([testException, platformException], readEvidence);
  assert.deepEqual(updateProductionExportExceptions([['src/example.ts', 'exports', 'example']], baseline, readEvidence), [testException]);
  assert.throws(() => updateProductionExportExceptions([['src/example.ts', 'exports', 'unreviewed']], baseline, readEvidence), /explicit reason and evidence/);
  assert.deepEqual(baseline, [testException, platformException]);
});

test('baseline updates allow deleting a resolved export together with its evidence', () => {
  const deletedEvidence = () => { throw new Error('Evidence was deleted with the unused export'); };
  assert.deepEqual(updateProductionExportExceptions([], [testException], deletedEvidence), []);
  assert.throws(() => updateProductionExportExceptions([['src/example.ts', 'exports', 'example']], [testException], deletedEvidence), /Evidence was deleted/);
  assert.throws(() => updateProductionExportExceptions([], [testException, testException], deletedEvidence), /Duplicate/);
});
