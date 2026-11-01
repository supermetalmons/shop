import assert from 'node:assert/strict';

export const compilerGateSettings = Object.freeze({
  solc: '0.8.38', evm: 'prague', viaIR: false, bytecodeHash: 'none', referenceRuns: 200, candidateRuns: 500,
});

export function createCompilerGateReport(comparison, provenance) {
  assert.equal(comparison.status, 'complete', 'Compiler comparison did not complete');
  assert.deepEqual(comparison.reproduction.fixedSettings,
    { solc: compilerGateSettings.solc, optimizer: true, evmVersion: compilerGateSettings.evm, bytecodeHash: 'none' },
    'Compiler settings changed');
  const candidate = comparison.variants.find(value => value.optimizerRuns === compilerGateSettings.candidateRuns && !value.viaIR);
  const reference = comparison.variants.find(value => value.optimizerRuns === compilerGateSettings.referenceRuns && !value.viaIR);
  assert.ok(candidate && reference && comparison.variants.length === 2, 'Compiler coverage changed');
  for (const variant of [candidate, reference]) {
    assert.equal(variant.status, 'measured');
    assert.deepEqual(variant.sourceSha256, comparison.sourceSha256, 'Compiler variants changed source');
    const artifact = variant.artifacts.NFT111K;
    assert.ok(Number.isSafeInteger(artifact.runtimeBytes) && artifact.runtimeBytes > 0 && artifact.runtimeBytes <= 24576,
      'Runtime exceeds deployment size limit');
    assert.ok(Number.isSafeInteger(artifact.creationBytes) && artifact.creationBytes > 0 &&
      Number.isSafeInteger(comparison.reproduction.maximumCollectionArgumentBytes) &&
      comparison.reproduction.maximumCollectionArgumentBytes >= 0 &&
      artifact.creationBytes + comparison.reproduction.maximumCollectionArgumentBytes <= 49152,
    'Initcode exceeds deployment size limit');
  }
  assert.equal(candidate.artifacts.NFT111K.canonicalAbiSha256, reference.artifacts.NFT111K.canonicalAbiSha256,
    'Compiler variants changed ABI');
  const names = Object.keys(candidate.gas).sort();
  assert.deepEqual(names, Object.keys(reference.gas).sort(), 'Compiler measurement coverage changed');
  assert.equal(names.length, comparison.benchmarkCount, 'Compiler benchmark count changed');
  const rows = names.map(name => {
    const before = reference.gas[name];
    const after = candidate.gas[name];
    assert.ok(Number.isSafeInteger(before) && before > 0 && Number.isSafeInteger(after) && after > 0,
      `Invalid gas measurement: ${name}`);
    return { name, reference: before, candidate: after, delta: after - before, percent: (after - before) * 100 / before };
  });
  const isRead = name => /^(get|preview|stats$|allocatedCrates$|warehousesMinted$)/.test(name);
  const writeRows = rows.filter(row => !isRead(row.name));
  const readRows = rows.filter(row => isRead(row.name));
  assert.equal(writeRows.length, comparison.writeBenchmarkCount, 'Write benchmark classification changed');
  assert.ok(writeRows.length && readRows.length, 'Read and write benchmarks are required');
  const exceedsBudget = row => BigInt(row.candidate) * 100n >= BigInt(row.reference) * 101n;
  const violations = writeRows.filter(exceedsBudget);
  const worst = values => values.reduce((result, row) => row.percent > result.percent ? row : result);
  return {
    schemaVersion: 1,
    status: violations.length ? 'failed' : 'passed',
    method: 'Identical current source compiled at 200 and 500 optimizer runs with Solidity 0.8.38. '
      + 'The selected 500-run build is compared with the 200-run reference using one fixed 200-run harness and receiver. '
      + 'All measured writes, including every redemption, use the strict less-than-1-percent gate. '
      + 'Read-only execution costs are reported separately and do not gate release. '
      + 'Deployment gas comes from local Prague Anvil receipts. '
      + 'Temporary baseline regeneration does not modify repository snapshots or historical reports.',
    settings: { ...compilerGateSettings },
    threshold: 'candidateGas * 100 < referenceGas * 101',
    gateScope: 'all measured state-changing operations',
    caseCount: rows.length,
    gatedCaseCount: writeRows.length,
    violations,
    readOnlyIncreasesOverOnePercent: readRows.filter(exceedsBudget),
    worstPercentage: worst(rows),
    worstWritePercentage: worst(writeRows),
    worstReadPercentage: worst(readRows),
    rows,
    provenance,
    comparison,
  };
}

export function assertCurrentCompilerReport(recorded, current) {
  const stable = report => {
    assert.ok(report?.comparison?.baselineReference, 'Compiler report is missing comparison provenance');
    const value = structuredClone(report);
    delete value.comparison.measuredAt;
    delete value.comparison.sourceCommit;
    delete value.comparison.baselineReference.sha256;
    delete value.comparison.toolchain.node;
    return value;
  };
  assert.deepEqual(stable(recorded), stable(current),
    'Compiler report is stale; review the changes and regenerate with npm run gas:compiler-gate');
}

export function assertCurrentCompilerBaseline(recorded, current) {
  const stable = baseline => {
    assert.ok(baseline?.provenance && baseline.artifacts && baseline.gas, 'Compiler baseline is missing measurements or provenance');
    const { measuredAt, sourceCommit, ...value } = baseline;
    return value;
  };
  assert.deepEqual(stable(recorded), stable(current),
    'Compiler baseline is stale; review the changes and regenerate with benchmark-compiler.mjs --update-baseline');
}
