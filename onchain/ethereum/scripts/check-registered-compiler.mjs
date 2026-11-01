import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareGas } from './gas-comparison.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(root, '../..');
const args = process.argv.slice(2);
if (args.length > 1) throw new Error('Usage: node scripts/check-registered-compiler.mjs [--check|output.json]');
const checkOnly = args[0] === '--check';
const defaultOutput = join(root, 'benchmarks/relic-claims-compiler-200-comparison.json');
const output = resolve(checkOnly || !args.length ? defaultOutput : args[0]);
assert.ok(output === defaultOutput || !output.startsWith(`${repository}/`), 'Custom reports must be outside the repository');
assert.deepEqual(Object.keys(process.env).filter(name => /^(FOUNDRY_|DAPP_)/.test(name)), [], 'Remove FOUNDRY_/DAPP_ overrides');
const config = JSON.parse(execFileSync('forge', ['config', '--json'], { cwd: root, encoding: 'utf8' }));
assert.deepEqual([config.solc, config.optimizer, config.optimizer_runs, config.via_ir, config.evm_version, config.bytecode_hash],
  ['0.8.30', true, 200, false, 'prague', 'none']);
const hash = value => createHash('sha256').update(value).digest('hex');
const read = path => readFileSync(path, 'utf8');
const protectedPaths = ['src/NFT111K.sol', 'test/NFT111KGas.t.sol', 'test/TestSupport.sol', 'foundry.toml', 'package-lock.json',
  'scripts/benchmark-compiler.mjs', 'snapshots/NFT111KGasTest.json'];
const snapshot = () => Object.fromEntries(protectedPaths.map(path => [path, hash(read(join(root, path)))]));
const before = snapshot();
const temporary = mkdtempSync(join(tmpdir(), '111k-registered-compiler-'));
try {
  for (const name of ['src', 'fixtures/discounts', 'snapshots']) cpSync(join(root, name), join(temporary, name), { recursive: true });
  for (const name of ['scripts', 'test', 'benchmarks']) mkdirSync(join(temporary, name));
  for (const name of ['package.json', 'package-lock.json', 'scripts/benchmark-compiler.mjs', 'test/NFT111KGas.t.sol', 'test/TestSupport.sol']) {
    cpSync(join(root, name), join(temporary, name));
  }
  symlinkSync(join(root, 'node_modules'), join(temporary, 'node_modules'), 'dir');
  const gitDirectory = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: root, encoding: 'utf8' }).trim();
  symlinkSync(gitDirectory, join(temporary, '.git'), 'dir');
  execFileSync(process.execPath, ['scripts/benchmark-compiler.mjs', 'comparison.json', 'legacy', '200', '500', '--update-baseline'],
    { cwd: temporary, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
  const comparison = JSON.parse(read(join(temporary, 'comparison.json')));
  const candidate = comparison.variants.find(value => value.optimizerRuns === 200 && !value.viaIR);
  const reference = comparison.variants.find(value => value.optimizerRuns === 500 && !value.viaIR);
  assert.ok(candidate && reference && comparison.variants.length === 2, 'Compiler coverage changed');
  assert.equal(candidate.status, 'measured');
  assert.equal(reference.status, 'measured');
  assert.equal(candidate.artifacts.NFT111K.canonicalAbiSha256, reference.artifacts.NFT111K.canonicalAbiSha256);
  assert.deepEqual(candidate.sourceSha256, reference.sourceSha256, 'Compiler variants changed source');
  assert.ok(candidate.comparison.withinDeploymentSizeLimits && reference.comparison.withinDeploymentSizeLimits);
  const names = Object.keys(candidate.gas).sort();
  assert.deepEqual(names, Object.keys(reference.gas).sort());
  const rows = names.map(name => ({ name, reference: reference.gas[name], candidate: candidate.gas[name],
    delta: candidate.gas[name] - reference.gas[name], percent: (candidate.gas[name] - reference.gas[name]) * 100 / reference.gas[name] }));
  const isRead = name => /^(get|preview|stats$|allocatedCrates$|warehousesMinted$)/.test(name);
  const writeRows = rows.filter(row => !isRead(row.name));
  const readRows = rows.filter(row => isRead(row.name));
  assert.equal(writeRows.length, comparison.writeBenchmarkCount, 'Write benchmark classification changed');
  const exceedsBudget = row => BigInt(row.candidate) * 100n >= BigInt(row.reference) * 101n;
  const violations = writeRows.filter(exceedsBudget);
  const readOnlyIncreasesOverOnePercent = readRows.filter(exceedsBudget);
  const after = snapshot();
  assert.deepEqual(after, before, 'Benchmark inputs changed during compiler comparison');
  const report = { schemaVersion: 1, status: violations.length ? 'failed' : 'passed',
    method: 'Identical relic claim availability source compiled at200 and500optimizer runs. One fixed200-run harness deploys each compiled artifact at the same addresses. '
      + 'All measured writes, including every redemption, use the strict less-than1percent gate. Read-only execution costs are reported separately and do not gate release. Deployment gas comes from local Prague Anvil receipts. '
      + 'Temporary baseline regeneration does not modify repository snapshots or historical reports.',
    settings: { solc: '0.8.30', evm: 'prague', viaIR: false, bytecodeHash: 'none', referenceRuns: 500, candidateRuns: 200 },
    threshold: 'candidateGas *100 < referenceGas *101', gateScope: 'all measured state-changing operations',
    caseCount: rows.length, gatedCaseCount: writeRows.length, violations, readOnlyIncreasesOverOnePercent,
    worstPercentage: rows.reduce((worst, row) => row.percent > worst.percent ? row : worst),
    worstWritePercentage: writeRows.reduce((worst, row) => row.percent > worst.percent ? row : worst),
    worstReadPercentage: readRows.reduce((worst, row) => row.percent > worst.percent ? row : worst), rows,
    provenance: { before, after, scriptSha256: hash(read(fileURLToPath(import.meta.url))) }, comparison };
  if (!checkOnly) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify({ status: report.status, cases: rows.length, runtimeBytes: candidate.artifacts.NFT111K.runtimeBytes,
    headroomBytes: 24576 - candidate.artifacts.NFT111K.runtimeBytes, gatedCases: writeRows.length,
    worstWritePercentage: report.worstWritePercentage, worstReadPercentage: report.worstReadPercentage,
    violations, readOnlyIncreasesOverOnePercent, ...(checkOnly ? {} : { report: output }) }, null, 2));
    const writeGas = gas => Object.fromEntries(writeRows.map(row => [row.name, gas[row.name]]));
  compareGas(writeGas(reference.gas), writeGas(candidate.gas), writeRows.map(row => row.name), 'registered200-vs500-writes');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
