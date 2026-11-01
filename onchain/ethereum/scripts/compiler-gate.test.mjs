import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCurrentCompilerBaseline, assertCurrentCompilerReport, createCompilerGateReport } from './compiler-gate.mjs';

function comparisonFixture() {
  const sourceSha256 = { 'NFT111K.sol': 'source' };
  const variant = optimizerRuns => ({
    label: `legacy-${optimizerRuns}`,
    optimizerRuns,
    viaIR: false,
    status: 'measured',
    sourceSha256: { ...sourceSha256 },
    artifacts: { NFT111K: {
      compilerVersion: '0.8.38+commit.1835d247',
      canonicalAbiSha256: 'abi',
      creationSha256: `creation-${optimizerRuns}`,
      runtimeTemplateSha256: `runtime-${optimizerRuns}`,
      runtimeBytes: optimizerRuns === 500 ? 24400 : 23900,
      creationBytes: 28000,
    } },
    gas: optimizerRuns === 500
      ? { mintCrates1: 990, deliverCrate1: 2010, getTokenInfoFresh: 150 }
      : { mintCrates1: 1000, deliverCrate1: 2000, getTokenInfoFresh: 100 },
    deploymentTransactions: { collection: { gasUsed: 5800000 } },
  });
  return {
    schemaVersion: 2,
    status: 'complete',
    measuredAt: '2026-11-01T00:00:00.000Z',
    sourceCommit: 'base-commit',
    sourceSha256,
    baselineReference: { path: 'benchmarks/compiler-solc-0.8.38-legacy-200-baseline.json', updated: true, sha256: 'baseline-file' },
    benchmarkCount: 3,
    writeBenchmarkCount: 2,
    toolchain: { forge: 'forge', anvil: 'anvil', node: 'node', dependencies: { erc721a: '4.3.0' } },
    reproduction: {
      fixedSettings: { solc: '0.8.38', optimizer: true, evmVersion: 'prague', bytecodeHash: 'none' },
      maximumCollectionArgumentBytes: 6656,
      harnessSha256: 'harness',
    },
    variants: [variant(200), variant(500)],
  };
}

function reportFixture() {
  return createCompilerGateReport(comparisonFixture(), {
    before: { 'src/NFT111K.sol': 'source' },
    after: { 'src/NFT111K.sol': 'source' },
    scriptSha256: 'script',
  });
}

test('the compiler gate evaluates selected 500-run writes against the 200-run reference', () => {
  const comparison = comparisonFixture();
  comparison.variants.reverse();
  const report = createCompilerGateReport(comparison, {});
  assert.equal(report.settings.candidateRuns, 500);
  assert.equal(report.settings.referenceRuns, 200);
  assert.equal(report.status, 'passed');
  assert.equal(report.gatedCaseCount, 2);
  assert.deepEqual(report.rows.find(row => row.name === 'mintCrates1'),
    { name: 'mintCrates1', reference: 1000, candidate: 990, delta: -10, percent: -1 });
  assert.equal(report.readOnlyIncreasesOverOnePercent[0].name, 'getTokenInfoFresh');
});

test('the compiler gate rejects a write increase of exactly one percent', () => {
  const comparison = comparisonFixture();
  comparison.variants[1].gas.mintCrates1 = 1010;
  const report = createCompilerGateReport(comparison, {});
  assert.equal(report.status, 'failed');
  assert.deepEqual(report.violations.map(row => row.name), ['mintCrates1']);
});

test('the compiler gate rejects changed source, ABI, coverage, settings, and deployment limits', () => {
  const cases = [
    [value => { value.variants[1].sourceSha256['NFT111K.sol'] = 'different'; }, /changed source/],
    [value => { value.variants[1].artifacts.NFT111K.canonicalAbiSha256 = 'different'; }, /changed ABI/],
    [value => { delete value.variants[1].gas.mintCrates1; }, /coverage changed/],
    [value => { value.benchmarkCount++; }, /benchmark count changed/],
    [value => { value.writeBenchmarkCount++; }, /classification changed/],
    [value => { value.variants[1].gas.mintCrates1 = 0; }, /Invalid gas measurement/],
    [value => { value.reproduction.fixedSettings.solc = '0.8.30'; }, /settings changed/],
    [value => { value.variants[1].artifacts.NFT111K.runtimeBytes = 24577; }, /Runtime exceeds/],
    [value => { value.variants[1].artifacts.NFT111K.creationBytes = 49152; }, /Initcode exceeds/],
  ];
  for (const [change, message] of cases) {
    const comparison = comparisonFixture();
    change(comparison);
    assert.throws(() => createCompilerGateReport(comparison, {}), message);
  }
});

test('current report checking ignores run timestamps, base commit, and timestamped baseline file hash', () => {
  const recorded = reportFixture();
  const current = structuredClone(recorded);
  current.comparison.measuredAt = '2026-11-02T00:00:00.000Z';
  current.comparison.sourceCommit = 'new-base-commit';
  current.comparison.baselineReference.sha256 = 'regenerated-baseline-file';
  assert.doesNotThrow(() => assertCurrentCompilerReport(recorded, current));
});

test('current report checking treats Node runtime metadata as informational', () => {
  const recorded = reportFixture();
  const current = structuredClone(recorded);
  current.comparison.toolchain.node = 'v24.15.0';
  assert.doesNotThrow(() => assertCurrentCompilerReport(recorded, current));
  assert.equal(recorded.comparison.toolchain.node, 'node');
  assert.equal(current.comparison.toolchain.node, 'v24.15.0');
});

test('current report checking rejects stale provenance, coverage, gas, sizes, ABI, and deployment receipts', () => {
  const cases = [
    value => { value.settings.candidateRuns = 200; },
    value => { value.caseCount++; },
    value => { value.rows.pop(); },
    value => { value.rows[0].candidate++; },
    value => { value.provenance.before['src/NFT111K.sol'] = 'different'; },
    value => { value.comparison.sourceSha256['NFT111K.sol'] = 'different'; },
    value => { value.comparison.reproduction.harnessSha256 = 'different'; },
    value => { value.comparison.toolchain.dependencies.erc721a = 'different'; },
    value => { value.comparison.baselineReference.path = 'different'; },
    value => { value.comparison.variants[1].gas.mintCrates1++; },
    value => { value.comparison.variants[1].artifacts.NFT111K.runtimeBytes++; },
    value => { value.comparison.variants[1].artifacts.NFT111K.creationBytes++; },
    value => { value.comparison.variants[1].artifacts.NFT111K.runtimeTemplateSha256 = 'different'; },
    value => { value.comparison.variants[1].artifacts.NFT111K.canonicalAbiSha256 = 'different'; },
    value => { value.comparison.variants[1].deploymentTransactions.collection.gasUsed++; },
  ];
  const recorded = reportFixture();
  for (const change of cases) {
    const current = structuredClone(recorded);
    change(current);
    assert.throws(() => assertCurrentCompilerReport(recorded, current), /Compiler report is stale/);
  }
});

test('current baseline checking ignores metadata but detects changed measurements and provenance', () => {
  const comparison = comparisonFixture();
  const recorded = {
    schemaVersion: 1,
    measuredAt: comparison.measuredAt,
    sourceCommit: comparison.sourceCommit,
    provenance: { sourceSha256: comparison.sourceSha256, harnessSha256: 'harness' },
    artifacts: comparison.variants[0].artifacts,
    gas: comparison.variants[0].gas,
  };
  const current = structuredClone(recorded);
  current.measuredAt = 'later';
  current.sourceCommit = 'new-base-commit';
  assert.doesNotThrow(() => assertCurrentCompilerBaseline(recorded, current));
  current.gas.mintCrates1++;
  assert.throws(() => assertCurrentCompilerBaseline(recorded, current), /Compiler baseline is stale/);
  current.gas.mintCrates1--;
  current.provenance.harnessSha256 = 'different';
  assert.throws(() => assertCurrentCompilerBaseline(recorded, current), /Compiler baseline is stale/);
});
