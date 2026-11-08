import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, encode } from '@metamask/abi-utils';
import { keccak_256 } from '@noble/hashes/sha3';
import { parseInitialDeliveryReceiver, parseProceedsConfig } from './proceeds-config.mjs';
import { parseFreeMintConfigJson } from './free-mint-config.mjs';
import { parseDiscountCapConfigJson } from './discount-cap-config.mjs';
import { deploymentGas, matchingRuntime, validateDeploymentBalance, validateDeploymentGasPrice } from './pre111k-deployment.mjs';
import { withMetadataLock } from '../../../scripts/ethereum-metadata/lock.ts';
import { record111kReleaseLocation, resolve111kReleaseLocation } from '../../../scripts/shared/ethereum111kReleaseLocations.ts';

export const NFT111K_SEPOLIA = Object.freeze({
  chainId: 11155111,
  deployer: '0xd58d143ca63d9baccc33fdf69ea203f59c58ae93',
  owner: '0xd58d143ca63d9baccc33fdf69ea203f59c58ae93',
  quoteSigner: '0xcc4c8bfd93af9f36d46215a0206954bf6a14c3ca',
  previousContract: '0xe665d1043f72886f49894006ea196450b33f0f89',
  maximumFeeWei: '5000000000000000',
});

const project = fileURLToPath(new URL('../', import.meta.url));
const repository = path.resolve(project, '../..');
const commands = ['prepare', 'deploy', 'reserve', 'pause-old', 'open', 'finalize', 'mint-qa', 'unpack-qa', 'verify'];
const actionOrder = ['deploy', 'reserve', 'pause-old-sale', 'pause-old-redemptions', 'open', 'mint-qa', 'unpack-qa'];
const configPaths = ['config/proceeds.json', 'config/free-mints.sepolia.json', 'config/delivery-routing.json',
  'config/discount-caps.json', '../../src/ethereum/discounts/111k.json'];
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const hashHex = value => `0x${Buffer.from(keccak_256(Buffer.from(value.slice(2), 'hex'))).toString('hex')}`;
const hex = value => `0x${BigInt(value).toString(16)}`;
const sleep = ms => new Promise(done => setTimeout(done, ms));
const selector = signature => Buffer.from(keccak_256(Buffer.from(signature))).subarray(0, 4).toString('hex');
const calldata = (signature, types = [], values = []) => `0x${selector(signature)}${Buffer.from(encode(types, values)).toString('hex')}`;
const decoded = (types, value) => decode(types, Buffer.from(value.slice(2), 'hex'));
const normalized = value => typeof value === 'string' ? value.toLowerCase() : value;

function requireSepoliaChain(value) {
  assert.ok(typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value), 'Invalid RPC chain ID');
  assert.equal(BigInt(value), 11155111n, 'RPC is not Sepolia');
}

function cast(args) {
  try { return execFileSync('cast', args, { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }).trim(); }
  catch { throw new Error(`Cast ${args[0]} failed; inspect the private release state before retrying`); }
}

export function run111kReplacementFinalization({ releaseDirectory }, executeFile = execFileSync) {
  releaseDirectory = fs.realpathSync(releaseDirectory);
  executeFile(process.execPath, ['--import', 'tsx', 'scripts/ops/cleanupEthereum111k.ts',
    'finalize', '--release-directory', releaseDirectory, '--write'], {
    cwd: repository, encoding: 'utf8', stdio: ['ignore', 'ignore', 'inherit'],
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(releaseDirectory, 'manifest.json'), 'utf8'));
  const journalPath = path.join(releaseDirectory, 'cleanup-finalization.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  assert.equal(journal.version, 2, 'Unsupported replacement cleanup journal');
  assert.equal(journal.kind, '111k-replacement-cleanup');
  assert.equal(journal.complete, true, 'Replacement cleanup remains incomplete');
  assert.equal(journal.release?.releaseDirectory, path.resolve(releaseDirectory));
  assert.equal(journal.release?.manifestSha256, sha256(json(manifest)), 'Cleanup is not bound to this frozen manifest');
  for (const key of ['chainId', 'deploymentId', 'contractAddress', 'previousContract']) {
    assert.equal(journal.release?.[key], manifest[key], `Cleanup release ${key} changed`);
  }
  assert.equal(journal.release?.metadataBaseUri, manifest.metadataBaseURI);
  assert.equal(journal.oldDeployment?.contractAddress, manifest.previousContract);
  assert.equal(journal.newDeployment?.contractAddress, manifest.contractAddress);
  assert.equal(journal.artifacts?.report?.complete, true, 'Local replacement artifacts remain');
  assert.ok(Number.isSafeInteger(journal.metadataDeletedAtMs) && Number.isSafeInteger(journal.verifiedAtMs)
    && journal.verifiedAtMs - journal.metadataDeletedAtMs >= 300_000, 'Replacement cleanup has not passed its scheduler observation interval');
  return { complete: true, journalPath, retiredDeploymentId: journal.oldDeployment.deploymentId,
    deploymentId: manifest.deploymentId, verifiedAtMs: journal.verifiedAtMs, artifacts: journal.artifacts.report };
}

function durableWrite(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, json(value)); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, filename);
  const directory = fs.openSync(path.dirname(filename), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

function privateDirectory(directory) {
  const allowed = directory => {
    const relative = path.relative(repository, directory);
    if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      assert.ok(relative.startsWith(`.cache${path.sep}`) || relative.startsWith(`onchain${path.sep}ethereum${path.sep}.local${path.sep}`),
        'Release state must be in a private ignored directory or outside the repository');
    }
  };
  allowed(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assert.ok(fs.lstatSync(directory).isDirectory() && (fs.statSync(directory).mode & 0o077) === 0,
    'Release directory must be private (mode 0700)');
  const canonical = fs.realpathSync(directory);
  allowed(canonical);
  return canonical;
}

async function withLock(directory, work) {
  const canonical = privateDirectory(directory);
  return withMetadataLock(path.join(canonical, 'operation.lock'), () => work(canonical));
}

export function parse111kDeploymentArgs(argv) {
  const [command, ...arguments_] = argv;
  assert.ok(commands.includes(command), `Use ${commands.join('|')} --directory PATH --network sepolia [--deployment-id ID (required for prepare)] [--previous-directory PATH] [--keystore PATH --password-file PATH]`);
  const values = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    assert.ok(['--directory', '--deployment-id', '--network', '--previous-contract', '--previous-directory', '--keystore', '--password-file'].includes(key) &&
      arguments_[index + 1] && !Object.hasOwn(values, key), 'Invalid or repeated deployment option');
    values[key] = arguments_[index + 1];
  }
  assert.equal(values['--network'] ?? 'sepolia', 'sepolia', 'Only Sepolia is supported');
  const deploymentId = values['--deployment-id'];
  assert.ok(deploymentId === undefined || /^[a-z0-9][a-z0-9-]{0,63}$/.test(deploymentId), 'Invalid deployment ID');
  assert.ok(command !== 'prepare' || deploymentId, 'Preparing a replacement requires an explicit fresh --deployment-id');
  assert.ok(['prepare', 'finalize'].includes(command) || values['--previous-directory'] === undefined,
    '--previous-directory is only accepted for prepare or finalize');
  const previousContract = values['--previous-contract'];
  assert.ok(previousContract === undefined || /^0x[0-9a-fA-F]{40}$/.test(previousContract) && !/^0x0{40}$/.test(previousContract),
    'Invalid previous contract');
  return { command, network: 'sepolia', deploymentId, previousContract: normalized(previousContract),
    previousDirectory: values['--previous-directory'] && path.resolve(values['--previous-directory']),
    directory: path.resolve(values['--directory'] || path.join(project, '.local', `111k-sepolia-${deploymentId ?? 'v16'}`)),
    keystore: values['--keystore'], passwordFile: values['--password-file'] };
}

function predecessorIdentity(value) {
  assert.equal(Number(value?.chainId), 11155111, 'The current predecessor must be on Sepolia');
  const contractAddress = normalized(value?.contractAddress);
  assert.match(contractAddress, /^0x[0-9a-f]{40}$/, 'Current predecessor contract is invalid');
  assert.notEqual(contractAddress, `0x${'0'.repeat(40)}`, 'The current predecessor is not deployed');
  const deploymentId = /^https:\/\/cdn\.mons\.shop\/111k-sepolia\/([a-z0-9][a-z0-9-]{0,63})\/$/.exec(value?.metadataBaseUri)?.[1];
  assert.ok(deploymentId, 'Current predecessor metadata namespace is invalid');
  return { chainId: 11155111, contractAddress, metadataBaseUri: value.metadataBaseUri, deploymentId };
}

export async function resolve111kPredecessor(overrides = {}) {
  const configured = await (overrides.readConfiguration ?? (async () => {
    const { unstable_readConfig } = await import('wrangler');
    const config = unstable_readConfig({ config: path.join(repository, 'cloud/workers/api/wrangler.jsonc'),
      'env-file': [path.join(repository, 'cloud/workers/api/release.env')] });
    return { chainId: config.vars.ETHEREUM_111K_CHAIN_ID, contractAddress: config.vars.ETHEREUM_111K_CONTRACT_ADDRESS,
      metadataBaseUri: config.vars.ETHEREUM_111K_METADATA_BASE_URI };
  }))();
  const live = await (overrides.readLiveConfiguration ?? (async () => {
    const response = await fetch('https://mons.shop/api/ethereum/111k/config', { headers: { Accept: 'application/json' },
      cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    assert.equal(response.status, 200, 'Cannot verify the live predecessor configuration');
    return response.json();
  }))();
  const expected = predecessorIdentity(configured);
  assert.deepEqual(predecessorIdentity(live), expected, 'Repository and live predecessor configurations differ');
  return expected;
}

export function nft111kDeploymentGas(estimate, gasPrice) {
  return deploymentGas(estimate, gasPrice, NFT111K_SEPOLIA.maximumFeeWei);
}

export function nft111kMintedCrate(manifest, receipt) {
  assert.ok(receipt && receipt.status === '0x1' && normalized(receipt.to) === manifest.contractAddress &&
    normalized(receipt.from) === manifest.deployer, 'A successful QA mint receipt for this collection is required');
  const topic = hashHex(`0x${Buffer.from('CratesPurchased(address,uint256,uint256,uint256)').toString('hex')}`);
  const events = receipt.logs.filter(log => normalized(log.address) === manifest.contractAddress && log.topics?.[0] === topic);
  assert.equal(events.length, 1, 'QA mint receipt must contain one crate purchase');
  assert.equal(events[0].topics.length, 2);
  assert.equal(normalized(`0x${events[0].topics[1].slice(-40)}`), manifest.deployer, 'QA crate buyer changed');
  const [tokenId, quantity, paid] = decoded(['uint256', 'uint256', 'uint256'], events[0].data);
  assert.equal(quantity, 1n, 'QA must purchase exactly one crate');
  assert.equal(paid, 100000000000000n, 'QA crate payment changed');
  assert.ok(tokenId >= 111112n && tokenId <= 116666n, 'QA receipt has an invalid crate ID');
  return tokenId.toString();
}

export function nft111kAction(manifest, action, mintReceipt) {
  assert.equal(manifest.chainId, 11155111, 'Only Sepolia actions are supported');
  assert.notEqual(manifest.contractAddress, manifest.previousContract, 'Old and new collections must differ');
  if (action === 'deploy') return { to: null, data: manifest.creationCode, valueWei: '0' };
  if (action === 'reserve') return { to: manifest.contractAddress, data: calldata('allocateRelics(uint256)', ['uint256'], [18]), valueWei: '18000000000000000' };
  if (action === 'pause-old-sale') return { to: manifest.previousContract, data: calldata('setSaleActive(bool)', ['bool'], [false]), valueWei: '0' };
  if (action === 'pause-old-redemptions') return { to: manifest.previousContract, data: calldata('setRedemptionsPaused(bool)', ['bool'], [true]), valueWei: '0' };
  if (action === 'open') return { to: manifest.contractAddress, data: calldata('setSaleActive(bool)', ['bool'], [true]), valueWei: '0' };
  if (action === 'mint-qa') return { to: manifest.contractAddress, data: calldata('mintCrates(uint256)', ['uint256'], [1]), valueWei: '100000000000000' };
  assert.equal(action, 'unpack-qa', 'Unsupported deployment action');
  return { to: manifest.contractAddress, data: calldata('unboxCrate(uint256)', ['uint256'], [nft111kMintedCrate(manifest, mintReceipt)]), valueWei: '0' };
}

function validateRecordedTransaction(transaction, record, hash) {
  assert.equal(normalized(transaction.signer ?? transaction.from), record.from, 'Unexpected transaction signer');
  if (transaction.from !== undefined) assert.equal(normalized(transaction.from), record.from, 'Unexpected transaction sender');
  assert.equal(transaction.type, '0x0', 'Expected a legacy transaction');
  assert.equal(BigInt(transaction.chainId), 11155111n, 'Wrong transaction chain');
  assert.equal(BigInt(record.chainId), 11155111n, 'Wrong journal chain');
  assert.equal(normalized(transaction.to), record.to, 'Transaction target changed');
  assert.equal(transaction.input, record.data, 'Transaction calldata changed');
  assert.equal(BigInt(transaction.value).toString(), record.valueWei, 'Transaction value changed');
  assert.equal(BigInt(transaction.nonce).toString(), record.nonce, 'Transaction nonce changed');
  assert.equal(BigInt(transaction.gas).toString(), record.gasLimit, 'Transaction gas limit changed');
  assert.equal(BigInt(transaction.gasPrice).toString(), record.gasPrice, 'Transaction gas price changed');
  assert.equal(transaction.hash, hash, 'Transaction hash changed');
  assert.ok(BigInt(record.gasLimit) > 0n && BigInt(record.gasPrice) > 0n, 'Invalid gas allowance');
  assert.equal((BigInt(record.gasLimit) * BigInt(record.gasPrice)).toString(), record.maximumFeeWei, 'Journal fee changed');
  assert.ok(BigInt(record.maximumFeeWei) <= BigInt(NFT111K_SEPOLIA.maximumFeeWei), 'Transaction exceeds the Sepolia fee ceiling');
}

export function validateSigned111kTransaction(transaction, manifest, record, hash) {
  assert.equal(record.from, manifest.deployer, 'Journal signer changed');
  assert.equal(record.hash, hash, 'Journal hash changed');
  if (record.action === 'deploy' && manifest.nonce !== undefined) assert.equal(record.nonce, manifest.nonce, 'Deployment nonce changed');
  const action = nft111kAction(manifest, record.action, record.mintReceipt);
  for (const key of ['to', 'data', 'valueWei']) assert.equal(record[key], action[key], `Journal ${key} changed`);
  validateRecordedTransaction(transaction, record, hash);
}

export async function confirm111kTransaction(rpc, record, options = {}) {
  const wait = options.sleep ?? sleep;
  const maximum = options.maxReceiptPolls ?? 180;
  requireSepoliaChain(await rpc('eth_chainId'));
  for (let attempt = 0; attempt < maximum; attempt++) {
    const receipt = await rpc('eth_getTransactionReceipt', [record.hash]);
    if (receipt) {
      assert.equal(receipt.transactionHash, record.hash, 'Receipt transaction hash changed');
      assert.equal(receipt.status, '0x1', 'Journaled transaction reverted');
      assert.equal(normalized(receipt.from), record.from, 'Receipt sender changed');
      assert.equal(normalized(receipt.to), record.to, 'Receipt target changed');
      if (record.to === null && record.contractAddress) {
        assert.equal(normalized(receipt.contractAddress), record.contractAddress, 'Unexpected deployed contract');
      }
      const [latest, canonical] = await Promise.all([
        rpc('eth_getBlockByNumber', ['latest', false]), rpc('eth_getBlockByNumber', [receipt.blockNumber, false]),
      ]);
      assert.equal(canonical?.hash, receipt.blockHash, 'Receipt is no longer canonical; reconcile the reorg');
      if (BigInt(latest.number) >= BigInt(receipt.blockNumber) + 2n) {
        const transaction = await rpc('eth_getTransactionByHash', [record.hash]);
        assert.ok(transaction, 'Confirmed transaction is unavailable');
        validateRecordedTransaction(transaction, record, record.hash);
        if (transaction.blockHash !== undefined) assert.equal(transaction.blockHash, receipt.blockHash, 'Transaction block changed');
        if (transaction.blockNumber !== undefined) assert.equal(BigInt(transaction.blockNumber), BigInt(receipt.blockNumber), 'Transaction block number changed');
        return receipt;
      }
    }
    if (attempt + 1 < maximum) await wait(1000);
  }
  throw new Error('Transaction is pending three canonical confirmations; resume the same action');
}

function constructorArgs(manifest) {
  return `0x${Buffer.from(encode(['address', 'address', 'address', 'string', 'bytes32', 'address[]', 'uint256[]',
    '(address,uint16,uint16,uint16)[]', 'uint256'], [manifest.owner, manifest.quoteSigner, manifest.initialDeliveryReceiver,
    manifest.metadataBaseURI, manifest.discountRoot, manifest.proceeds.mintRecipients, manifest.proceeds.mintSharesBps,
    manifest.freeMintAllocations.map(value => [value.wallet, value.crateLimit, value.warehouseLimit, value.relicLimit]),
    manifest.maxDiscountedMints])).toString('hex')}`;
}

function frozenCompilerInput(artifact) {
  const sources = {};
  for (const [source, metadata] of Object.entries(artifact.metadata.sources)) {
    const filename = path.resolve(project, source);
    assert.ok(filename.startsWith(`${path.resolve(project)}${path.sep}`), 'Compiler source escapes contract project');
    const content = fs.readFileSync(filename, 'utf8');
    assert.equal(hashHex(`0x${Buffer.from(content).toString('hex')}`), metadata.keccak256, `Build artifact is stale: ${source}`);
    sources[source] = { content };
  }
  const { compilationTarget, ...settings } = artifact.metadata.settings;
  assert.deepEqual(compilationTarget, { 'src/NFT111K.sol': 'NFT111K' });
  assert.equal(artifact.metadata.compiler.version, '0.8.38+commit.1835d247');
  assert.equal(settings.optimizer?.enabled, true);
  assert.equal(settings.optimizer?.runs, 500);
  assert.equal(settings.evmVersion, 'prague');
  assert.equal(settings.metadata?.bytecodeHash, 'none');
  assert.ok(!settings.viaIR, 'Unexpected compiler pipeline');
  return { language: 'Solidity', sources, settings: { ...settings,
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'metadata'], '': ['ast'] } } } };
}

function compileFrozen(input, original) {
  const binary = [path.join(os.homedir(), 'Library/Application Support/svm/0.8.38/solc-0.8.38'),
    path.join(os.homedir(), '.svm/0.8.38/solc-0.8.38')].find(filename => fs.existsSync(filename));
  assert.ok(binary, 'Pinned Solidity 0.8.38 compiler is unavailable');
  const output = JSON.parse(execFileSync(binary, ['--standard-json'], { input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  assert.ok(!output.errors?.some(error => error.severity === 'error'), 'Frozen Solidity compilation failed');
  const compiled = output.contracts['src/NFT111K.sol'].NFT111K;
  const artifact = { abi: compiled.abi, bytecode: { ...compiled.evm.bytecode, object: `0x${compiled.evm.bytecode.object}` },
    deployedBytecode: { ...compiled.evm.deployedBytecode, object: `0x${compiled.evm.deployedBytecode.object}` },
    metadata: JSON.parse(compiled.metadata), rawMetadata: compiled.metadata };
  assert.equal(artifact.bytecode.object, original.bytecode.object, 'Frozen creation bytecode differs from the build');
  assert.equal(artifact.deployedBytecode.object, original.deployedBytecode.object, 'Frozen runtime differs from the build');
  const immutableNames = {};
  const references = artifact.deployedBytecode.immutableReferences;
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (value.nodeType === 'VariableDeclaration' && value.mutability === 'immutable' && Object.hasOwn(references, value.id)) {
      immutableNames[String(value.id)] = value.name;
    }
    for (const nested of Object.values(value)) if (typeof nested === 'object') {
      if (Array.isArray(nested)) nested.forEach(visit); else visit(nested);
    }
  };
  for (const source of Object.values(output.sources)) visit(source.ast);
  assert.deepEqual(Object.keys(immutableNames).sort(), Object.keys(references).sort(), 'Incomplete runtime immutable mapping');
  return { artifact, output, immutableNames };
}

function requireConfiguration(manifest, configuration, deploymentId) {
  assert.equal(manifest.version, 1, 'Unsupported release manifest');
  assert.equal(manifest.network, 'sepolia', 'Wrong release network');
  assert.equal(manifest.chainId, 11155111, 'Wrong release chain');
  for (const key of ['deployer', 'owner', 'quoteSigner']) {
    assert.equal(manifest[key], normalized(configuration[key]), `Release ${key} changed`);
  }
  assert.match(manifest.previousContract, /^0x[0-9a-f]{40}$/);
  assert.notEqual(manifest.previousContract, `0x${'0'.repeat(40)}`, 'Invalid frozen previous contract');
  if (configuration.previousContract !== undefined) assert.equal(manifest.previousContract, normalized(configuration.previousContract), 'Release previousContract changed');
  assert.ok(/^[a-z0-9][a-z0-9-]{0,63}$/.test(manifest.deploymentId), 'Invalid release deployment ID');
  if (deploymentId) assert.equal(manifest.deploymentId, deploymentId, 'Release deployment ID changed');
  assert.equal(manifest.metadataBaseURI, `https://cdn.mons.shop/111k-sepolia/${manifest.deploymentId}/`);
  assert.equal(manifest.constructorArgs, constructorArgs(manifest), 'Frozen constructor changed');
  parseProceedsConfig(manifest.proceeds, manifest.contractAddress);
  parseInitialDeliveryReceiver({ initialReceiver: manifest.initialDeliveryReceiver }, manifest.contractAddress, manifest.proceeds.mintRecipients);
}

function loadFrozen(directory, configuration, deploymentId) {
  const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
  const manifest = read('manifest.json');
  requireConfiguration(manifest, configuration, deploymentId);
  const artifact = read('NFT111K.artifact.json');
  const input = read('NFT111K.standard-input.json');
  const output = read('NFT111K.compiler-output.json');
  const configs = read('config.snapshot.json');
  assert.deepEqual(Object.keys(configs).sort(), [...configPaths].sort(), 'Frozen configuration files changed');
  for (const [value, expected, label] of [[artifact, manifest.artifactSha256, 'artifact'], [input, manifest.standardInputSha256, 'compiler input'],
    [output, manifest.compilerOutputSha256, 'compiler output'], [configs, manifest.configSnapshotSha256, 'configuration']]) {
    assert.equal(sha256(json(value)), expected, `Frozen ${label} changed`);
  }
  const proceeds = parseProceedsConfig(JSON.parse(configs['config/proceeds.json']), manifest.contractAddress);
  assert.deepEqual(manifest.proceeds, proceeds, 'Mint split differs from the frozen configuration');
  assert.deepEqual(manifest.freeMintAllocations,
    parseFreeMintConfigJson(configs['config/free-mints.sepolia.json'], manifest.contractAddress, 11155111).allocations,
    'Free allowances differ from the frozen configuration');
  assert.equal(manifest.initialDeliveryReceiver,
    parseInitialDeliveryReceiver(JSON.parse(configs['config/delivery-routing.json']), manifest.contractAddress, proceeds.mintRecipients),
    'Delivery receiver differs from the frozen configuration');
  assert.equal(manifest.maxDiscountedMints, parseDiscountCapConfigJson(configs['config/discount-caps.json'], 11155111));
  assert.equal(manifest.discountRoot, JSON.parse(configs['../../src/ethereum/discounts/111k.json']).root);
  assert.deepEqual(manifest.sourceConfigSha256, Object.fromEntries(Object.entries(configs).map(([name, content]) => [name, sha256(content)])));
  assert.equal(manifest.creationCode, artifact.bytecode.object + manifest.constructorArgs.slice(2), 'Creation bytecode changed');
  assert.ok((artifact.deployedBytecode.object.length - 2) / 2 <= 24576, 'Runtime exceeds EIP-170');
  assert.ok((manifest.creationCode.length - 2) / 2 <= 49152, 'Initcode exceeds EIP-3860');
  return { manifest, artifact, input, configs, manifestSha256: sha256(json(manifest)) };
}

function requireCurrentSources(frozen) {
  for (const [source, entry] of Object.entries(frozen.input.sources)) {
    const filename = path.resolve(project, source);
    assert.ok(filename.startsWith(`${path.resolve(project)}${path.sep}`), 'Compiler source escapes contract project');
    assert.equal(fs.readFileSync(filename, 'utf8'), entry.content, `Source changed after preparation: ${source}`);
  }
  for (const [source, content] of Object.entries(frozen.configs)) {
    assert.equal(fs.readFileSync(path.resolve(project, source), 'utf8'), content, `Configuration changed after preparation: ${source}`);
  }
}

function defaultRpc() {
  const url = process.env.ETHEREUM_111K_RPC_URL || (process.env.ALCHEMY_API_KEY
    ? `https://eth-sepolia.g.alchemy.com/v2/${encodeURIComponent(process.env.ALCHEMY_API_KEY)}` : undefined);
  assert.ok(url, 'Set ETHEREUM_111K_RPC_URL or ALCHEMY_API_KEY');
  const parsed = new URL(url);
  assert.ok(parsed.protocol === 'https:' && !parsed.username && !parsed.password, 'Public deployment requires an HTTPS RPC');
  return async (method, params = []) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
    assert.ok(response.ok, `Sepolia RPC returned HTTP ${response.status}`);
    const body = await response.json();
    assert.ok(!body.error && Object.hasOwn(body, 'result'), `Sepolia RPC failed for ${method}`);
    return body.result;
  };
}

async function requireNonce(rpc, deployer, expected) {
  for (const block of ['latest', 'pending']) {
    assert.equal(BigInt(await rpc('eth_getTransactionCount', [deployer, block])).toString(), String(expected),
      'Deployer nonce changed or is occupied; reconcile the journal before retrying');
  }
}

async function call(rpc, contract, signature, types, argumentTypes = [], values = [], block = 'latest') {
  return decoded(types, await rpc('eth_call', [{ to: contract, data: calldata(signature, argumentTypes, values) }, block]));
}

async function requireNewCollection(rpc, frozen) {
  const { manifest: manifest, artifact } = frozen;
  const code = await rpc('eth_getCode', [manifest.contractAddress, 'latest']);
  assert.ok(matchingRuntime(artifact.deployedBytecode.object, code, artifact.deployedBytecode.immutableReferences), 'New collection runtime mismatch');
  for (const [signature, type, expected] of [['owner()', 'address', manifest.owner], ['quoteSigner()', 'address', manifest.quoteSigner],
    ['baseURI()', 'string', manifest.metadataBaseURI], ['maxDiscountedMints()', 'uint256', BigInt(manifest.maxDiscountedMints)],
    ['mintRecipientCount()', 'uint256', BigInt(manifest.proceeds.mintRecipients.length)]]) {
    assert.equal((await call(rpc, manifest.contractAddress, signature, [type]))[0], expected, `New collection ${signature} changed`);
  }
}

async function preflightAction(rpc, frozen, action, journal) {
  const { manifest } = frozen;
  const number = async (signature, contract = manifest.contractAddress) =>
    (await call(rpc, contract, signature, ['uint256']))[0];
  const boolean = async (signature, contract = manifest.contractAddress) =>
    (await call(rpc, contract, signature, ['bool']))[0];
  if (action === 'deploy') {
    assert.equal(await rpc('eth_getCode', [manifest.contractAddress, 'latest']), '0x', 'Predicted address already has code');
    assert.equal((await call(rpc, manifest.previousContract, 'owner()', ['address']))[0], manifest.owner, 'Old collection owner changed');
    return false;
  }
  assert.ok(journal.actions.deploy?.receipt, 'Confirm deployment first');
  await requireNewCollection(rpc, frozen);
  if (action === 'reserve') {
    assert.equal(await boolean('saleActive()'), false, 'New sale must remain closed before reservation');
    for (const getter of ['totalSupply()', 'allocatedCrates()', 'relicsAllocated()', 'totalMintReceived()', 'totalMintReleased()']) {
      assert.equal(await number(getter), 0n, `Reservation precondition changed: ${getter}`);
    }
    return false;
  }
  assert.ok(journal.actions.reserve?.receipt, 'Confirm the relic reservation first');
  assert.equal(await number('relicsAllocated()'), 18n, 'Relic reservation changed');
  if (action.startsWith('pause-old-')) {
    assert.equal((await call(rpc, manifest.previousContract, 'owner()', ['address']))[0], manifest.owner, 'Old collection owner changed');
    return action === 'pause-old-sale' ? !await boolean('saleActive()', manifest.previousContract)
      : await boolean('redemptionsPaused()', manifest.previousContract);
  }
  assert.equal(await boolean('saleActive()', manifest.previousContract), false, 'Old sale is not paused');
  assert.equal(await boolean('redemptionsPaused()', manifest.previousContract), true, 'Old redemptions are not paused');
  if (action === 'open') {
    assert.equal(await boolean('saleActive()'), false, 'New sale was opened outside this journal');
    assert.equal(await number('totalSupply()'), 0n, 'Unexpected issuance before opening');
    const block = await rpc('eth_blockNumber');
    const [[received], [released], balance] = await Promise.all([
      call(rpc, manifest.contractAddress, 'totalMintReceived()', ['uint256'], [], [], block),
      call(rpc, manifest.contractAddress, 'totalMintReleased()', ['uint256'], [], [], block),
      rpc('eth_getBalance', [manifest.contractAddress, block]),
    ]);
    assert.equal(received, 18000000000000000n, 'Reserved proceeds changed before opening');
    assert.ok(released <= received, 'Released proceeds exceed received proceeds');
    assert.ok(BigInt(balance) >= received - released, 'Contract balance does not cover pending mint proceeds');
    return false;
  }
  assert.ok(journal.actions.open?.receipt, 'Confirm sale opening first');
  assert.equal(await boolean('saleActive()'), true, 'New sale is closed');
  if (action === 'mint-qa') {
    assert.equal(await number('cratePrice()'), 100000000000000n, 'QA crate price changed');
    assert.ok(await number('allocatedCrates()') < 5555n, 'No crate supply remains for QA');
  } else {
    const crate = nft111kMintedCrate(manifest, journal.actions['mint-qa']?.receipt);
    assert.equal((await call(rpc, manifest.contractAddress, 'ownerOf(uint256)', ['address'], ['uint256'], [crate]))[0], manifest.deployer,
      'QA crate is not held by the deployer');
  }
  return false;
}

export async function run111kDeployment(argv, overrides = {}) {
  const options = parse111kDeploymentArgs(argv);
  const configuration = { ...NFT111K_SEPOLIA, ...overrides.configuration,
    ...(options.previousContract ? { previousContract: options.previousContract } : {}) };
  assert.equal(configuration.chainId, 11155111, 'Only Sepolia is supported');
  for (const key of ['deployer', 'owner', 'quoteSigner', 'previousContract']) {
    assert.match(configuration[key], /^0x[0-9a-fA-F]{40}$/);
    configuration[key] = normalized(configuration[key]);
  }
  assert.equal(configuration.deployer, configuration.owner, 'The release signer must own both collections');
  const frozenConfiguration = options.command !== 'prepare' && !options.previousContract && overrides.configuration?.previousContract === undefined
    ? { ...configuration, previousContract: undefined } : configuration;
  const rpc = overrides.rpc ?? defaultRpc();
  const runCast = overrides.cast ?? cast;
  const now = overrides.now ?? (() => new Date().toISOString());
  const requireChain = async () => requireSepoliaChain(await rpc('eth_chainId'));
  await requireChain();
  const read = name => JSON.parse(fs.readFileSync(path.join(options.directory, name), 'utf8'));

  if (options.command === 'verify') {
    options.directory = fs.realpathSync(options.directory);
    const frozen = loadFrozen(options.directory, frozenConfiguration, options.deploymentId);
    const journal = read('transactions.private.json');
    assert.equal(journal.manifestSha256, frozen.manifestSha256, 'Release manifest changed after signing');
    assert.ok(journal.actions && typeof journal.actions === 'object' && !Array.isArray(journal.actions), 'Invalid transaction journal');
    assert.ok(Object.keys(journal.actions).every(action => actionOrder.includes(action)), 'Unexpected journal action');
    const transactions = [];
    for (const action of actionOrder) {
      const record = journal.actions[action];
      if (record !== undefined) {
        assert.ok(record && typeof record === 'object' && !Array.isArray(record), 'Invalid transaction journal record');
        assert.equal(record.action, action, 'Journal action identity changed');
        assert.equal(record.from, frozen.manifest.deployer, 'Journal signer changed');
        assert.equal(record.contractAddress, frozen.manifest.contractAddress, 'Journal collection identity changed');
        assert.match(record.raw, /^0x(?:[a-f0-9]{2})+$/i, 'Journal signed transaction is missing');
        assert.equal(hashHex(record.raw), record.hash, 'Journaled transaction changed');
        const intended = nft111kAction(frozen.manifest, action, journal.actions['mint-qa']?.receipt);
        for (const key of ['to', 'data', 'valueWei']) assert.equal(record[key], intended[key], `Journal ${key} changed`);
        if (action === 'deploy') assert.equal(record.nonce, frozen.manifest.nonce, 'Deployment nonce changed');
        const receipt = await confirm111kTransaction(rpc, record, { ...overrides, maxReceiptPolls: 1 });
        transactions.push({ action, hash: record.hash, blockNumber: Number(BigInt(receipt.blockNumber)) });
      }
    }
    await requireNewCollection(rpc, frozen);
    const state = {};
    for (const getter of ['saleActive', 'redemptionsPaused', 'totalSupply', 'allocatedCrates', 'relicsAllocated', 'relicsMinted',
      'getRelicClaimedMask', 'totalMintReceived', 'totalMintReleased']) {
      const value = (await call(rpc, frozen.manifest.contractAddress, `${getter}()`, [getter.endsWith('Active') || getter.endsWith('Paused') ? 'bool' : 'uint256']))[0];
      state[getter] = typeof value === 'bigint' ? value.toString() : value;
    }
    state.artworksMinted = (await call(rpc, frozen.manifest.contractAddress, 'stats(address)',
      ['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bool', 'bytes32',
        'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'], ['address'], [frozen.manifest.deployer]))[2].toString();
    return { verified: true, chainId: 11155111, contractAddress: frozen.manifest.contractAddress,
      deploymentId: frozen.manifest.deploymentId, metadataBaseURI: frozen.manifest.metadataBaseURI, transactions, state };
  }

  return withLock(options.directory, async directory => {
    options.directory = directory;
    if (options.command === 'prepare') {
      assert.ok(!fs.existsSync(path.join(options.directory, 'manifest.json')) && !fs.existsSync(path.join(options.directory, 'transactions.private.json')),
        'Release state already exists; resume its next action');
      assert.ok(fs.readdirSync(options.directory).every(name => name === 'operation.lock' || /^\.operation\.lock-[a-zA-Z0-9]+$/.test(name)),
        'Prepare requires a fresh release directory; keep signing material and unrelated files outside it');
      const predecessor = predecessorIdentity(await (overrides.resolvePredecessor ?? resolve111kPredecessor)());
      assert.notEqual(options.deploymentId, predecessor.deploymentId, 'Replacement deployment ID must differ from the current metadata namespace');
      if (options.previousContract || overrides.configuration?.previousContract !== undefined) {
        assert.equal(configuration.previousContract, predecessor.contractAddress, 'Explicit predecessor does not match the current deployment');
      }
      configuration.previousContract = predecessor.contractAddress;
      const nonce = BigInt(await rpc('eth_getTransactionCount', [configuration.deployer, 'latest'])).toString();
      await requireNonce(rpc, configuration.deployer, nonce);
      const previousLocation = await resolve111kReleaseLocation(predecessor,
        { ...overrides.releaseLocationOptions, directory: options.previousDirectory });
      assert.ok(![path.relative(previousLocation.directory, options.directory), path.relative(options.directory, previousLocation.directory)]
        .some(relative => relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)),
      'Old and replacement release directories must not overlap');
      const contractAddress = normalized(runCast(['compute-address', configuration.deployer, '--nonce', nonce]).match(/0x[0-9a-fA-F]{40}/)?.[0]);
      assert.ok(contractAddress, 'Unable to predict deployment address');
      assert.equal(await rpc('eth_getCode', [contractAddress, 'latest']), '0x', 'Predicted address already has code');
      const configs = Object.fromEntries(configPaths.map(filename => [filename, fs.readFileSync(path.resolve(project, filename), 'utf8')]));
      const proceeds = parseProceedsConfig(JSON.parse(configs['config/proceeds.json']), contractAddress);
      assert.equal(proceeds.mintRecipients.length, 14, 'The committed mint split must contain fourteen recipients');
      const freeMintAllocations = parseFreeMintConfigJson(configs['config/free-mints.sepolia.json'], contractAddress, 11155111).allocations;
      assert.equal(freeMintAllocations.length, 7, 'The Sepolia preset must contain seven wallets');
      assert.equal(freeMintAllocations.reduce((total, value) => total + value.relicLimit, 0), 18);
      assert.ok(freeMintAllocations.every(value => value.crateLimit === 0 && value.warehouseLimit === 0));
      const initialDeliveryReceiver = parseInitialDeliveryReceiver(JSON.parse(configs['config/delivery-routing.json']), contractAddress, proceeds.mintRecipients);
      const maxDiscountedMints = parseDiscountCapConfigJson(configs['config/discount-caps.json'], 11155111);
      const discountRoot = JSON.parse(configs['../../src/ethereum/discounts/111k.json']).root;
      assert.match(discountRoot, /^0x[0-9a-f]{64}$/i);
      const original = JSON.parse(fs.readFileSync(path.join(project, 'out/NFT111K.sol/NFT111K.json'), 'utf8'));
      const input = frozenCompilerInput(original);
      const { artifact, output, immutableNames } = compileFrozen(input, original);
      const deploymentId = options.deploymentId;
      const manifest = { version: 1, network: 'sepolia', ...configuration, deploymentId,
        previousReleaseDirectory: previousLocation.directory, previousReleaseManifestSha256: previousLocation.manifestSha256,
        metadataBaseURI: `https://cdn.mons.shop/111k-sepolia/${deploymentId}/`, contractAddress, nonce,
        initialDeliveryReceiver, initialDeliveryConfigId: 1, discountRoot, maxDiscountedMints, proceeds, freeMintAllocations,
        preparedAt: now(), artifactSha256: sha256(json(artifact)), standardInputSha256: sha256(json(input)),
        compilerOutputSha256: sha256(json(output)), configSnapshotSha256: sha256(json(configs)),
        sourceConfigSha256: Object.fromEntries(Object.entries(configs).map(([name, content]) => [name, sha256(content)])), immutableNames };
      manifest.constructorArgs = constructorArgs(manifest);
      manifest.creationCode = artifact.bytecode.object + manifest.constructorArgs.slice(2);
      assert.ok((artifact.deployedBytecode.object.length - 2) / 2 <= 24576, 'Runtime exceeds EIP-170');
      assert.ok((manifest.creationCode.length - 2) / 2 <= 49152, 'Initcode exceeds EIP-3860');
      assert.equal((await call(rpc, manifest.previousContract, 'owner()', ['address']))[0], manifest.owner, 'Old collection owner changed');
      const transaction = { from: manifest.deployer, data: manifest.creationCode, value: '0x0' };
      Object.assign(manifest, nft111kDeploymentGas(await rpc('eth_estimateGas', [transaction]), await rpc('eth_gasPrice')));
      validateDeploymentBalance(await rpc('eth_getBalance', [manifest.deployer, 'latest']), manifest.maximumFeeWei);
      await rpc('eth_call', [{ ...transaction, gas: hex(manifest.gasLimit) }, 'latest']);
      durableWrite(path.join(options.directory, 'NFT111K.artifact.json'), artifact);
      durableWrite(path.join(options.directory, 'NFT111K.standard-input.json'), input);
      durableWrite(path.join(options.directory, 'NFT111K.compiler-output.json'), output);
      durableWrite(path.join(options.directory, 'config.snapshot.json'), configs);
      durableWrite(path.join(options.directory, 'manifest.json'), manifest);
      await record111kReleaseLocation(options.directory, { chainId: manifest.chainId, deploymentId,
        contractAddress, metadataBaseUri: manifest.metadataBaseURI }, overrides.releaseLocationOptions);
      return { prepared: true, chainId: 11155111, deploymentId, contractAddress, nonce, metadataBaseURI: manifest.metadataBaseURI,
        gasEstimate: manifest.gasEstimate, gasLimit: manifest.gasLimit, maximumFeeWei: manifest.maximumFeeWei };
    }

    const frozen = loadFrozen(options.directory, frozenConfiguration, options.deploymentId);
    const { manifest } = frozen;
    await record111kReleaseLocation(options.directory, { chainId: manifest.chainId, deploymentId: manifest.deploymentId,
      contractAddress: manifest.contractAddress, metadataBaseUri: manifest.metadataBaseURI }, overrides.releaseLocationOptions);
    if (options.previousDirectory) {
      const previous = JSON.parse(fs.readFileSync(path.join(options.previousDirectory, 'manifest.json'), 'utf8'));
      assert.equal(previous.contractAddress, manifest.previousContract, 'Previous release directory belongs to another contract');
      await record111kReleaseLocation(options.previousDirectory, { chainId: previous.chainId, deploymentId: previous.deploymentId,
        contractAddress: previous.contractAddress, metadataBaseUri: previous.metadataBaseUri ?? previous.metadataBaseURI }, overrides.releaseLocationOptions);
    }
    const predicted = normalized(runCast(['compute-address', manifest.deployer, '--nonce', manifest.nonce]).match(/0x[0-9a-fA-F]{40}/)?.[0]);
    assert.equal(predicted, manifest.contractAddress, 'Predicted CREATE address changed');
    const journalPath = path.join(options.directory, 'transactions.private.json');
    const journal = fs.existsSync(journalPath) ? read('transactions.private.json') : { manifestSha256: frozen.manifestSha256, actions: {} };
    assert.equal(journal.manifestSha256, frozen.manifestSha256, 'Manifest changed after signing');
    assert.ok(journal.actions && typeof journal.actions === 'object' && !Array.isArray(journal.actions), 'Invalid transaction journal');
    assert.ok(Object.keys(journal.actions).every(action => actionOrder.includes(action)), 'Unexpected journal action');
    let nextNonce = BigInt(manifest.nonce);
    for (const action of actionOrder) if (journal.actions[action]) {
      const record = journal.actions[action];
      assert.equal(record.action, action, 'Journal action identity changed');
      assert.equal(record.nonce, nextNonce.toString(), 'Journal nonce sequence changed');
      nextNonce++;
    }
    const save = () => durableWrite(journalPath, journal);
    const validateRaw = record => {
      assert.equal(hashHex(record.raw), record.hash, 'Journaled transaction changed');
      let transaction = JSON.parse(runCast(['decode-transaction', record.raw]));
      if (typeof transaction === 'string') transaction = JSON.parse(transaction);
      validateSigned111kTransaction(transaction, manifest, record, record.hash);
    };
    const refreshPrerequisites = async action => {
      for (const previousAction of actionOrder.slice(0, actionOrder.indexOf(action))) {
        const previous = journal.actions[previousAction];
        if (!previous?.raw) continue;
        validateRaw(previous);
        const receipt = await confirm111kTransaction(rpc, previous, { ...overrides, maxReceiptPolls: 1 });
        if (json(receipt) !== json(previous.receipt)) {
          previous.receipt = receipt;
          previous.confirmedAt = now();
          save();
        }
      }
    };
    const perform = async action => {
      let record = journal.actions[action];
      const resuming = Boolean(record);
      if (!record) {
        await refreshPrerequisites(action);
        requireCurrentSources(frozen);
        await requireChain();
        if (await preflightAction(rpc, frozen, action, journal)) return { action, alreadySatisfied: true };
        assert.ok(options.keystore && options.passwordFile, 'Signing requires --keystore and --password-file');
        const walletArgs = ['--keystore', options.keystore, '--password-file', options.passwordFile];
        assert.equal(normalized(runCast(['wallet', 'address', ...walletArgs])), manifest.deployer, 'Wrong deployer keystore');
        const nonce = (BigInt(manifest.nonce) + BigInt(Object.values(journal.actions).filter(value => value.raw).length)).toString();
        await requireNonce(rpc, manifest.deployer, nonce);
        const mintReceipt = action === 'unpack-qa' ? journal.actions['mint-qa']?.receipt : undefined;
        const intended = nft111kAction(manifest, action, mintReceipt);
        const request = { from: manifest.deployer, ...(intended.to ? { to: intended.to } : {}), data: intended.data, value: hex(intended.valueWei) };
        const estimate = await rpc('eth_estimateGas', [request]);
        const gas = action === 'deploy' ? Object.fromEntries(['gasEstimate', 'gasLimit', 'gasPrice', 'maximumFeeWei'].map(key => [key, manifest[key]]))
          : nft111kDeploymentGas(estimate, await rpc('eth_gasPrice'));
        assert.ok(BigInt(estimate) <= BigInt(gas.gasLimit), 'Gas estimate exceeds the frozen allowance');
        const [suggestion, latest, pending] = await Promise.all([
          rpc('eth_gasPrice'), rpc('eth_getBlockByNumber', ['latest', false]), rpc('eth_getBlockByNumber', ['pending', false]),
        ]);
        validateDeploymentGasPrice(gas.gasPrice, suggestion, latest.baseFeePerGas, pending.baseFeePerGas);
        for (const block of ['latest', 'pending']) {
          validateDeploymentBalance(await rpc('eth_getBalance', [manifest.deployer, block]), BigInt(gas.maximumFeeWei) + BigInt(intended.valueWei));
        }
        await rpc('eth_call', [{ ...request, gas: hex(gas.gasLimit) }, 'pending']);
        await requireNonce(rpc, manifest.deployer, nonce);
        record = { action, chainId: 11155111, from: manifest.deployer, contractAddress: manifest.contractAddress,
          ...intended, nonce, ...gas, ...(mintReceipt ? { mintReceipt } : {}), signedAt: now() };
        record.raw = runCast(['mktx', '--legacy', '--chain', '11155111', '--nonce', nonce, '--gas-limit', gas.gasLimit,
          '--gas-price', gas.gasPrice, '--value', intended.valueWei, ...walletArgs,
          ...(intended.to ? [intended.to, intended.data] : ['--create', intended.data])]);
        assert.match(record.raw, /^0x(?:[a-f0-9]{2})+$/i, 'Invalid signed transaction');
        record.hash = hashHex(record.raw);
        validateRaw(record);
        journal.actions[action] = record;
        save();
      } else validateRaw(record);
      const existing = await rpc('eth_getTransactionByHash', [record.hash]);
      if (!existing) {
        if (resuming) {
          await refreshPrerequisites(action);
          const intended = nft111kAction(manifest, action, journal.actions['mint-qa']?.receipt);
          for (const key of ['to', 'data', 'valueWei']) {
            assert.equal(record[key], intended[key], `Canonical prerequisite changed signed ${key}; reconcile the journal before retrying`);
          }
        }
        await requireChain();
        await requireNonce(rpc, manifest.deployer, record.nonce);
        record.broadcastAttemptedAt = now();
        save();
        assert.equal(await rpc('eth_sendRawTransaction', [record.raw]), record.hash, 'RPC returned an unexpected transaction hash');
        record.broadcastAcceptedAt = now();
        save();
      }
      record.receipt = await confirm111kTransaction(rpc, record, overrides);
      record.confirmedAt = now();
      save();
      if (action === 'deploy') durableWrite(path.join(options.directory, 'deployment.json'), {
        chainId: 11155111, deploymentId: manifest.deploymentId, contractAddress: manifest.contractAddress,
        metadataBaseURI: manifest.metadataBaseURI, deploymentBlock: Number(BigInt(record.receipt.blockNumber)),
        deploymentBlockHash: record.receipt.blockHash, transactionHash: record.hash, confirmations: 3,
        owner: manifest.owner, deployer: manifest.deployer, quoteSigner: manifest.quoteSigner, manifestSha256: frozen.manifestSha256,
        artifactSha256: manifest.artifactSha256, standardInputSha256: manifest.standardInputSha256,
      });
      return { action, hash: record.hash, blockNumber: Number(BigInt(record.receipt.blockNumber)),
        ...(resuming && existing ? { alreadySatisfied: true } : {}),
        ...(action === 'mint-qa' ? { crateTokenId: nft111kMintedCrate(manifest, record.receipt) } : {}) };
    };
    const finalize = async () => {
      assert.ok(journal.actions.open?.receipt, 'Confirm sale opening before finalizing replacement cleanup');
      await refreshPrerequisites('mint-qa');
      await requireChain();
      await requireNewCollection(rpc, frozen);
      assert.equal((await call(rpc, manifest.contractAddress, 'saleActive()', ['bool']))[0], true,
        'Replacement sale must be active before finalizing cleanup');
      try {
        const result = await (overrides.cleanupReplacement ?? run111kReplacementFinalization)({ releaseDirectory: options.directory });
        assert.equal(result?.complete, true, 'Cleanup did not verify complete retirement');
        return result;
      } catch (error) {
        throw new Error(`Replacement cleanup is incomplete; sale opening remains journaled. Retry finalize --directory ${options.directory}.`,
          { cause: error });
      }
    };
    if (options.command === 'finalize') {
      return { chainId: 11155111, deploymentId: manifest.deploymentId, contractAddress: manifest.contractAddress,
        transactions: [], cleanup: await finalize() };
    }
    const actions = options.command === 'pause-old' ? ['pause-old-sale', 'pause-old-redemptions'] : [options.command];
    const transactions = [];
    for (const action of actions) transactions.push(await perform(action));
    return { chainId: 11155111, deploymentId: manifest.deploymentId, contractAddress: manifest.contractAddress, transactions,
      ...(options.command === 'open' ? { cleanup: await finalize() } : {}) };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run111kDeployment(process.argv.slice(2)).then(result => console.log(json(result))).catch(error => {
    console.error(error instanceof assert.AssertionError || error?.message?.startsWith('Transaction is pending')
      || error?.message?.startsWith('Replacement cleanup is incomplete')
      ? error.message : '111K deployment operation failed; inspect the private journal before retrying.');
    process.exitCode = 1;
  });
}
