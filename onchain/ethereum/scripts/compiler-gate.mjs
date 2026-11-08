import assert from 'node:assert/strict';

export const compilerGateSettings = Object.freeze({
  solc: '0.8.38', evm: 'prague', viaIR: false, bytecodeHash: 'none', referenceRuns: 200, candidateRuns: 200,
});

export function createCompilerGateReport(comparison, provenance, candidateSettings = compilerGateSettings) {
  const settings = { ...compilerGateSettings, candidateRuns: candidateSettings.candidateRuns, viaIR: candidateSettings.viaIR };
  assert.ok(Number.isSafeInteger(settings.candidateRuns) && settings.candidateRuns > 0 && typeof settings.viaIR === 'boolean',
    'Invalid candidate compiler settings');
  assert.equal(comparison.status, 'complete', 'Compiler comparison did not complete');
  assert.deepEqual(comparison.reproduction.fixedSettings,
    { solc: compilerGateSettings.solc, optimizer: true, evmVersion: compilerGateSettings.evm, bytecodeHash: 'none' },
    'Compiler settings changed');
  const candidate = comparison.variants.find(value => value.optimizerRuns === settings.candidateRuns &&
    value.viaIR === settings.viaIR);
  const reference = comparison.variants.find(value => value.optimizerRuns === compilerGateSettings.referenceRuns && !value.viaIR);
  const variants = new Set([candidate, reference]);
  assert.ok(candidate && reference && comparison.variants.length === variants.size, 'Compiler coverage changed');
  for (const variant of variants) {
    assert.equal(variant.status, 'measured');
    assert.deepEqual(variant.sourceSha256, comparison.sourceSha256, 'Compiler variants changed source');
    const artifact = variant.artifacts.NFT111K;
    assert.ok(artifact.compilerVersion?.startsWith(`${compilerGateSettings.solc}+`), 'Artifact compiler changed');
    assert.deepEqual([artifact.compilerSettings?.optimizer, artifact.compilerSettings?.viaIR ?? false,
      artifact.compilerSettings?.evmVersion, artifact.compilerSettings?.metadata?.bytecodeHash],
    [{ enabled: true, runs: variant.optimizerRuns }, variant.viaIR, compilerGateSettings.evm, compilerGateSettings.bytecodeHash],
    'Artifact compiler settings changed');
    assert.ok(Number.isSafeInteger(artifact.runtimeBytes) && artifact.runtimeBytes > 0,
      'Invalid runtime measurement');
    assert.ok(Number.isSafeInteger(artifact.creationBytes) && artifact.creationBytes > 0,
      'Invalid initcode measurement');
  }
  const artifact = candidate.artifacts.NFT111K;
  const maximumArguments = comparison.reproduction.maximumCollectionArgumentBytes;
  assert.ok(artifact.runtimeBytes <= 24576, 'Runtime exceeds deployment size limit');
  assert.ok(Number.isSafeInteger(maximumArguments) && maximumArguments >= 0 &&
    artifact.creationBytes + maximumArguments <= 49152, 'Initcode exceeds deployment size limit');
  assert.deepEqual(comparison.reproduction.deployment,
    { engine: 'anvil', hardfork: 'prague', codeSizeLimit: 24576, initcodeSizeLimit: 49152 },
    'Normal deployment limits changed');
  const receipt = candidate.deploymentTransactions?.collection;
  assert.ok(receipt?.status === '0x1' && /^0x[0-9a-fA-F]{40}$/.test(receipt.address) &&
    !/^0x0{40}$/.test(receipt.address) && Number.isSafeInteger(receipt.gasUsed) && receipt.gasUsed > 0 &&
    Number.isSafeInteger(receipt.constructorArgumentBytes) && receipt.constructorArgumentBytes > 0 &&
    receipt.constructorArgumentBytes <= maximumArguments && receipt.runtimeBytes === artifact.runtimeBytes,
  'Selected compiler requires a successful normal-limit deployment receipt');
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
  const isRead = name => /^(get|preview|stats$|publicRelicStats|allocatedCrates$|warehousesMinted$)/.test(name);
  const writeRows = rows.filter(row => !isRead(row.name));
  const readRows = rows.filter(row => isRead(row.name));
  assert.equal(writeRows.length, comparison.writeBenchmarkCount, 'Write benchmark classification changed');
  assert.ok(writeRows.length && readRows.length, 'Read and write benchmarks are required');
  const exceedsBudget = row => BigInt(row.candidate) * 100n >= BigInt(row.reference) * 101n;
  const violations = writeRows.filter(exceedsBudget);
  const worst = values => values.reduce((result, row) => row.percent > result.percent ? row : result);
  return {
    schemaVersion: 2,
    status: violations.length ? 'failed' : 'passed',
    method: `Identical current source compiled with Solidity ${compilerGateSettings.solc}. `
      + `The selected ${settings.viaIR ? 'IR' : 'legacy'}/${settings.candidateRuns} build is compared `
      + `with the legacy/${compilerGateSettings.referenceRuns} reference using one fixed 200-run harness and receiver. `
      + 'All measured writes, including every redemption, use the strict less-than-1-percent gate. '
      + 'Read-only execution costs are reported separately and do not gate release. '
      + 'Only the gas-reference build may exceed deployment size limits in the isolated harness. '
      + 'The selected build must fit runtime and initcode limits and have a successful normal-limit Prague Anvil deployment receipt. '
      + 'Temporary baseline regeneration does not modify repository snapshots or historical reports.',
    settings,
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
