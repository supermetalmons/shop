import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCurrentCompilerBaseline, assertCurrentCompilerReport, createCompilerGateReport } from './compiler-gate.mjs';

const createIRReport = (comparison, provenance) => createCompilerGateReport(comparison, provenance, { candidateRuns: 200, viaIR: true });

function comparisonFixture() {
  const sourceSha256 = { 'NFT111K.sol': 'source' };
  const variant = viaIR => ({
    label: `${viaIR ? 'ir' : 'legacy'}-200`,
    optimizerRuns: 200,
    viaIR,
    status: 'measured',
    sourceSha256: { ...sourceSha256 },
    artifacts: { NFT111K: {
      compilerVersion: '0.8.38+commit.1835d247',
      compilerSettings: { optimizer: { enabled: true, runs: 200 }, viaIR,
        evmVersion: 'prague', metadata: { bytecodeHash: 'none' } },
      canonicalAbiSha256: 'abi',
      creationSha256: `creation-${viaIR}`,
      runtimeTemplateSha256: `runtime-${viaIR}`,
      runtimeBytes: viaIR ? 24400 : 26900,
      creationBytes: 28000,
    } },
    gas: viaIR
      ? { mintCrates1: 990, deliverCrate1: 2010, getTokenInfoFresh: 150, publicRelicStatsWallet: 500 }
      : { mintCrates1: 1000, deliverCrate1: 2000, getTokenInfoFresh: 100, publicRelicStatsWallet: 100 },
    ...(viaIR ? { deploymentTransactions: { collection: {
      address: '0x1234567890123456789012345678901234567890', status: '0x1',
      gasUsed: 5800000, constructorArgumentBytes: 736, runtimeBytes: 24400,
    } } } : {}),
  });
  return {
    schemaVersion: 2,
    status: 'complete',
    measuredAt: '2026-11-01T00:00:00.000Z',
    sourceCommit: 'base-commit',
    sourceSha256,
    baselineReference: { path: 'benchmarks/compiler-solc-0.8.38-legacy-200-baseline.json', updated: true, sha256: 'baseline-file' },
    benchmarkCount: 4,
    writeBenchmarkCount: 2,
    toolchain: { forge: 'forge', anvil: 'anvil', node: 'node', dependencies: { erc721a: '4.3.0' } },
    reproduction: {
      fixedSettings: { solc: '0.8.38', optimizer: true, evmVersion: 'prague', bytecodeHash: 'none' },
      deployment: { engine: 'anvil', hardfork: 'prague', codeSizeLimit: 24576, initcodeSizeLimit: 49152 },
      maximumCollectionArgumentBytes: 6656,
      harnessSha256: 'harness',
    },
    variants: [variant(false), variant(true)],
  };
}

function reportFixture() {
  return createIRReport(comparisonFixture(), {
    before: { 'src/NFT111K.sol': 'source' },
    after: { 'src/NFT111K.sol': 'source' },
    scriptSha256: 'script',
  });
}

test('the compiler gate evaluates selected IR/200 writes against an oversized legacy/200 reference', () => {
  const comparison = comparisonFixture();
  comparison.variants.reverse();
  const report = createIRReport(comparison, {});
  assert.equal(report.settings.candidateRuns, 200);
  assert.equal(report.settings.viaIR, true);
  assert.equal(report.settings.referenceRuns, 200);
  assert.equal(report.status, 'passed');
  assert.equal(report.gatedCaseCount, 2);
  assert.deepEqual(report.rows.find(row => row.name === 'mintCrates1'),
    { name: 'mintCrates1', reference: 1000, candidate: 990, delta: -10, percent: -1 });
  assert.equal(report.readOnlyIncreasesOverOnePercent[0].name, 'getTokenInfoFresh');
  assert.equal(report.readOnlyIncreasesOverOnePercent[1].name, 'publicRelicStatsWallet');
});

test('the compiler gate rejects a write increase of exactly one percent', () => {
  const comparison = comparisonFixture();
  comparison.variants[1].gas.mintCrates1 = 1010;
  const report = createIRReport(comparison, {});
  assert.equal(report.status, 'failed');
  assert.deepEqual(report.violations.map(row => row.name), ['mintCrates1']);
});

test('new public relic administration remains subject to the write gas gate', () => {
  const comparison = comparisonFixture();
  comparison.variants[0].gas.setPublicRelicSaleAfterMint = 1000;
  comparison.variants[1].gas.setPublicRelicSaleAfterMint = 1010;
  comparison.benchmarkCount++;
  comparison.writeBenchmarkCount++;
  const report = createIRReport(comparison, {});
  assert.equal(report.status, 'failed');
  assert.deepEqual(report.violations.map(row => row.name), ['setPublicRelicSaleAfterMint']);
});

test('only the selected compiler must fit exact deployment size boundaries', () => {
  const comparison = comparisonFixture();
  comparison.variants[0].artifacts.NFT111K.creationBytes = 50000;
  comparison.variants[1].artifacts.NFT111K.runtimeBytes = 24576;
  comparison.variants[1].artifacts.NFT111K.creationBytes = 49152 - comparison.reproduction.maximumCollectionArgumentBytes;
  comparison.variants[1].deploymentTransactions.collection.runtimeBytes = 24576;
  assert.equal(createIRReport(comparison, {}).status, 'passed');
});

test('the legacy reference can be selected directly without inventing a second compiler variant', () => {
  const comparison = comparisonFixture();
  const candidate = comparison.variants[1];
  candidate.label = 'legacy-200';
  candidate.viaIR = false;
  candidate.artifacts.NFT111K.compilerSettings.viaIR = false;
  comparison.variants = [candidate];
  const report = createCompilerGateReport(comparison, {}, { candidateRuns: 200, viaIR: false });
  assert.equal(report.status, 'passed');
  assert.ok(report.rows.every(row => row.delta === 0));
  assert.equal(report.settings.viaIR, false);
  candidate.artifacts.NFT111K.runtimeBytes = 24577;
  assert.throws(() => createCompilerGateReport(comparison, {}, { candidateRuns: 200, viaIR: false }), /Runtime exceeds/);
});

test('the compiler gate rejects changed source, ABI, coverage, settings, and deployment limits', () => {
  const cases = [
    [value => { value.variants[1].sourceSha256['NFT111K.sol'] = 'different'; }, /changed source/],
    [value => { value.variants[0].sourceSha256['NFT111K.sol'] = 'different'; }, /changed source/],
    [value => { value.variants[1].artifacts.NFT111K.canonicalAbiSha256 = 'different'; }, /changed ABI/],
    [value => { delete value.variants[1].gas.mintCrates1; }, /coverage changed/],
    [value => { value.benchmarkCount++; }, /benchmark count changed/],
    [value => { value.writeBenchmarkCount++; }, /classification changed/],
    [value => { value.variants[1].gas.mintCrates1 = 0; }, /Invalid gas measurement/],
    [value => { value.variants[0].gas.mintCrates1 = -1; }, /Invalid gas measurement/],
    [value => { value.variants[1].gas.mintCrates1 = NaN; }, /Invalid gas measurement/],
    [value => { value.variants[1].gas.mintCrates1 = Infinity; }, /Invalid gas measurement/],
    [value => { value.variants[1].gas.mintCrates1 = 1.5; }, /Invalid gas measurement/],
    [value => { value.variants[1].gas.mintCrates1 = Number.MAX_SAFE_INTEGER + 1; }, /Invalid gas measurement/],
    [value => { value.reproduction.fixedSettings.solc = '0.8.30'; }, /settings changed/],
    [value => { value.variants[1].artifacts.NFT111K.compilerVersion = '0.8.30+commit'; }, /Artifact compiler changed/],
    [value => { value.variants[1].artifacts.NFT111K.compilerSettings.optimizer.runs = 500; }, /Artifact compiler settings changed/],
    [value => { value.variants[1].artifacts.NFT111K.compilerSettings.viaIR = false; }, /Artifact compiler settings changed/],
    [value => { value.variants[1].artifacts.NFT111K.runtimeBytes = 24577; }, /Runtime exceeds/],
    [value => { value.variants[1].artifacts.NFT111K.creationBytes = 49152; }, /Initcode exceeds/],
    [value => { value.variants[0].artifacts.NFT111K.runtimeBytes = NaN; }, /Invalid runtime measurement/],
    [value => { value.variants[0].artifacts.NFT111K.creationBytes = -1; }, /Invalid initcode measurement/],
    [value => { value.reproduction.maximumCollectionArgumentBytes = -1; }, /Initcode exceeds/],
    [value => { value.variants[1].viaIR = false; }, /coverage changed/],
    [value => { value.variants.push(structuredClone(value.variants[1])); }, /coverage changed/],
    [value => { value.reproduction.deployment.codeSizeLimit = 100000; }, /Normal deployment limits changed/],
    [value => { delete value.variants[1].deploymentTransactions; }, /deployment receipt/],
    [value => { value.variants[1].deploymentTransactions.collection.status = '0x0'; }, /deployment receipt/],
    [value => { value.variants[1].deploymentTransactions.collection.runtimeBytes--; }, /deployment receipt/],
    [value => { value.variants[1].deploymentTransactions.collection.gasUsed = 0; }, /deployment receipt/],
    [value => { value.variants[1].deploymentTransactions.collection.address = '0x' + '0'.repeat(40); }, /deployment receipt/],
    [value => { value.variants[1].deploymentTransactions.collection.constructorArgumentBytes = 50000; }, /deployment receipt/],
  ];
  for (const [change, message] of cases) {
    const comparison = comparisonFixture();
    change(comparison);
    assert.throws(() => createIRReport(comparison, {}), message);
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
    value => { value.settings.candidateRuns = 500; },
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
