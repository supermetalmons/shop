import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCurrentCompilerBaseline, assertCurrentCompilerReport, compilerGateSettings, createCompilerGateReport } from './compiler-gate.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(root, '../..');
const args = process.argv.slice(2);
if (args.length > 1) throw new Error('Usage: node scripts/check-registered-compiler.mjs [--check|output.json]');
const checkOnly = args[0] === '--check';
const pipeline = compilerGateSettings.viaIR ? 'ir' : 'legacy';
const defaultOutput = join(root,
  `benchmarks/compiler-solc-${compilerGateSettings.solc}-${pipeline}-${compilerGateSettings.candidateRuns}-comparison.json`);
const output = resolve(checkOnly || !args.length ? defaultOutput : args[0]);
assert.ok(output === defaultOutput || !output.startsWith(`${repository}/`), 'Custom reports must be outside the repository');
assert.deepEqual(Object.keys(process.env).filter(name => /^(FOUNDRY_|DAPP_)/.test(name)), [], 'Remove FOUNDRY_/DAPP_ overrides');
const config = JSON.parse(execFileSync('forge', ['config', '--json'], { cwd: root, encoding: 'utf8' }));
assert.deepEqual([config.solc, config.optimizer, config.optimizer_runs, config.via_ir, config.evm_version, config.bytecode_hash],
  [compilerGateSettings.solc, true, compilerGateSettings.candidateRuns, compilerGateSettings.viaIR,
    compilerGateSettings.evm, compilerGateSettings.bytecodeHash]);
const hash = value => createHash('sha256').update(value).digest('hex');
const read = path => readFileSync(path, 'utf8');
const protectedPaths = ['src/NFT111K.sol', 'test/NFT111KGas.t.sol', 'test/TestSupport.sol', 'foundry.toml', 'package-lock.json',
  'scripts/benchmark-compiler.mjs', 'scripts/compiler-gate.mjs', 'snapshots/NFT111KGasTest.json'];
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
  execFileSync(process.execPath, ['scripts/benchmark-compiler.mjs', 'comparison.json', pipeline,
    String(compilerGateSettings.candidateRuns), '--update-baseline'],
    { cwd: temporary, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
  const comparison = JSON.parse(read(join(temporary, 'comparison.json')));
  const baselinePath = comparison.baselineReference.path;
  assertCurrentCompilerBaseline(JSON.parse(read(join(root, baselinePath))), JSON.parse(read(join(temporary, baselinePath))));
  const after = snapshot();
  assert.deepEqual(after, before, 'Benchmark inputs changed during compiler comparison');
  const report = createCompilerGateReport(comparison,
    { before, after, scriptSha256: hash(read(fileURLToPath(import.meta.url))) });
  const candidate = comparison.variants.find(value => value.optimizerRuns === compilerGateSettings.candidateRuns &&
    value.viaIR === compilerGateSettings.viaIR);
  if (checkOnly) {
    assertCurrentCompilerReport(JSON.parse(read(defaultOutput)), report);
  } else {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify({ status: report.status, cases: report.caseCount, runtimeBytes: candidate.artifacts.NFT111K.runtimeBytes,
    headroomBytes: 24576 - candidate.artifacts.NFT111K.runtimeBytes, gatedCases: report.gatedCaseCount,
    worstWritePercentage: report.worstWritePercentage, worstReadPercentage: report.worstReadPercentage,
    violations: report.violations, readOnlyIncreasesOverOnePercent: report.readOnlyIncreasesOverOnePercent,
    ...(checkOnly ? {} : { report: output }) }, null, 2));
  assert.equal(report.status, 'passed', 'The selected compiler exceeds the write gas regression budget');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
