import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEmptyPoolArgs } from '../scripts/ethereum-metadata/emptyPoolCli.ts';

const scope = ['--bundle', 'releases/test', '--deployment-id', 'mainnet-v1', '--operation-id', `empty-${'a'.repeat(32)}`,
  '--expected-revision', '6'];

test('empty-pool CLI pins one operation and requires explicit writes', () => {
  assert.equal(parseEmptyPoolArgs(['apply', ...scope, '--write']).expectedRevision, 6);
  assert.equal(parseEmptyPoolArgs(['cancel', ...scope, '--write']).operationId, `empty-${'a'.repeat(32)}`);
  for (const command of ['inspect', 'verify']) assert.equal(parseEmptyPoolArgs([command, ...scope]).command, command);
  for (const command of ['apply', 'cancel']) assert.throws(() => parseEmptyPoolArgs([command, ...scope]), /Usage/);
  for (const command of ['inspect', 'verify']) assert.throws(() => parseEmptyPoolArgs([command, ...scope, '--write']), /Usage/);
});

test('empty-pool CLI rejects ambiguous identities and unsafe revisions', () => {
  assert.throws(() => parseEmptyPoolArgs(['apply', ...scope, '--write', '--operation-id', `empty-${'b'.repeat(32)}`]), /Duplicate/);
  for (const revision of ['0', '-1', '01', '1.5', '9007199254740992']) {
    assert.throws(() => parseEmptyPoolArgs(['apply', ...scope.slice(0, -1), revision, '--write']), /Usage|ambiguous/);
  }
  assert.throws(() => parseEmptyPoolArgs(['apply', '--bundle', 'x', '--deployment-id', 'mainnet-v1', '--operation-id', 'other',
    '--expected-revision', '6', '--write']), /Usage/);
});
