import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const suite = 'test/DMXGas.t.sol:DMXGasTest';
const claim = 'testGasClaimFirst()';
const redemption = 'testGasRedeemInitial50()';

function runCase(mutate = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dmx-gas-check-'));
  try {
    for (const name of ['bin', 'scripts', 'test', 'snapshots']) mkdirSync(join(directory, name));
    copyFileSync(join(root, 'scripts/check-dmx-gas-snapshots.mjs'), join(directory, 'scripts/check-dmx-gas-snapshots.mjs'));
    const fixture = {
      source: 'function testGasClaimFirst() public {}\nfunction testGasRedeemInitial50() public {}\n',
      snapshots: { claimFirst: '100', redeemInitial50: '200' },
      results: { [suite]: { test_results: {
        [claim]: { status: 'Success', gas_snapshots: { DMXGasTest: { claimFirst: '100' } } },
        [redemption]: { status: 'Success', gas_snapshots: { DMXGasTest: { redeemInitial50: '200' } } },
      } } },
    };
    mutate(fixture);
    const source = join(directory, 'test/DMXGas.t.sol');
    const snapshot = join(directory, 'snapshots/DMXGasTest.json');
    writeFileSync(source, fixture.source);
    const expected = fixture.snapshots === null ? null : JSON.stringify(fixture.snapshots);
    if (expected !== null) writeFileSync(snapshot, expected);
    writeFileSync(join(directory, 'results.json'), typeof fixture.results === 'string'
      ? fixture.results : JSON.stringify(fixture.results));
    writeFileSync(join(directory, 'bin/forge'), `#!/usr/bin/env node
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'config') {
  assert.deepEqual(args, ['config', '--json']);
  console.log(JSON.stringify({ snapshots: 'snapshots' }));
} else {
  assert.deepEqual(args, ['test', '--offline', '--isolate', '--match-contract', '^DMXGasTest$',
    '--gas-snapshot-check=false', '--gas-snapshot-emit=false', '--json']);
  process.stdout.write(readFileSync('results.json', 'utf8'));
}
`, { mode: 0o755 });
    const result = spawnSync(process.execPath, ['scripts/check-dmx-gas-snapshots.mjs'], {
      cwd: directory, env: { ...process.env, PATH: join(directory, 'bin') + ':' + process.env.PATH },
      encoding: 'utf8', timeout: 10_000,
    });
    if (result.error) throw result.error;
    assert.equal(readFileSync(source, 'utf8'), fixture.source);
    assert.deepEqual(readdirSync(join(directory, 'snapshots')), expected === null ? [] : ['DMXGasTest.json']);
    if (expected !== null) assert.equal(readFileSync(snapshot, 'utf8'), expected);
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function rejects(mutate, message) {
  const result = runCase(mutate);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, message);
}

test('DMX gas checks validate every cold measurement without writing snapshots', () => {
  const result = runCase();
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Validated all 2 gas benchmarks/);
});

test('DMX gas checks reject absent, missing, extra, or invalid snapshot values', () => {
  rejects(f => { f.snapshots = null; }, /ENOENT.*DMXGasTest\.json/);
  rejects(f => { delete f.snapshots.claimFirst; }, /Missing: claimFirst/);
  rejects(f => { f.snapshots.stale = '1'; }, /Unexpected: stale/);
  rejects(f => { f.snapshots.claimFirst = '1.5'; }, /claimFirst must be a positive safe integer string/);
});

test('DMX gas checks reject missing or duplicate benchmark declarations', () => {
  rejects(f => { f.source = ''; }, /benchmark names are missing or duplicated/);
  rejects(f => { f.source += 'function testGasClaimFirst() public {}'; }, /benchmark names are missing or duplicated/);
});

test('DMX gas checks reject malformed output and missing or extra test results', () => {
  rejects(f => { f.results = 'not JSON'; }, /benchmark results do not match/);
  rejects(f => { delete f.results[suite]; }, /benchmark results do not match/);
  rejects(f => { delete f.results[suite].test_results[claim]; }, /benchmark results do not match/);
  rejects(f => { f.results[suite].test_results['testUnexpected()'] = {}; }, /benchmark results do not match/);
  rejects(f => {
    f.results[suite].test_results['testUnexpected()'] = f.results[suite].test_results[claim];
    delete f.results[suite].test_results[claim];
  }, /benchmark results do not match/);
  rejects(f => { f.results.unexpected = {}; }, /benchmark results do not match/);
});

test('DMX gas checks reject failed or skipped benchmarks', () => {
  for (const status of ['Failure', 'Skipped']) {
    rejects(f => { f.results[suite].test_results[claim].status = status; }, /did not succeed/);
  }
});

test('DMX gas checks reject omitted, renamed, and extra per-test measurements', () => {
  rejects(f => { f.results[suite].test_results[claim].gas_snapshots = {}; }, /measurements.*do not match/);
  rejects(f => { f.results[suite].test_results[claim].gas_snapshots.DMXGasTest = { wrong: '100' }; }, /measurements.*do not match/);
  rejects(f => { f.results[suite].test_results[claim].gas_snapshots.DMXGasTest.extra = '100'; }, /measurements.*do not match/);
  rejects(f => { f.results[suite].test_results[claim].gas_snapshots.extra = {}; }, /measurements.*do not match/);
});

test('DMX gas checks reject changed runtime gas without replacing the baseline', () => {
  rejects(f => { f.results[suite].test_results[claim].gas_snapshots.DMXGasTest.claimFirst = '101'; },
    /snapshot mismatch for claimFirst: expected 100, received 101/);
});
