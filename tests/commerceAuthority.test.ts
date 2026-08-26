import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCommerceAuthorityMutationSql,
  parseCommerceAuthorityControlArgs,
} from '../scripts/ops/commerceAuthorityControl.ts';
import { parseCommerceCutoverArgs } from '../scripts/ops/cutoverCommerceToD1.ts';

test('commerce authority mutations require explicit write and revision guards', () => {
  assert.deepEqual(parseCommerceAuthorityControlArgs(['status']), {
    command: 'status',
    expectedRevision: undefined,
    write: false,
  });
  assert.throws(() => parseCommerceAuthorityControlArgs(['paused']));
  assert.deepEqual(parseCommerceAuthorityControlArgs([
    'paused', '--expected-revision', '7', '--write',
  ]), {
    command: 'paused',
    expectedRevision: 7,
    write: true,
  });
  const sql = buildCommerceAuthorityMutationSql('d1', 7, 100);
  assert.match(sql, /authority_state = 'paused'/);
  assert.match(sql, /revision = 7/);
  assert.match(sql, /import_manifest_sha256 IS NOT NULL/);
});
test('commerce snapshot import is dry-run by default and guarded when mutating', () => {
  assert.deepEqual(parseCommerceCutoverArgs([]), {
    expectedRevision: undefined,
    firestoreServiceAccountFile: undefined,
    write: false,
  });
  assert.throws(() => parseCommerceCutoverArgs(['--write']));
  assert.deepEqual(parseCommerceCutoverArgs(['--write', '--expected-revision', '3']), {
    expectedRevision: 3,
    firestoreServiceAccountFile: undefined,
    write: true,
  });
});
