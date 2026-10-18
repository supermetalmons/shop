import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [output, pipelineArgument, ...runArguments] = process.argv.slice(2);
if (!output || (pipelineArgument && !['legacy', 'ir'].includes(pipelineArgument))) {
  throw new Error('Usage: node scripts/benchmark-compiler.mjs <output.json> [legacy|ir] [runs...]');
}
const defaultRuns = { legacy: [1, 50, 200, 500, 1000, 1500, 2000, 5000, 10000], ir: [1, 50, 200, 1000, 10000] };
const requestedRuns = runArguments.length ? [...new Set(runArguments.map(Number))] : undefined;
assert.ok(!requestedRuns || requestedRuns.every(value => Number.isSafeInteger(value) && value > 0), 'Runs must be positive integers');
const pipelines = pipelineArgument ? [pipelineArgument] : ['legacy', 'ir'];
const outputPath = resolve(output);
const temporaryRoot = mkdtempSync(join(tmpdir(), 'mons111k-compiler-'));
const read = path => readFileSync(path, 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const environment = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => !name.startsWith('FOUNDRY_') && !name.startsWith('DAPP_')));
const run = (directory, args) => execFileSync('forge', args, {
  cwd: directory, env: environment, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
});
const testCommand = ['test', '--offline', '--isolate', '--match-contract', '^Mons111kGasTest$',
  '--gas-snapshot-check=false', '--gas-snapshot-emit=false', '--json'];
const names = ['Mons111k', 'Mons111kRenderer'];
const snapshotReferenceCommit = '7c2cdec3892d04b311b5c230415d129e4cf44ef8';
const snapshotReferencePath = 'onchain/ethereum/snapshots/Mons111kGasTest.json';
const referenceSnapshots = execFileSync('git', ['show', `${snapshotReferenceCommit}:${snapshotReferencePath}`],
  { cwd: packageRoot, encoding: 'utf8' });
const expected = Object.fromEntries(Object.entries(JSON.parse(referenceSnapshots))
  .map(([name, value]) => [name, Number(value)]).sort(([a], [b]) => a.localeCompare(b)));
assert.equal(Object.keys(expected).length, 89, 'Expected all 89 committed gas benchmarks');
const writeNames = Object.keys(expected).filter(name => /^(mint|unbox|deliver|claim)/.test(name));
const progress = message => process.stderr.write(message + '\n');
const save = report => writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
const sourceHashes = directory => Object.fromEntries(readdirSync(join(directory, 'src'))
  .filter(name => name.endsWith('.sol')).sort().map(name => [name, hash(read(join(directory, 'src', name)))]));

function createProject(label, viaIR = false, optimizerRuns = 200) {
  const directory = join(temporaryRoot, label);
  mkdirSync(directory);
  cpSync(join(packageRoot, 'src'), join(directory, 'src'), { recursive: true });
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
fs_permissions = [{ access = "read", path = "./candidate" }]
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
  const source = read(join(packageRoot, 'test/Mons111kGas.t.sol'));
  const originalDeployment = /token =\s*new Mons111k\(address\(this\), vm.addr\(SIGNER_KEY\), payable\(address\(0xBEEF\)\), address\(new Mons111kRenderer\(\)\)\);/;
  assert.equal([...source.matchAll(new RegExp(originalDeployment, 'g'))].length, 1, 'Gas harness deployment changed');
  const harness = source.replace(originalDeployment, `address renderer = _deployCandidate("Mons111kRenderer", "");
        token = Mons111k(_deployCandidate("Mons111k", abi.encode(
            address(this), vm.addr(SIGNER_KEY), payable(address(0xBEEF)), renderer
        )));`).replace('    function setUp() public {', `    function _deployCandidate(string memory name, bytes memory arguments) internal returns (address deployed) {
        bytes memory code = abi.encodePacked(vm.getCode(string.concat("candidate/", name, ".json")), arguments);
        assembly { deployed := create(0, add(code, 32), mload(code)) }
        require(deployed != address(0), "candidate deployment failed");
    }

    function setUp() public {`);
  const support = read(join(packageRoot, 'test/TestSupport.sol'));
  assert.equal(support.includes('function getCode('), false, 'Test support already declares getCode');
  writeFileSync(join(directory, 'test/Mons111kGas.t.sol'), harness);
  writeFileSync(join(directory, 'test/TestSupport.sol'), support.replace('interface Vm {',
    'interface Vm {\n    function getCode(string calldata artifactPath) external returns (bytes memory);'));
  run(directory, ['build', '--offline']);
  return { directory, sha256: hash(harness), testSupportSha256: hash(read(join(directory, 'test/TestSupport.sol'))) };
}

function measurements(directory, harnessDirectory) {
  for (const name of names) {
    cpSync(join(directory, 'out', `${name}.sol`, `${name}.json`), join(harnessDirectory, 'candidate', `${name}.json`));
  }
  const suites = JSON.parse(run(harnessDirectory, testCommand));
  assert.deepEqual(Object.keys(suites), ['test/Mons111kGas.t.sol:Mons111kGasTest'], 'Unexpected benchmark suite');
  const results = Object.values(suites)[0].test_results;
  assert.equal(Object.keys(results).length, Object.keys(expected).length, 'Missing benchmark results');
  const values = {};
  for (const [testName, result] of Object.entries(results)) {
    assert.equal(result.status, 'Success', `${testName} failed: ${result.reason ?? ''}`);
    const groups = Object.entries(result.gas_snapshots);
    assert.equal(groups.length, 1, `${testName}: unexpected snapshot groups`);
    assert.equal(groups[0][0], 'Mons111kGasTest', `${testName}: unexpected snapshot group`);
    const entries = Object.entries(groups[0][1]);
    assert.equal(entries.length, 1, `${testName}: unexpected snapshot count`);
    const [name, value] = entries[0];
    assert.equal(testName, `testGas${name[0].toUpperCase() + name.slice(1)}()`, 'Snapshot/test name mismatch');
    assert.ok(Object.hasOwn(expected, name) && !Object.hasOwn(values, name), 'Unknown or duplicate gas snapshot');
    values[name] = Number(value);
    assert.ok(Number.isSafeInteger(values[name]) && values[name] > 0, 'Invalid gas snapshot');
  }
  return Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
}

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
        return { address: receipt.contractAddress, gasUsed: Number(BigInt(receipt.gasUsed)) };
      };
      const renderer = await deploy('Mons111kRenderer');
      const args = [wallet, '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf', wallet, renderer.address]
        .map(address => address.slice(2).padStart(64, '0')).join('');
      variant.deploymentTransactions = { renderer, collection: await deploy('Mons111k', args) };
    }
  } finally {
    if (anvil.exitCode === null && !startupError) {
      await new Promise(resolve => { anvil.once('exit', resolve); anvil.kill('SIGTERM'); });
    }
  }
}

function summarize(candidate, baseline) {
  const deltas = Object.fromEntries(Object.keys(expected).map(name => [name, candidate.gas[name] - baseline.gas[name]]));
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
      candidate.artifacts[name].creationBytes + (name === 'Mons111k' ? 128 : 0) <= 49152),
    withinProjectSizeBudgets: candidate.artifacts.Mons111kRenderer.runtimeBytes <= 12 * 1024,
  };
}

const report = {
  schemaVersion: 1,
  measuredAt: new Date().toISOString(),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: packageRoot, encoding: 'utf8' }).trim(),
  sourceSha256: sourceHashes(packageRoot),
  snapshotReference: { commit: snapshotReferenceCommit, path: snapshotReferencePath, sha256: hash(referenceSnapshots) },
  benchmarkCount: Object.keys(expected).length,
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
    command: 'node scripts/benchmark-compiler.mjs <output.json> [legacy|ir] [runs...]',
    defaultRuns,
    requestedMatrix: Object.fromEntries(pipelines.map(pipeline => [pipeline, requestedRuns ?? defaultRuns[pipeline]])),
    scriptSha256: hash(read(fileURLToPath(import.meta.url))),
    fixedSettings: { solc: '0.8.30', optimizer: true, evmVersion: 'prague', bytecodeHash: 'none' },
    harness: 'All variants use one legacy/200 harness and MinimalGasReceiver. Candidate creation bytecode is loaded with vm.getCode and deployed using CREATE in the original order, preserving addresses and signed calldata.',
    measurement: 'All 89 snapshotGasLastCall measurements use Forge --isolate. Write measurements include transaction intrinsic/calldata gas and refunds; read measurements are callee STATICCALL execution. Setup and harness gas are excluded. Deployment gas comes from actual Prague Anvil receipts, reverting to identical account state and nonces for each variant.',
    environment: 'FOUNDRY_* and DAPP_* overrides are removed for isolated builds. Tracked sources, snapshots and fixtures are never modified.',
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
  const baseline = measure('legacy-200', false, 200);
  assert.equal(baseline.status, 'measured', baseline.error ?? 'Baseline failed');
  const mismatches = Object.keys(expected).filter(name => expected[name] !== baseline.gas[name]);
  report.baseline = { label: baseline.label, reproducedSnapshotCount: Object.keys(expected).length - mismatches.length, mismatches };
  assert.deepEqual(mismatches, [], 'Baseline does not reproduce committed snapshots');
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
