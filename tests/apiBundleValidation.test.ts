import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function validate(content: string) {
  const directory = mkdtempSync(join(tmpdir(), 'mons-shop-api-bundle-'));
  const bundle = join(directory, 'worker.js');
  writeFileSync(bundle, content);
  try {
    return spawnSync(process.execPath, [
      '--experimental-strip-types',
      'scripts/validate-api-bundle.ts',
      bundle,
    ], { encoding: 'utf8' });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

test('API bundle validation rejects supported credential formats', () => {
  for (const credential of [
    'sk_live_1234567890abcdef',
    'rk_test_1234567890abcdef',
    'whsec_1234567890abcdef',
  ]) {
    assert.equal(validate(credential).status, 1, credential);
  }
  assert.equal(validate('const value = "safe";').status, 0);
});
