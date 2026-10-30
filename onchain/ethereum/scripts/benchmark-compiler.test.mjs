import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseline = 'benchmarks/compiler-legacy-200-single-contract.json';
const historical = ['compiler-legacy-200.json', 'compiler-legacy-200-cdn.json', 'compiler-settings.json'];
const read = path => readFileSync(path, 'utf8');

test('compiler benchmarks regenerate and reproduce supported recipient configurations without changing historical baselines', () => {
  const originalBaseline = read(join(root, baseline));
  const historicalBaselines = historical.map(name => read(join(root, 'benchmarks', name)));
  const directory = mkdtempSync(join(tmpdir(), '111k-compiler-test-'));
  try {
    for (const name of ['src', 'fixtures/discounts', 'snapshots', 'benchmarks']) {
      cpSync(join(root, name), join(directory, name), { recursive: true });
    }
    mkdirSync(join(directory, 'scripts'));
    mkdirSync(join(directory, 'test'));
    for (const name of ['package.json', 'package-lock.json', 'scripts/benchmark-compiler.mjs',
      'test/NFT111KGas.t.sol', 'test/TestSupport.sol']) {
      cpSync(join(root, name), join(directory, name));
    }
    symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
    const gitDirectory = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: root, encoding: 'utf8' }).trim();
    symlinkSync(gitDirectory, join(directory, '.git'), 'dir');
    const run = (output, update) => {
      const result = spawnSync(process.execPath, ['scripts/benchmark-compiler.mjs', output, 'legacy', '200', '1000',
        ...(update ? ['--update-baseline'] : [])], {
        cwd: directory, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const report = JSON.parse(read(join(directory, output)));
      assert.equal(report.status, 'complete');
      assert.equal(report.reproduction.maximumCollectionArgumentBytes, 2432);
      assert.equal(report.writeBenchmarkCount,
        Object.keys(report.variants[0].gas).filter(name => /^(mint|unbox|deliver|claim|release)/.test(name)).length);
      for (const variant of report.variants) {
        assert.equal(variant.status, 'measured');
        for (const name of ['mintCrates1', 'mintCrates1EightRecipients', 'mintCrates1ThirtyTwoRecipients',
          'releaseMint', 'releaseMintEightRecipients', 'releaseAllMintThirtyTwoRecipients',
          'releaseAllMintThirtyTwoGasBurningRecipients']) {
          assert.ok(variant.gas[name] > 0, `${variant.label}: missing ${name}`);
        }
        assert.deepEqual(Object.keys(variant.artifacts), ['NFT111K']);
        assert.deepEqual(Object.keys(variant.deploymentTransactions), ['collection']);
        assert.equal(variant.deploymentTransactions.collection.constructorArgumentBytes, 640);
        assert.ok(variant.deploymentTransactions.collection.gasUsed > 0);
        assert.equal(variant.comparison.withinDeploymentSizeLimits, true);
      }
      assert.deepEqual(report.variants.map(variant => variant.label), ['legacy-200', 'legacy-1000']);
      const [baselineVariant, optimizedVariant] = report.variants;
      assert.notDeepEqual(
        [optimizedVariant.gas.mintCrates1EightRecipients, optimizedVariant.gas.releaseMintEightRecipients],
        [baselineVariant.gas.mintCrates1EightRecipients, baselineVariant.gas.releaseMintEightRecipients],
        'Eight-recipient benchmarks must use each compiler candidate, not the fixed harness bytecode');
      return report;
    };
    const regenerated = run('regenerated.json', true);
    assert.equal(regenerated.baseline.validation, 'regenerated');
    const refreshedBaseline = read(join(directory, baseline));
    assert.notEqual(refreshedBaseline, originalBaseline);
    const reproduced = run('reproduced.json', false);
    assert.equal(reproduced.baseline.validation, 'reproduced');
    assert.deepEqual(reproduced.baseline.mismatches, []);
    assert.equal(read(join(directory, baseline)), refreshedBaseline);
    assert.deepEqual(reproduced.variants.map(variant => variant.gas), regenerated.variants.map(variant => variant.gas));
    assert.deepEqual(reproduced.variants.map(variant => variant.deploymentTransactions),
      regenerated.variants.map(variant => variant.deploymentTransactions));
    assert.deepEqual(historical.map(name => read(join(directory, 'benchmarks', name))), historicalBaselines);
  } finally {
    assert.equal(read(join(root, baseline)), originalBaseline);
    assert.deepEqual(historical.map(name => read(join(root, 'benchmarks', name))), historicalBaselines);
    rmSync(directory, { recursive: true, force: true });
  }
});
