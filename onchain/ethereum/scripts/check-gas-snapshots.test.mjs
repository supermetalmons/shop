import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const committedPath = resolve(root, 'snapshots/Mons111kGasTest.json');
const harnessPath = resolve(root, 'test/Mons111kGas.t.sol');

function isolatedProject(directory, mutateHarness) {
  const project = join(directory, 'project');
  mkdirSync(project);
  cpSync(join(root, 'src'), join(project, 'src'), { recursive: true });
  mkdirSync(join(project, 'scripts'));
  mkdirSync(join(project, 'test'));
  for (const file of ['package.json', 'foundry.toml', 'scripts/check-gas-snapshots.mjs', 'test/TestSupport.sol']) {
    copyFileSync(join(root, file), join(project, file));
  }
  writeFileSync(join(project, 'test/Mons111kGas.t.sol'), mutateHarness(readFileSync(harnessPath, 'utf8')));
  symlinkSync(join(root, 'node_modules'), join(project, 'node_modules'), 'dir');
  return project;
}

function withGateSnapshot(change, check, options = {}) {
  const committed = readFileSync(committedPath, 'utf8');
  const committedHarness = readFileSync(harnessPath, 'utf8');
  const directory = mkdtempSync(join(tmpdir(), 'mons-111k-gas-check-'));
  try {
    const snapshots = join(directory, 'snapshots');
    mkdirSync(snapshots);
    const project = options.mutateHarness ? isolatedProject(directory, options.mutateHarness) : root;
    const value = change(JSON.parse(committed));
    const snapshotPath = join(snapshots, 'Mons111kGasTest.json');
    const expected = value === null ? null : JSON.stringify(value, null, 2) + '\n';
    if (expected !== null) writeFileSync(snapshotPath, expected);
    const result = spawnSync('npm', ['run', '--silent', 'gas:check'], {
      cwd: project, env: { ...process.env, ...options.env, FOUNDRY_SNAPSHOTS: snapshots }, encoding: 'utf8', timeout: 60_000,
    });
    if (result.error) throw result.error;
    assert.equal(readFileSync(committedPath, 'utf8'), committed);
    assert.equal(readFileSync(harnessPath, 'utf8'), committedHarness);
    if (expected === null) assert.deepEqual(readdirSync(snapshots), []);
    else assert.equal(readFileSync(snapshotPath, 'utf8'), expected);
    check(result.status, `${result.stdout}\n${result.stderr}`, project);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('valid gas baselines pass without rewriting expected values', () => {
  withGateSnapshot(value => value, (status, output) => assert.equal(status, 0, output));
});

test('a missing gas snapshot file fails without creating a baseline', () => {
  withGateSnapshot(() => null, (status, output) => {
    assert.notEqual(status, 0, output);
    assert.match(output, /ENOENT.*Mons111kGasTest\.json/);
  });
});

test('a missing gas benchmark baseline fails before Forge comparison', () => {
  withGateSnapshot(value => { delete value.mintCrates1; return value; }, (status, output) => {
    assert.notEqual(status, 0, output);
    assert.match(output, /Missing: mintCrates1/);
  });
});

test('an unexpected gas baseline fails instead of hiding a removed benchmark', () => {
  withGateSnapshot(value => ({ ...value, staleBenchmark: '1' }), (status, output) => {
    assert.notEqual(status, 0, output);
    assert.match(output, /Unexpected: staleBenchmark/);
  });
});

test('invalid gas values fail before Forge comparison', () => {
  withGateSnapshot(value => ({ ...value, mintCrates1: '1.5' }), (status, output) => {
    assert.notEqual(status, 0, output);
    assert.match(output, /mintCrates1 must be a positive safe integer string/);
  });
});

test('changed gas values fail runtime comparison without regenerating snapshots', () => {
  withGateSnapshot(value => ({ ...value, mintCrates1: '1' }), (status, output) => {
    assert.notEqual(status, 0, output);
    assert.match(output, /Gas snapshot mismatch for mintCrates1: expected 1, received /);
  });
});

test('a filter that skips every benchmark fails instead of accepting unchanged baselines', () => {
  withGateSnapshot(value => value, (status, output) => {
    assert.notEqual(status, 0, output);
    assert.match(output, /Gas benchmark results do not match/);
  }, { env: { FOUNDRY_MATCH_TEST: 'does_not_exist' } });
});

test('a filter that selects one benchmark cannot hide another incorrect baseline', () => {
  withGateSnapshot(value => ({ ...value, getTokenInfoFresh: '1' }), (status, output) => {
    assert.notEqual(status, 0, output);
    assert.match(output, /Gas benchmark results do not match/);
  }, { env: { FOUNDRY_MATCH_TEST: 'testGasMintCrates1\\(' } });
});

test('an omitted measurement fails even when every benchmark runs and its declaration remains', () => {
  withGateSnapshot(value => ({ ...value, getTokenInfoFresh: '1' }), (status, output, project) => {
    assert.notEqual(status, 0, output);
    assert.match(output, /Gas measurements for testGasGetTokenInfoFresh\(\) do not match/);
    const result = spawnSync('forge', [
      'test', '--offline', '--isolate', '--match-contract', '^Mons111kGasTest$',
      '--gas-snapshot-check=false', '--gas-snapshot-emit=false', '--json',
    ], { cwd: project, encoding: 'utf8', timeout: 60_000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    const tests = JSON.parse(result.stdout)['test/Mons111kGas.t.sol:Mons111kGasTest'].test_results;
    assert.equal(Object.keys(tests).length, Object.keys(JSON.parse(readFileSync(committedPath, 'utf8'))).length);
    assert.ok(Object.values(tests).every(test => test.status === 'Success'));
    assert.deepEqual(tests['testGasGetTokenInfoFresh()'].gas_snapshots, {});
  }, { mutateHarness: source => {
    const measurement = '        vm.snapshotGasLastCall("getTokenInfoFresh");\n';
    assert.ok(source.includes(measurement));
    return source.replace(measurement, '');
  } });
});

test('a renamed measurement fails instead of silently skipping the expected snapshot', () => {
  withGateSnapshot(value => value, (status, output) => {
    assert.notEqual(status, 0, output);
    assert.match(output, /Gas measurements for testGasGetTokenInfoFresh\(\) do not match/);
  }, { mutateHarness: source => {
    const measurement = 'vm.snapshotGasLastCall("getTokenInfoFresh")';
    assert.ok(source.includes(measurement));
    return source.replace(measurement, 'vm.snapshotGasLastCall("unexpectedFreshMeasurement")');
  } });
});
