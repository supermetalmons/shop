import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRepeatedGas, compareGas, summarizeGas } from './gas-comparison.mjs';
import { measureReceiptGas, RECEIPT_WALLET_SOURCE } from './gas-receipts.mjs';

const referenceCommit = '32841d396ca81eb25c77ccd30e3a5546d0bc91fd';
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '../..');
if (process.argv.length > 3) throw new Error('Usage: node --import tsx scripts/compare-gas.mjs [output.json]');
const outputPath = resolve(process.argv[2] || join(packageRoot, 'benchmarks/optimizer-500-comparison.json'));
const overrides = Object.keys(process.env).filter(name => /^(FOUNDRY_|DAPP_)/.test(name));
assert.deepEqual(overrides, [], 'Remove FOUNDRY_/DAPP_ overrides before comparing gas');
const environment = { ...process.env };
const read = path => readFileSync(path, 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const git = args => execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const referenceFile = path => git(['show', `${referenceCommit}:onchain/ethereum/${path}`]);
const run = (directory, args) => execFileSync('forge', args, {
  cwd: directory, env: environment, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
});
const config = JSON.parse(run(packageRoot, ['config', '--json']));
assert.deepEqual({ solc: config.solc, optimizer: config.optimizer, runs: config.optimizer_runs,
  viaIR: config.via_ir, evm: config.evm_version, bytecodeHash: config.bytecode_hash },
{ solc: '0.8.30', optimizer: true, runs: 500, viaIR: false, evm: 'prague', bytecodeHash: 'none' },
'The candidate must use the reviewed 500-run build settings');
assert.equal(referenceFile('package-lock.json'), read(join(packageRoot, 'package-lock.json')),
  'Dependency lock differs from the pinned reference');
const sources = {
  reference: referenceFile('src/NFT111K.sol'),
  candidate: read(join(packageRoot, 'src/NFT111K.sol')),
};
assert.equal(hash(sources.reference), '52426b79003a3beda1c4e751cb09369bd2269700e237b67c6777db019cf818c5',
  'Pinned reference source changed');
const gasTestSource = read(join(packageRoot, 'test/NFT111KGas.t.sol'));
const expectedNames = [...gasTestSource.matchAll(/\bfunction\s+testGas([A-Z]\w*)\s*\(\s*\)/g)]
  .map(([, name]) => name[0].toLowerCase() + name.slice(1)).sort();
assert.equal(expectedNames.length, 141, 'Expected the original 137 gas cases and four URI setter cases');
assert.equal(new Set(expectedNames).size, expectedNames.length, 'Duplicate benchmark names');
const historicalNames = Object.keys(JSON.parse(referenceFile('snapshots/NFT111KGasTest.json'))).sort();
assert.deepEqual(expectedNames, [...historicalNames, 'setBaseURI40', 'setBaseURI100', 'setBaseURI256', 'setBaseURI1024'].sort(),
  'Gas comparison case coverage changed');
const harnessName = 'NFT111KComparisonGasTest';
const temporaryRoot = mkdtempSync(join(tmpdir(), '111k-gas-comparison-'));
const report = {
  schemaVersion: 1,
  referenceCommit,
  candidateBaseCommit: git(['rev-parse', 'HEAD']).trim(),
  sourceSha256: Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, hash(source)])),
  threshold: { percent: 1, comparison: 'candidateGas * 100 < referenceGas * 101' },
  settings: { solc: '0.8.30', evm: 'prague', viaIR: false, optimizer: true, referenceRuns: 1000, candidateRuns: 500,
    harnessRuns: 200, walletRuns: 1000, bytecodeHash: 'none' },
  provenance: {
    foundryConfigSha256: hash(read(join(packageRoot, 'foundry.toml'))),
    packageLockSha256: hash(read(join(packageRoot, 'package-lock.json'))),
    gasTestSha256: hash(gasTestSource),
    testSupportSha256: hash(read(join(packageRoot, 'test/TestSupport.sol'))),
    discountProofSha256: hash(read(join(packageRoot, 'fixtures/discounts/proof.json'))),
    scriptSha256: Object.fromEntries(['compare-gas.mjs', 'gas-comparison.mjs', 'gas-receipts.mjs']
      .map(name => [name, hash(read(join(packageRoot, 'scripts', name)))])),
    forge: execFileSync('forge', ['--version'], { encoding: 'utf8' }).trim(),
    anvil: execFileSync('anvil', ['--version'], { encoding: 'utf8' }).trim(),
    node: process.version,
  },
  method: 'Two measurements per variant with one fixed legacy/200 harness and receiver. '
    + 'Reference source is read from the pinned commit and compiled at 1000 runs; the working source is compiled at 500. '
    + 'Forge uses --isolate with identical deployment addresses and signed calldata. '
    + 'Independent Anvil receipts use identical inputs, timestamps, starting state and fixed wallet bytecode. '
    + 'Read-call execution gas is compared separately from successful and reverted transaction receipts.',
};

function createProject(name, optimizerRuns, source, contractName = 'NFT111K') {
  const directory = join(temporaryRoot, name);
  mkdirSync(join(directory, 'src'), { recursive: true });
  writeFileSync(join(directory, 'src', `${contractName}.sol`), source);
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
via_ir = false
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

function storageLayout(artifact) {
  const { storage, types } = artifact.storageLayout;
  const member = ({ label, slot, offset, type }) => ({ label, slot, offset, type: describeType(type) });
  const describeType = id => {
    const type = types[id];
    return { label: type.label, encoding: type.encoding, numberOfBytes: type.numberOfBytes,
      ...(type.key ? { key: describeType(type.key) } : {}),
      ...(type.value ? { value: describeType(type.value) } : {}),
      ...(type.base ? { base: describeType(type.base) } : {}),
      ...(type.members ? { members: type.members.map(member) } : {}) };
  };
  return storage.map(member);
}

function build(directory, name = 'NFT111K') {
  run(directory, ['build', '--offline', '--extra-output', 'storageLayout']);
  return JSON.parse(read(join(directory, 'out', `${name}.sol`, `${name}.json`)));
}

function describeArtifact(artifact, optimizerRuns) {
  const metadata = typeof artifact.metadata === 'string' ? JSON.parse(artifact.metadata) : artifact.metadata;
  assert.equal(metadata.settings.optimizer.runs, optimizerRuns);
  assert.equal(metadata.settings.optimizer.enabled, true);
  assert.equal(metadata.settings.viaIR ?? false, false);
  assert.equal(metadata.settings.evmVersion, 'prague');
  assert.equal(metadata.settings.metadata.bytecodeHash, 'none');
  const runtimeBytes = artifact.deployedBytecode.object.replace(/^0x/, '').length / 2;
  const creationBytes = artifact.bytecode.object.replace(/^0x/, '').length / 2;
  assert.ok(runtimeBytes <= 24576, 'Production runtime exceeds EIP-170');
  assert.ok(creationBytes + 6656 <= 49152, 'Maximum supported constructor payload exceeds EIP-3860');
  return { optimizerRuns, compilerVersion: metadata.compiler.version, runtimeBytes, headroomBytes: 24576 - runtimeBytes,
    creationBytes, maximumConstructorArgumentBytes: 6656, creationSha256: hash(artifact.bytecode.object),
    runtimeTemplateSha256: hash(artifact.deployedBytecode.object),
    abiSha256: hash(JSON.stringify(canonical(artifact.abi))), storageLayoutSha256: hash(JSON.stringify(storageLayout(artifact))) };
}

function createHarness() {
  const directory = createProject('harness', 200, sources.reference);
  mkdirSync(join(directory, 'test'));
  mkdirSync(join(directory, 'candidate'));
  cpSync(join(packageRoot, 'fixtures/discounts'), join(directory, 'fixtures/discounts'), { recursive: true });
  writeFileSync(join(directory, 'test/NFT111KGas.t.sol'), gasTestSource);
  cpSync(join(packageRoot, 'test/TestSupport.sol'), join(directory, 'test/TestSupport.sol'));
  const source = `pragma solidity 0.8.30;
import {NFT111KGasTest} from "./NFT111KGas.t.sol";
import {NFT111K} from "../src/NFT111K.sol";
interface ComparisonVm { function getCode(string calldata path) external returns (bytes memory); }
contract ${harnessName} is NFT111KGasTest {
    function _deployCollection(address[] memory recipients, uint256[] memory shares) internal override returns (NFT111K) {
        bytes memory code = abi.encodePacked(
            ComparisonVm(address(vm)).getCode("candidate/NFT111K.json"),
            abi.encode(address(this), vm.addr(SIGNER_KEY), payable(address(0xBEEF)),
                "https://cdn.mons.shop/111k-sepolia/", bytes32(0), recipients, shares, new NFT111K.FreeMintAllocation[](0))
        );
        address deployed;
        assembly { deployed := create(0, add(code, 32), mload(code)) }
        require(deployed != address(0), "candidate deployment failed");
        return NFT111K(deployed);
    }
}
`;
  writeFileSync(join(directory, 'test', `${harnessName}.t.sol`), source);
  report.provenance.harnessSha256 = hash(source);
  build(directory);
  return directory;
}

function measureBenchmarks(directory, artifact) {
  writeFileSync(join(directory, 'candidate/NFT111K.json'), JSON.stringify(artifact));
  const suites = JSON.parse(run(directory, ['test', '--offline', '--isolate', '--match-contract', `^${harnessName}$`,
    '--gas-snapshot-check=false', '--gas-snapshot-emit=false', '--json']));
  const suiteName = `test/${harnessName}.t.sol:${harnessName}`;
  assert.deepEqual(Object.keys(suites), [suiteName], 'Unexpected gas suites');
  const tests = suites[suiteName].test_results;
  assert.equal(Object.keys(tests).length, expectedNames.length, 'Missing gas tests');
  const gas = {};
  for (const [testName, result] of Object.entries(tests)) {
    assert.equal(result.status, 'Success', `${testName}: ${result.reason || result.status}`);
    assert.deepEqual(Object.keys(result.gas_snapshots), [harnessName], `${testName}: invalid snapshot groups`);
    const entries = Object.entries(result.gas_snapshots[harnessName]);
    assert.equal(entries.length, 1, `${testName}: invalid measurements`);
    const [name, value] = entries[0];
    assert.equal(testName, `testGas${name[0].toUpperCase() + name.slice(1)}()`, 'Measurement name mismatch');
    assert.ok(expectedNames.includes(name) && !Object.hasOwn(gas, name), 'Unexpected or duplicate measurement');
    gas[name] = Number(value);
  }
  return gas;
}

try {
  process.stderr.write('Comparing original 1000-run reference with working 500-run candidate.\n');
  const variants = [['reference', 1000], ['candidate', 500]].map(([name, runs]) => ({
    name, artifact: build(createProject(name, runs, sources[name])),
  }));
  assert.deepEqual(canonical(variants[0].artifact.abi), canonical(variants[1].artifact.abi), 'Contract ABI changed');
  assert.deepEqual(storageLayout(variants[0].artifact), storageLayout(variants[1].artifact), 'Contract storage layout changed');
  report.artifacts = Object.fromEntries(variants.map(({ name, artifact }) => [name, describeArtifact(artifact, name === 'reference' ? 1000 : 500)]));
  assert.equal(report.artifacts.reference.runtimeBytes, 24566, 'Reference build does not reproduce its runtime size');
  const harness = createHarness();
  const gas = {};
  for (const { name, artifact } of variants) {
    const first = measureBenchmarks(harness, artifact);
    const second = measureBenchmarks(harness, artifact);
    assertRepeatedGas(first, second, expectedNames, name);
    gas[name] = first;
  }
  const benchmarks = compareGas(gas.reference, gas.candidate, expectedNames, 'benchmarks');
  const write = name => /^(mint|unbox|deliver|claim|release|set)/.test(name);
  report.benchmarks = { count: benchmarks.length, repetitions: 2, identicalRepeats: true,
    writes: summarizeGas(benchmarks.filter(row => write(row.name))),
    reads: summarizeGas(benchmarks.filter(row => !write(row.name))), rows: benchmarks };
  const walletArtifact = build(createProject('wallet', 1000, RECEIPT_WALLET_SOURCE, 'ReceiptWallet'), 'ReceiptWallet');
  report.provenance.walletRuntimeSha256 = hash(walletArtifact.deployedBytecode.object);
  const receipts = await measureReceiptGas({ variants, walletArtifact, environment });
  assert.equal(receipts.caseCount, 39, 'Receipt scenario coverage changed');
  assert.equal(receipts.operationCount, 106, 'Receipt operation coverage changed');
  assert.equal(receipts.repetitions, 2, 'Receipt repetition count changed');
  const receiptNames = Object.keys(receipts.statuses);
  assert.equal(receiptNames.length, 106, 'Receipt status coverage changed');
  assert.ok(Object.values(receipts.statuses).every(status => ['0x0', '0x1'].includes(status)), 'Invalid receipt status');
  const receiptRows = compareGas(receipts.gas.reference, receipts.gas.candidate, receiptNames, 'receipts');
  report.receipts = { method: receipts.method, caseCount: receipts.caseCount, operationCount: receipts.operationCount,
    repetitions: receipts.repetitions, identicalRepeats: true, measuredReceiptCount: receipts.operationCount * 4,
    collection: receipts.collection, helper: receipts.helper,
    variants: receipts.variants.map(variant => ({ name: variant.name,
      deploymentGas: variant.repetitions.map(repetition => repetition.deploymentGasUsed),
      cases: variant.repetitions[0].cases.map(({ name, transactions, traceSha256, stateSha256 }) =>
        ({ name, transactions, traceSha256, stateSha256 })),
    })),
    successful: summarizeGas(receiptRows.filter(row => receipts.statuses[row.name] === '0x1')),
    reverted: summarizeGas(receiptRows.filter(row => receipts.statuses[row.name] === '0x0')),
    rows: receiptRows.map(row => ({ ...row, status: receipts.statuses[row.name] })) };
  report.status = 'passed';
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, runtimeBytes: report.artifacts.candidate.runtimeBytes,
    headroomBytes: report.artifacts.candidate.headroomBytes,
    worstSuccessfulTransaction: report.receipts.successful.worstPercentage,
    worstRevertedTransaction: report.receipts.reverted.worstPercentage,
    worstRead: report.benchmarks.reads.worstPercentage, report: outputPath }, null, 2));
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
