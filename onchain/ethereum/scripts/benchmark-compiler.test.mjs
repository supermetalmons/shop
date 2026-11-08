import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseline = 'benchmarks/compiler-solc-0.8.38-legacy-200-baseline.json';
const historical = readdirSync(join(root, 'benchmarks')).filter(name => name.endsWith('.json') && `benchmarks/${name}` !== baseline).sort();
const read = path => readFileSync(path, 'utf8');

test('compiler benchmarks measure oversized references but deploy only size-compliant variants without changing historical baselines', () => {
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
      const result = spawnSync(process.execPath, ['scripts/benchmark-compiler.mjs', output, 'all', '200', '500',
        ...(update ? ['--update-baseline'] : [])], {
        cwd: directory, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
      });
      assert.ifError(result.error);
      const report = JSON.parse(read(join(directory, output)));
      assert.equal(report.status, 'complete');
      const oversize = variant => variant.artifacts.NFT111K.runtimeBytes > 24576 ||
        variant.artifacts.NFT111K.creationBytes + report.reproduction.maximumCollectionArgumentBytes > 49152;
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(report.reproduction.maximumCollectionArgumentBytes, 6688);
      assert.equal(report.writeBenchmarkCount,
        Object.keys(report.variants[0].gas).filter(name => !/^(get|preview|stats$|publicRelicStats|allocatedCrates$|warehousesMinted$)/.test(name)).length);
      for (const variant of report.variants) {
        assert.equal(variant.status, 'measured');
        if (oversize(variant)) {
          assert.equal(variant.deploymentTransactions, undefined);
          assert.equal(variant.comparison.withinDeploymentSizeLimits, false);
          assert.equal(variant.comparison.deploymentDeltas, null);
        }
        for (const name of ['mintCrates1', 'mintCrates1EightRecipients', 'mintCrates1ThirtyTwoRecipients',
          'releaseMint', 'releaseMintEightRecipients', 'releaseAllMintThirtyTwoRecipients',
          'releaseAllMintThirtyTwoGasBurningRecipients', 'mintFreeCrates1', 'mintFreeWarehouses1',
          'allocateRelics1', 'allocateRelics18', 'claimRelic', 'claimRelicReceiver', 'getRelicClaimedMaskEmpty',
          'getRelicClaimedMaskFull', 'setFreeMintAllowancesThirtyTwo', 'setBaseURI40', 'setBaseURI1024']) {
          assert.ok(variant.gas[name] > 0, `${variant.label}: missing ${name}`);
        }
        assert.deepEqual(Object.keys(variant.artifacts), ['NFT111K']);
        if (oversize(variant)) continue;
        assert.deepEqual(Object.keys(variant.deploymentTransactions), ['collection']);
        assert.equal(variant.deploymentTransactions.collection.status, '0x1');
        assert.equal(variant.deploymentTransactions.collection.constructorArgumentBytes, 736);
        assert.equal(variant.deploymentTransactions.collection.runtimeBytes, variant.artifacts.NFT111K.runtimeBytes);
        assert.ok(variant.deploymentTransactions.collection.gasUsed > 0);
        assert.equal(variant.comparison.withinDeploymentSizeLimits, true);
      }
      assert.deepEqual(report.variants.map(variant => variant.label), ['legacy-200', 'legacy-500', 'ir-200', 'ir-500']);
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

test('historical delivery reproduction refuses to overwrite original reports', () => {
  for (const name of ['v10-registered-delivery.json', 'registered-delivery.json']) {
    const path = join(root, 'benchmarks', name);
    const before = read(path);
    const result = spawnSync(process.execPath, ['scripts/benchmark-delivery-configs.mjs', path],
      { cwd: root, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Historical delivery reports are protected/);
    assert.equal(read(path), before);
  }
});

test('historical delivery output protection recognizes filesystem aliases', t => {
  const directory = mkdtempSync(join(tmpdir(), '111k-output-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repository = join(directory, 'repository');
  const contractRoot = join(repository, 'onchain/ethereum');
  mkdirSync(join(contractRoot, 'scripts'), { recursive: true });
  mkdirSync(join(contractRoot, 'benchmarks'));
  const script = join(contractRoot, 'scripts/benchmark-delivery-configs.mjs');
  cpSync(join(root, 'scripts/benchmark-delivery-configs.mjs'), script);
  const historicalReport = join(contractRoot, 'benchmarks/v10-registered-delivery.json');
  const defaultOutput = join(contractRoot, 'benchmarks/v10-registered-delivery-reproduction.json');
  writeFileSync(historicalReport, 'historical evidence');
  const alias = join(directory, 'repository-alias');
  symlinkSync(repository, alias, 'dir');
  const linkedFile = join(directory, 'linked.json');
  symlinkSync(historicalReport, linkedFile);
  const hardLink = join(directory, 'hard-link.json');
  const outputs = [historicalReport, linkedFile,
    join(alias, 'onchain/ethereum/benchmarks/v10-registered-delivery.json'),
    join(alias, 'onchain/ethereum/benchmarks/new-report.json')];
  for (const alternateRoot of [join(directory, 'REPOSITORY'), `/System/Volumes/Data${realpathSync(repository)}`]) {
    if (existsSync(alternateRoot)) outputs.push(join(alternateRoot, 'onchain/ethereum/benchmarks/v10-registered-delivery.json'));
  }
  const run = output => spawnSync(process.execPath, [script, output], { cwd: directory, encoding: 'utf8' });
  for (const output of outputs) {
    const result = run(output);
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Historical delivery reports are protected/);
  }
  linkSync(historicalReport, hardLink);
  assert.match(run(hardLink).stderr, /Historical delivery reports are protected/);
  const outsideOutput = join(directory, 'outside.json');
  writeFileSync(outsideOutput, 'previous reproduction');
  for (const output of [defaultOutput, outsideOutput, join(directory, 'new/report.json')]) {
    const result = run(output);
    assert.ifError(result.error);
    assert.match(result.stderr, /Command failed: git cat-file/);
    assert.doesNotMatch(result.stderr, /Historical delivery reports are protected/);
  }
  symlinkSync(historicalReport, defaultOutput);
  assert.match(run(defaultOutput).stderr, /Historical delivery reports are protected/);
  rmSync(defaultOutput);
  linkSync(historicalReport, defaultOutput);
  assert.match(run(defaultOutput).stderr, /Historical delivery reports are protected/);
  assert.equal(read(historicalReport), 'historical evidence');
});
