import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '../..');
const baselineCommit = '678dd7cff1aec708833bf711a3b761ad20025a6a';
const outputPath = process.argv[2] && resolve(process.argv[2]);
if (process.argv.length > 3) throw new Error('Usage: node scripts/benchmark-delivery.mjs [output.json]');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'mons111k-delivery-comparison-'));
const hash = value => createHash('sha256').update(value).digest('hex');
const read = path => readFileSync(path, 'utf8');
const git = args => execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' });
const command = ['test', '--offline', '--isolate', '--match-contract', '^Mons111kGasTest$',
  '--gas-snapshot-check=false', '--gas-snapshot-emit=false', '--json'];

function measurements(output, suiteName, expectedNames) {
  const suites = JSON.parse(output);
  assert.deepEqual(Object.keys(suites), [suiteName], 'Unexpected benchmark suite');
  const results = suites[suiteName].test_results;
  assert.equal(Object.keys(results).length, expectedNames.length, 'Missing benchmark results');
  const values = {};
  for (const result of Object.values(results)) {
    assert.equal(result.status, 'Success', 'Benchmark did not pass');
    const groups = Object.values(result.gas_snapshots);
    assert.equal(groups.length, 1, 'Unexpected measurement groups');
    const entries = Object.entries(groups[0]);
    assert.equal(entries.length, 1, 'Unexpected measurement count');
    const [name, value] = entries[0];
    assert.ok(expectedNames.includes(name), 'Unexpected measurement name');
    assert.ok(!Object.hasOwn(values, name), 'Duplicate measurement name');
    values[name] = Number(value);
    assert.ok(Number.isSafeInteger(values[name]) && values[name] > 0, 'Invalid gas measurement');
  }
  return Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
}

function artifact(directory, name) {
  const compiled = JSON.parse(read(join(directory, 'out', name + '.sol', name + '.json')));
  return {
    compilerVersion: compiled.metadata.compiler.version,
    creationBytes: (compiled.bytecode.object.length - 2) / 2,
    runtimeBytes: (compiled.deployedBytecode.object.length - 2) / 2,
    abiSha256: hash(JSON.stringify(compiled.abi)),
  };
}

function measure(label, baseline) {
  const directory = join(temporaryRoot, label);
  mkdirSync(join(directory, 'test'), { recursive: true });
  cpSync(join(packageRoot, 'src'), join(directory, 'src'), { recursive: true });
  if (baseline) {
    const files = git(['ls-tree', '-r', '--name-only', baselineCommit, '--', 'onchain/ethereum/src']).trim().split('\n');
    for (const file of files) writeFileSync(join(directory, file.slice('onchain/ethereum/'.length)), git(['show', baselineCommit + ':' + file]));
  }
  for (const file of ['Mons111kGas.t.sol', 'TestSupport.sol']) {
    cpSync(join(packageRoot, 'test', file), join(directory, 'test', file));
  }
  cpSync(join(packageRoot, 'foundry.toml'), join(directory, 'foundry.toml'));
  symlinkSync(join(packageRoot, 'node_modules'), join(directory, 'node_modules'), 'dir');
  const run = args => execFileSync('forge', args, { cwd: directory, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  run(['build', '--offline', '--skip', 'test', '--skip', 'script']);
  const harness = read(join(directory, 'test', 'Mons111kGas.t.sol'));
  const names = [...harness.matchAll(/\bfunction\s+testGas([A-Z]\w*)\s*\(\s*\)/g)]
    .map(([, name]) => name[0].toLowerCase() + name.slice(1));
  const gas = measurements(run(command), 'test/Mons111kGas.t.sol:Mons111kGasTest', names);
  return {
    sourceSha256: hash(read(join(directory, 'src', 'Mons111k.sol'))),
    rendererSha256: hash(read(join(directory, 'src', 'Mons111kRenderer.sol'))),
    harnessSha256: hash(harness),
    testSupportSha256: hash(read(join(directory, 'test', 'TestSupport.sol'))),
    collection: artifact(directory, 'Mons111k'),
    renderer: artifact(directory, 'Mons111kRenderer'),
    gas,
  };
}

async function measureDeployments() {
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
    const response = await fetch('http://127.0.0.1:' + port, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      signal: AbortSignal.timeout(2000) });
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
    const results = {};
    for (const label of ['baseline', 'candidate']) {
      assert.equal(await rpc('evm_revert', [snapshot]), true);
      snapshot = await rpc('evm_snapshot');
      const deploy = async (name, args = '') => {
        const compiled = JSON.parse(read(join(temporaryRoot, label, 'out', name + '.sol', name + '.json')));
        const data = compiled.bytecode.object + args;
        const transaction = await rpc('eth_sendTransaction', [{ from: wallet, data, gas: '0x989680' }]);
        let receipt;
        for (let attempt = 0; attempt < 100; attempt++) {
          receipt = await rpc('eth_getTransactionReceipt', [transaction]);
          if (receipt) break;
          await delay();
        }
        assert.equal(receipt?.status, '0x1', 'Deployment failed');
        const bytes = Buffer.from(data.slice(2), 'hex');
        const intrinsicGas = 53000 + 2 * Math.ceil(bytes.length / 32) +
          bytes.reduce((sum, byte) => sum + (byte === 0 ? 4 : 16), 0);
        const gasUsed = Number(BigInt(receipt.gasUsed));
        return { address: receipt.contractAddress, gasUsed, intrinsicGas, executionGas: gasUsed - intrinsicGas };
      };
      const renderer = await deploy('Mons111kRenderer');
      const args = [wallet, '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf', wallet, renderer.address]
        .map(address => address.slice(2).padStart(64, '0')).join('');
      const collection = await deploy('Mons111k', args);
      results[label] = { deployCollection: collection, deployRenderer: renderer };
    }
    return results;
  } finally {
    if (anvil.exitCode === null && !startupError) {
      await new Promise(resolve => {
        anvil.once('exit', resolve);
        anvil.kill('SIGTERM');
      });
    }
  }
}

try {
  const baseline = measure('baseline', true);
  const candidate = measure('candidate', false);
  assert.equal(baseline.harnessSha256, candidate.harnessSha256, 'Harnesses differ');
  assert.equal(baseline.testSupportSha256, candidate.testSupportSha256, 'Test support differs');
  assert.equal(baseline.rendererSha256, candidate.rendererSha256, 'Renderer sources differ');
  assert.equal(baseline.collection.compilerVersion, candidate.collection.compilerVersion, 'Compilers differ');
  assert.equal(baseline.collection.abiSha256, candidate.collection.abiSha256, 'Collection ABI changed');
  const baselineSnapshots = JSON.parse(git(['show',
    baselineCommit + ':onchain/ethereum/snapshots/Mons111kGasTest.json']));
  assert.deepEqual(Object.keys(baselineSnapshots).filter(name => Number(baselineSnapshots[name]) !== baseline.gas[name]),
    [], 'Original baseline snapshots changed');
  const names = Object.keys(baseline.gas);
  assert.deepEqual(names, Object.keys(candidate.gas), 'Benchmark names differ');
  const writes = names.filter(name => /^(mint|unbox|deliver|claim)/.test(name));
  const regressions = writes.filter(name => candidate.gas[name] > baseline.gas[name]);
  const deliveryImprovements = writes.filter(name => name.startsWith('deliver') && candidate.gas[name] < baseline.gas[name]);
  const accepted = regressions.length === 0 && deliveryImprovements.length > 0;
  const deployments = await measureDeployments();
  baseline.deploymentTransactions = deployments.baseline;
  candidate.deploymentTransactions = deployments.candidate;
  for (const result of [baseline, candidate]) {
    result.deploymentGas = Object.fromEntries(Object.entries(result.deploymentTransactions)
      .map(([name, deployment]) => [name, deployment.gasUsed]));
  }
  const config = JSON.parse(execFileSync('forge', ['config', '--json'], { cwd: packageRoot, encoding: 'utf8' }));
  const report = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    baselineCommit,
    candidateParentCommit: git(['rev-parse', 'HEAD']).trim(),
    decision: {
      accepted,
      rule: 'At least one delivery benchmark improves and no measured write call regresses. Deployment costs are reported separately.',
      benchmarkCount: names.length,
      writeBenchmarkCount: writes.length,
      reproducedBaselineSnapshotCount: Object.keys(baselineSnapshots).length,
      deliveryImprovements,
      writeRegressions: regressions,
      abiUnchanged: true,
    },
    toolchain: {
      forge: execFileSync('forge', ['--version'], { encoding: 'utf8' }).trim(),
      anvil: execFileSync('anvil', ['--version'], { encoding: 'utf8' }).trim(),
      solidity: baseline.collection.compilerVersion,
      optimizer: config.optimizer,
      optimizerRuns: config.optimizer_runs,
      evmVersion: config.evm_version,
      viaIr: config.via_ir,
      bytecodeHash: config.bytecode_hash,
      node: process.version,
      dependencies: Object.fromEntries(Object.keys(JSON.parse(read(join(packageRoot, 'package.json'))).devDependencies)
        .map(name => [name, JSON.parse(read(join(packageRoot, 'node_modules', name, 'package.json'))).version])),
      packageLockSha256: hash(read(join(packageRoot, 'package-lock.json'))),
      foundryConfigSha256: hash(read(join(packageRoot, 'foundry.toml'))),
    },
    reproduction: {
      command: 'node scripts/benchmark-delivery.mjs [output.json]',
      forgeCommand: ['forge', ...command].join(' '),
      source: 'Baseline Solidity sources come from the recorded commit; candidate sources and the identical expanded harness come from the working tree.',
      measurement: 'Forge --isolate write-call snapshots include transaction intrinsic/calldata gas, the Prague calldata floor when applicable, and applied refunds. Read-only STATICCALL snapshots measure callee execution gas. Scenario/signature setup and outer smart-wallet wrapper costs are excluded. Snapshot files are not updated. Deployment costs are actual receipts from a separate Prague Anvil node restored to the same state before each variant; intrinsic gas is reported separately.',
      sortingComparisons: 'Changing delivery order changes signed calldata. Raw sorting snapshot differences include signature-byte intrinsic gas differences; 12/24-gas variations on crate-only and fully initialized controls do not demonstrate execution savings. Baseline-to-candidate comparisons use the same calldata and remain directly comparable.',
      shuffle: 'Fisher-Yates with seed 0x111c and a 32-bit LCG: seed = (seed * 1664525 + 1013904223) & 0xffffffff.',
      scriptSha256: hash(read(fileURLToPath(import.meta.url))),
    },
    baseline,
    candidate,
    deltas: Object.fromEntries(names.map(name => [name, candidate.gas[name] - baseline.gas[name]])),
    deploymentDeltas: Object.fromEntries(Object.keys(baseline.deploymentGas).map(name =>
      [name, candidate.deploymentGas[name] - baseline.deploymentGas[name]])),
  };
  const encoded = JSON.stringify(report, null, 2) + '\n';
  if (outputPath) writeFileSync(outputPath, encoded);
  else process.stdout.write(encoded);
  process.stderr.write(JSON.stringify({ accepted, benchmarks: names.length, writes: writes.length,
    deliveryImprovements: deliveryImprovements.length, regressions, deploymentDeltas: report.deploymentDeltas }) + '\n');
  if (!accepted) process.exitCode = 1;
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
