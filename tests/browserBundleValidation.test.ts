import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const fixtureCode = 'MixedCaseFixture';
const validator = resolve('scripts/validate-browser-bundle.ts');

function validate(content: string) {
  const directory = mkdtempSync(join(tmpdir(), 'mons-shop-browser-bundle-'));
  try {
    mkdirSync(join(directory, 'dist'));
    writeFileSync(join(directory, 'dist', 'bundle.js'), content);
    return spawnSync(process.execPath, [
      '--experimental-strip-types',
      validator,
    ], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        ETHEREUM_PRE111K_ACCESS_CODES: JSON.stringify([` ${fixtureCode} `]),
      },
    });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

test('browser bundle validation rejects configured and canonical access code spellings without disclosing them', () => {
  for (const spelling of [fixtureCode, fixtureCode.toUpperCase()]) {
    const result = validate(`const value = "${spelling}";`);
    assert.equal(result.status, 1);
    const diagnostics = result.stdout + result.stderr;
    assert.match(diagnostics, /a configured relic access code/);
    assert.equal(diagnostics.includes(fixtureCode), false);
    assert.equal(diagnostics.includes(fixtureCode.toUpperCase()), false);
  }
  assert.equal(validate('const value = "safe";').status, 0);
});
