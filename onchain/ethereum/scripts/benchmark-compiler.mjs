import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode } from '@metamask/abi-utils';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arguments_ = process.argv.slice(2);
const updateBaseline = arguments_.includes('--update-baseline');
assert.ok(arguments_.filter(value => value === '--update-baseline').length <= 1, 'Duplicate --update-baseline flag');
const [output, pipelineArgument, ...runArguments] = arguments_.filter(value => value !== '--update-baseline');
if (!output || (pipelineArgument && !['legacy', 'ir'].includes(pipelineArgument))) {
  throw new Error('Usage: node scripts/benchmark-compiler.mjs <output.json> [legacy|ir] [runs...] [--update-baseline]');
}
const defaultRuns = { legacy: [1, 50, 200, 500, 1000, 1500, 2000, 5000, 10000], ir: [1, 50, 200, 1000, 10000] };
const requestedRuns = runArguments.length ? [...new Set(runArguments.map(Number))] : undefined;
assert.ok(!requestedRuns || requestedRuns.every(value => Number.isSafeInteger(value) && value > 0), 'Runs must be positive integers');
const pipelines = pipelineArgument ? [pipelineArgument] : ['legacy', 'ir'];
const outputPath = resolve(output);
const read = path => readFileSync(path, 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const environment = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => !name.startsWith('FOUNDRY_') && !name.startsWith('DAPP_')));
const run = (directory, args) => execFileSync('forge', args, {
  cwd: directory, env: environment, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
});
const harnessName = 'NFT111KCompilerGasTest';
const testCommand = ['test', '--offline', '--isolate', '--match-contract', `^${harnessName}$`,
  '--gas-snapshot-check=false', '--gas-snapshot-emit=false', '--json'];
const names = ['NFT111K', 'NFT111KUrlRenderer'];
const baselinePath = join(packageRoot, 'benchmarks/compiler-legacy-200.json');
assert.notEqual(outputPath, baselinePath, 'The report output must differ from the checked-in baseline');
const committedSnapshots = JSON.parse(read(join(packageRoot, 'snapshots/NFT111KGasTest.json')));
const expectedNames = Object.keys(committedSnapshots).sort((a, b) => a.localeCompare(b));
const sourceNames = [...read(join(packageRoot, 'test/NFT111KGas.t.sol')).matchAll(/\bfunction\s+testGas([A-Z]\w*)\s*\(\s*\)/g)]
  .map(([, name]) => name[0].toLowerCase() + name.slice(1)).sort((a, b) => a.localeCompare(b));
assert.ok(sourceNames.length > 0 && new Set(sourceNames).size === sourceNames.length, 'Gas benchmark names are missing or duplicated');
assert.deepEqual(expectedNames, sourceNames, 'Committed gas snapshots must cover every benchmark');
const baselineReference = updateBaseline ? undefined : JSON.parse(read(baselinePath));
if (baselineReference) {
  assert.equal(baselineReference.schemaVersion, 1, 'Unsupported compiler baseline schema');
  assert.deepEqual(Object.keys(baselineReference.gas), expectedNames, 'Compiler baseline benchmark names changed');
}
const temporaryRoot = mkdtempSync(join(tmpdir(), '111k-compiler-'));
const writeNames = expectedNames.filter(name => /^(mint|unbox|deliver|claim|release)/.test(name));
const progress = message => process.stderr.write(message + '\n');
const save = report => writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
const sourceHashes = directory => Object.fromEntries(readdirSync(join(directory, 'src'))
  .filter(name => name.endsWith('.sol')).sort().map(name => [name, hash(read(join(directory, 'src', name)))]));

function createProject(label, viaIR = false, optimizerRuns = 200) {
  const directory = join(temporaryRoot, label);
  mkdirSync(directory);
  cpSync(join(packageRoot, 'src'), join(directory, 'src'), { recursive: true });
  cpSync(join(packageRoot, 'fixtures/discounts'), join(directory, 'fixtures/discounts'), { recursive: true });
  symlinkSync(join(packageRoot, 'node_modules'), join(directory, 'node_modules'), 'dir');
  writeFileSync(join(directory, 'foundry.toml'), `[profile.default]
src = "src"
test = "test"
out = "out"
cache_path = "cache"
libs = ["node_modules"]
solc_version = "0.8.30"
optimizer = true
optimizer_runs = ${optimizerRuns}
via_ir = ${viaIR}
evm_version = "prague"
bytecode_hash = "none"
gas_snapshot_emit = false
fs_permissions = [{ access = "read", path = "./candidate" }, { access = "read", path = "./fixtures" }]
`);
  return directory;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function compiledArtifact(directory, name) {
  return JSON.parse(read(join(directory, 'out', `${name}.sol`, `${name}.json`)));
}

function describeArtifact(directory, name) {
  const artifact = compiledArtifact(directory, name);
  const metadata = typeof artifact.metadata === 'string' ? JSON.parse(artifact.metadata) : artifact.metadata;
  const abi = artifact.abi.map(entry => JSON.stringify(canonical(entry))).sort();
  return {
    compilerVersion: metadata.compiler.version,
    compilerSettings: metadata.settings,
    creationBytes: artifact.bytecode.object.replace(/^0x/, '').length / 2,
    runtimeBytes: artifact.deployedBytecode.object.replace(/^0x/, '').length / 2,
    creationSha256: hash(artifact.bytecode.object),
    runtimeTemplateSha256: hash(artifact.deployedBytecode.object),
    canonicalAbiSha256: hash(JSON.stringify(abi)),
  };
}

function prepareHarness() {
  const directory = createProject('harness');
  mkdirSync(join(directory, 'test'));
  mkdirSync(join(directory, 'candidate'));
  const harness = `pragma solidity 0.8.30;

import {NFT111KGasTest} from "./NFT111KGas.t.sol";
import {NFT111K} from "../src/NFT111K.sol";

interface CompilerVm {
    function getCode(string calldata artifactPath) external returns (bytes memory);
}

contract ${harnessName} is NFT111KGasTest {
    function _deployCollection(address[] memory recipients, uint256[] memory shares)
        internal
        override
        returns (NFT111K)
    {
        address renderer = _deployCandidate("NFT111KUrlRenderer", abi.encode("https://cdn.mons.shop/111k-sepolia/"));
        return NFT111K(_deployCandidate("NFT111K", abi.encode(
            address(this), vm.addr(SIGNER_KEY), payable(address(0xBEEF)), renderer, bytes32(0), recipients, shares
        )));
    }

    function _deployCandidate(string memory name, bytes memory arguments) private returns (address deployed) {
        bytes memory code = abi.encodePacked(CompilerVm(address(vm)).getCode(string.concat("candidate/", name, ".json")), arguments);
        assembly { deployed := create(0, add(code, 32), mload(code)) }
        require(deployed != address(0), "candidate deployment failed");
    }
}
`;
  for (const name of ['NFT111KGas.t.sol', 'TestSupport.sol']) {
    cpSync(join(packageRoot, 'test', name), join(directory, 'test', name));
  }
  writeFileSync(join(directory, 'test', `${harnessName}.t.sol`), harness);
  run(directory, ['build', '--offline']);
  return { directory, sha256: hash(harness), testSupportSha256: hash(read(join(directory, 'test/TestSupport.sol'))) };
}

function measurements(directory, harnessDirectory) {
  for (const name of names) {
    cpSync(join(directory, 'out', `${name}.sol`, `${name}.json`), join(harnessDirectory, 'candidate', `${name}.json`));
  }
  const suites = JSON.parse(run(harnessDirectory, testCommand));
  assert.deepEqual(Object.keys(suites), [`test/${harnessName}.t.sol:${harnessName}`], 'Unexpected benchmark suite');
  const results = Object.values(suites)[0].test_results;
  assert.equal(Object.keys(results).length, expectedNames.length, 'Missing benchmark results');
  const values = {};
  for (const [testName, result] of Object.entries(results)) {
    assert.equal(result.status, 'Success', `${testName} failed: ${result.reason ?? ''}`);
    const groups = Object.entries(result.gas_snapshots);
    assert.equal(groups.length, 1, `${testName}: unexpected snapshot groups`);
    assert.equal(groups[0][0], harnessName, `${testName}: unexpected snapshot group`);
    const entries = Object.entries(groups[0][1]);
    assert.equal(entries.length, 1, `${testName}: unexpected snapshot count`);
    const [name, value] = entries[0];
    assert.equal(testName, `testGas${name[0].toUpperCase() + name.slice(1)}()`, 'Snapshot/test name mismatch');
    assert.ok(expectedNames.includes(name) && !Object.hasOwn(values, name), 'Unknown or duplicate gas snapshot');
    values[name] = Number(value);
    assert.ok(Number.isSafeInteger(values[name]) && values[name] > 0, 'Invalid gas snapshot');
  }
  return Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
}

function collectionArguments(owner, renderer, recipientCount = 4) {
  const recipients = Array.from({ length: recipientCount }, (_, index) =>
    `0x${(0xA00001 + index).toString(16).padStart(40, '0')}`);
  const shares = recipientCount === 4 ? [5000, 2500, 1500, 1000] : Array(recipientCount).fill(1250);
  return Buffer.from(encode(['address', 'address', 'address', 'address', 'bytes32', 'address[]', 'uint256[]'],
    [owner, '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf', '0x000000000000000000000000000000000000beef',
      renderer, `0x${'0'.repeat(64)}`, recipients, shares])).toString('hex');
}

const maximumCollectionArgumentBytes = collectionArguments(
  '0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002', 8).length / 2;

async function deploymentMeasurements(variants) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337',
    '--hardfork', 'prague', '--silent'], { stdio: 'ignore' });
  let startupError;
  anvil.on('error', error => { startupError = error; });
  let id = 0;
  const rpc = async (method, params = []) => {
    if (startupError) throw startupError;
    const response = await fetch(`http://127.0.0.1:${port}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(2000) });
    const body = await response.json();
    if (body.error) throw new Error(JSON.stringify(body.error));
    return body.result;
  };
  const delay = () => new Promise(resolve => setTimeout(resolve, 25));
  try {
    let accounts;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { accounts = await rpc('eth_accounts'); break; }
      catch (error) {
        if (startupError || anvil.exitCode !== null || attempt === 99) throw error;
        await delay();
      }
    }
    const wallet = accounts[0];
    let snapshot = await rpc('evm_snapshot');
    for (const variant of variants) {
      assert.equal(await rpc('evm_revert', [snapshot]), true);
      snapshot = await rpc('evm_snapshot');
      const deploy = async (name, args = '') => {
        const artifact = compiledArtifact(join(temporaryRoot, variant.label), name);
        const data = artifact.bytecode.object + args;
        const transaction = await rpc('eth_sendTransaction', [{ from: wallet, data, gas: '0x989680' }]);
        let receipt;
        for (let attempt = 0; attempt < 100; attempt++) {
          receipt = await rpc('eth_getTransactionReceipt', [transaction]);
          if (receipt) break;
          await delay();
        }
        assert.equal(receipt?.status, '0x1', `${variant.label}: deployment failed`);
        return { address: receipt.contractAddress, gasUsed: Number(BigInt(receipt.gasUsed)), constructorArgumentBytes: args.length / 2 };
      };
      const renderer = await deploy('NFT111KUrlRenderer',
        Buffer.from(encode(['string'], ['https://cdn.mons.shop/111k-sepolia/'])).toString('hex'));
      const args = collectionArguments(wallet, renderer.address);
      variant.deploymentTransactions = { renderer, collection: await deploy('NFT111K', args) };
    }
  } finally {
    if (anvil.exitCode === null && !startupError) {
      await new Promise(resolve => { anvil.once('exit', resolve); anvil.kill('SIGTERM'); });
    }
  }
}

function summarize(candidate, baseline) {
  const deltas = Object.fromEntries(expectedNames.map(name => [name, candidate.gas[name] - baseline.gas[name]]));
  const regressions = Object.keys(deltas).filter(name => deltas[name] > 0);
  const improvements = Object.keys(deltas).filter(name => deltas[name] < 0);
  return {
    deltas,
    improvementCount: improvements.length,
    regressionCount: regressions.length,
    writeImprovementCount: writeNames.filter(name => deltas[name] < 0).length,
    writeRegressionCount: writeNames.filter(name => deltas[name] > 0).length,
    writeRegressions: writeNames.filter(name => deltas[name] > 0),
    worstWriteRegression: Math.max(0, ...writeNames.map(name => deltas[name])),
    abiUnchanged: names.every(name => candidate.artifacts[name].canonicalAbiSha256 === baseline.artifacts[name].canonicalAbiSha256),
    withinDeploymentSizeLimits: names.every(name => candidate.artifacts[name].runtimeBytes <= 24576 &&
      candidate.artifacts[name].creationBytes + (name === 'NFT111K' ? maximumCollectionArgumentBytes : 0) <= 49152),
    withinProjectSizeBudgets: candidate.artifacts.NFT111KUrlRenderer.runtimeBytes <= 12 * 1024,
  };
}

const report = {
  schemaVersion: 2,
  measuredAt: new Date().toISOString(),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: packageRoot, encoding: 'utf8' }).trim(),
  sourceSha256: sourceHashes(packageRoot),
  baselineReference: { path: 'benchmarks/compiler-legacy-200.json', updated: updateBaseline },
  benchmarkCount: expectedNames.length,
  writeBenchmarkCount: writeNames.length,
  toolchain: {
    forge: execFileSync('forge', ['--version'], { encoding: 'utf8' }).trim(),
    anvil: execFileSync('anvil', ['--version'], { encoding: 'utf8' }).trim(),
    node: process.version,
    dependencies: Object.fromEntries(Object.keys(JSON.parse(read(join(packageRoot, 'package.json'))).devDependencies)
      .map(name => [name, JSON.parse(read(join(packageRoot, 'node_modules', name, 'package.json'))).version])),
    packageLockSha256: hash(read(join(packageRoot, 'package-lock.json'))),
  },
  reproduction: {
    command: 'node scripts/benchmark-compiler.mjs <output.json> [legacy|ir] [runs...] [--update-baseline]',
    defaultRuns,
    requestedMatrix: Object.fromEntries(pipelines.map(pipeline => [pipeline, requestedRuns ?? defaultRuns[pipeline]])),
    scriptSha256: hash(read(fileURLToPath(import.meta.url))),
    fixedSettings: { solc: '0.8.30', optimizer: true, evmVersion: 'prague', bytecodeHash: 'none' },
    maximumCollectionArgumentBytes,
    harness: 'All variants use one legacy/200 harness and MinimalGasReceiver. Candidate creation bytecode is loaded with vm.getCode and deployed using CREATE in the original order, preserving addresses and signed calldata.',
    measurement: `All ${expectedNames.length} measurements use Forge --isolate. Write measurements include transaction intrinsic/calldata gas and refunds; Separate benchmarks sum 15 isolated single-unpack calls with snapshotValue. Read measurements are callee STATICCALL execution. Setup and harness gas are excluded. Deployment gas comes from actual Prague Anvil receipts, reverting to identical account state and nonces for each variant.`,
    environment: 'FOUNDRY_* and DAPP_* overrides are removed for isolated builds. Tracked sources and normal gas snapshots are never modified. The compiler baseline is rewritten only with --update-baseline.',
  },
  variants: [],
};

try {
  const harness = prepareHarness();
  report.reproduction.harnessSha256 = harness.sha256;
  report.reproduction.testSupportSha256 = harness.testSupportSha256;
  const measure = (label, viaIR, optimizerRuns) => {
    progress(`Measuring ${label}`);
    const directory = createProject(label, viaIR, optimizerRuns);
    const variant = { label, viaIR, optimizerRuns, sourceSha256: sourceHashes(directory), status: 'pending' };
    report.variants.push(variant);
    assert.deepEqual(variant.sourceSha256, report.sourceSha256, 'Sources changed during the benchmark');
    try {
      run(directory, ['build', '--offline']);
    } catch (error) {
      variant.status = 'compile-failed';
      variant.error = String(error.stderr || error.stdout || error.message).trim();
      return variant;
    }
    variant.artifacts = Object.fromEntries(names.map(name => [name, describeArtifact(directory, name)]));
    try {
      variant.gas = measurements(directory, harness.directory);
      variant.status = 'measured';
    } catch (error) {
      variant.status = 'benchmark-failed';
      variant.error = String(error.stderr || error.stdout || error.message).trim();
    }
    return variant;
  };
  const provenance = {
    sourceSha256: report.sourceSha256,
    gasTestSha256: hash(read(join(packageRoot, 'test/NFT111KGas.t.sol'))),
    harnessSha256: harness.sha256,
    testSupportSha256: harness.testSupportSha256,
    packageLockSha256: report.toolchain.packageLockSha256,
    discountProofSha256: hash(read(join(packageRoot, 'fixtures/discounts/proof.json'))),
    dependencies: report.toolchain.dependencies,
    forge: report.toolchain.forge,
    fixedSettings: report.reproduction.fixedSettings,
    viaIR: false,
    optimizerRuns: 200,
  };
  if (baselineReference) {
    assert.deepEqual(baselineReference.provenance, provenance,
      'Compiler baseline provenance changed; review the changes and regenerate explicitly with --update-baseline');
  }
  const baseline = measure('legacy-200', false, 200);
  assert.equal(baseline.status, 'measured', baseline.error ?? 'Baseline failed');
  if (updateBaseline) {
    writeFileSync(baselinePath, JSON.stringify({
      schemaVersion: 1,
      measuredAt: report.measuredAt,
      sourceCommit: report.sourceCommit,
      provenance,
      artifacts: baseline.artifacts,
      gas: baseline.gas,
    }, null, 2) + '\n');
  } else {
    assert.deepEqual(baseline.artifacts, baselineReference.artifacts, 'Compiler baseline artifacts changed');
  }
  const expected = updateBaseline ? baseline.gas : baselineReference.gas;
  const mismatches = expectedNames.filter(name => expected[name] !== baseline.gas[name]);
  report.baselineReference.sha256 = hash(read(baselinePath));
  report.baseline = { label: baseline.label, validation: updateBaseline ? 'regenerated' : 'reproduced',
    snapshotCount: expectedNames.length, mismatches };
  assert.deepEqual(mismatches, [], 'Baseline does not reproduce the checked-in compiler baseline');
  for (const pipeline of pipelines) {
    for (const optimizerRuns of requestedRuns ?? defaultRuns[pipeline]) {
      const label = `${pipeline}-${optimizerRuns}`;
      const variant = label === baseline.label ? baseline : measure(label, pipeline === 'ir', optimizerRuns);
      if (variant.status === 'measured') variant.comparison = summarize(variant, baseline);
      save(report);
    }
  }
  const measured = report.variants.filter(variant => variant.status === 'measured');
  await deploymentMeasurements(measured);
  for (const variant of measured) {
    variant.comparison ??= summarize(variant, baseline);
    variant.comparison.deploymentDeltas = Object.fromEntries(['renderer', 'collection'].map(name =>
      [name, variant.deploymentTransactions[name].gasUsed - baseline.deploymentTransactions[name].gasUsed]));
  }
  report.status = 'complete';
  save(report);
  progress(JSON.stringify(measured.map(({ label, comparison }) => ({ label,
    writeImprovements: comparison.writeImprovementCount, writeRegressions: comparison.writeRegressionCount,
    deploymentDeltas: comparison.deploymentDeltas }))));
  if (report.variants.some(variant => variant.status !== 'measured')) process.exitCode = 1;
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  save(report);
  throw error;
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
