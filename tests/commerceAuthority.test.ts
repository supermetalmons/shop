import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCommerceAuthorityMutationSql,
  parseCommerceAuthorityControlArgs,
} from '../scripts/ops/commerceAuthorityControl.ts';

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
  assert.match(sql, /cutover_at_ms = COALESCE\(cutover_at_ms, 100\)/);
  const pauseSql = buildCommerceAuthorityMutationSql('paused', 7, 100);
  assert.match(pauseSql, /authority_state = 'd1'/);
  assert.doesNotMatch(pauseSql, /import_manifest_sha256 = NULL/);
  assert.throws(() => parseCommerceAuthorityControlArgs(['firestore', '--expected-revision', '7', '--write']));
});
