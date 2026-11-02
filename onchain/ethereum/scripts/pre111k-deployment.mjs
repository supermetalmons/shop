import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak_256 } from '@noble/hashes/sha3';

export const PRE111K_SEPOLIA = Object.freeze({
  chainId: 11155111,
  deployer: '0xd58d143ca63d9baccc33fdf69ea203f59c58ae93',
  admin: '0xd58d143ca63d9baccc33fdf69ea203f59c58ae93',
  treasury: '0x72d0c5623a05033f9ee4495d408bc6c05df8367d',
  quoteSigner: '0xcc4c8bfd93af9f36d46215a0206954bf6a14c3ca',
  priceWei: '2300000000000000',
  maximumFeeWei: '5000000000000000',
});

export const PRE111K_MAINNET = Object.freeze({
  chainId: 1,
  deployer: PRE111K_SEPOLIA.deployer,
  admin: PRE111K_SEPOLIA.treasury,
  treasury: PRE111K_SEPOLIA.treasury,
  priceWei: '2300000000000000000',
  maximumFeeWei: '1000000000000000',
});

const project = fileURLToPath(new URL('../', import.meta.url));
const json = value => JSON.stringify(value, null, 2) + '\n';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const hashHex = value => '0x' + Buffer.from(keccak_256(Buffer.from(value.slice(2), 'hex'))).toString('hex');
const run = args => execFileSync('cast', args, { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function deploymentConfiguration(network = 'sepolia', quoteSigner) {
  assert.ok(network === 'mainnet' || network === 'sepolia', 'Unsupported deployment network');
  if (network === 'sepolia') {
    assert.ok(quoteSigner === undefined || quoteSigner.toLowerCase() === PRE111K_SEPOLIA.quoteSigner, 'Unexpected Sepolia quote signer');
    return PRE111K_SEPOLIA;
  }
  assert.ok(typeof quoteSigner === 'string' && /^0x[0-9a-f]{40}$/i.test(quoteSigner) && !/^0x0{40}$/i.test(quoteSigner),
    'Mainnet preparation requires a nonzero --quote-signer address');
  assert.notEqual(quoteSigner.toLowerCase(), PRE111K_SEPOLIA.quoteSigner, 'Mainnet requires a separate quote signer');
  return { ...PRE111K_MAINNET, quoteSigner: quoteSigner.toLowerCase() };
}

export function validateDeploymentConfiguration(manifest, network) {
  const configuration = deploymentConfiguration(network, manifest.quoteSigner);
  for (const key of ['chainId', 'admin', 'treasury', 'quoteSigner', 'priceWei']) {
    assert.equal(manifest[key], configuration[key], 'Unexpected deployment ' + key);
  }
  assert.equal(manifest.deployer ?? manifest.admin, configuration.deployer, 'Unexpected deployer');
  if (manifest.network !== undefined) assert.equal(manifest.network, network, 'Deployment network changed');
  return configuration;
}

export function deploymentConstructorArgs(configuration) {
  return run(['abi-encode', 'constructor(address,address,address,uint256)', configuration.admin,
    configuration.treasury, configuration.quoteSigner, configuration.priceWei]);
}

function validateDeploymentFee(manifest, maximumFeeWei) {
  assert.ok(BigInt(manifest.gasPrice) > 0n && BigInt(manifest.gasLimit) > 0n, 'Invalid deployment gas allowance');
  assert.ok(BigInt(manifest.gasPrice) * BigInt(manifest.gasLimit) <= BigInt(maximumFeeWei), 'Deployment exceeds the network fee ceiling');
}

export function validateDeploymentBalance(balance, maximumFeeWei) {
  assert.ok(typeof balance === 'string' && /^0x[0-9a-f]+$/i.test(balance), 'Invalid deployer balance');
  assert.ok(BigInt(balance) >= BigInt(maximumFeeWei), 'Insufficient deployer funds');
}

export function validateSignedDeployment(transaction, manifest, hash) {
  const configuration = validateDeploymentConfiguration(manifest, manifest.chainId === 1 ? 'mainnet' : 'sepolia');
  assert.equal(transaction.signer.toLowerCase(), configuration.deployer, 'Unexpected transaction signer');
  assert.equal(transaction.type, '0x0', 'Expected legacy transaction');
  assert.equal(BigInt(transaction.chainId), BigInt(configuration.chainId), 'Unexpected transaction chain');
  assert.equal(BigInt(transaction.nonce).toString(), manifest.nonce);
  assert.equal(BigInt(transaction.gasPrice).toString(), manifest.gasPrice);
  assert.equal(BigInt(transaction.gas).toString(), manifest.gasLimit);
  assert.equal(transaction.to, null, 'Expected contract creation');
  assert.equal(BigInt(transaction.value), 0n, 'Deployment cannot transfer ETH');
  assert.equal(transaction.input, manifest.creationCode);
  assert.equal(transaction.hash, hash);
  validateDeploymentFee(manifest, configuration.maximumFeeWei);
}

function validateRaw(raw, manifest) {
  let decoded = JSON.parse(run(['decode-transaction', raw]));
  if (typeof decoded === 'string') decoded = JSON.parse(decoded);
  validateSignedDeployment(decoded, manifest, hashHex(raw));
}

export function deploymentGas(estimate, gasPrice, maximumFeeWei = PRE111K_SEPOLIA.maximumFeeWei) {
  assert.ok(BigInt(estimate) > 0n && BigInt(gasPrice) > 0n, 'Invalid gas estimate or gas price');
  const gasLimit = (BigInt(estimate) * 13n + 9n) / 10n + 50_000n;
  const bufferedGasPrice = (BigInt(gasPrice) * 3n + 1n) / 2n;
  const offeredGasPrice = bufferedGasPrice > 1000n ? bufferedGasPrice : 1000n;
  const maximumFee = gasLimit * offeredGasPrice;
  assert.ok(maximumFee <= BigInt(maximumFeeWei), 'Deployment exceeds the network fee ceiling');
  return { gasEstimate: BigInt(estimate).toString(), gasLimit: gasLimit.toString(),
    gasPrice: offeredGasPrice.toString(), maximumFeeWei: maximumFee.toString() };
}

export function validateDeploymentGasPrice(offered, suggested, latestBaseFee, pendingBaseFee) {
  const values = [offered, suggested, latestBaseFee, pendingBaseFee];
  assert.ok(values.every(value => typeof value === 'string' && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value)),
    'Missing or invalid deployment fee data');
  const [offer, suggestion, latest, pending] = values.map(BigInt);
  assert.ok(offer > 0n && suggestion > 0n, 'Invalid deployment gas price');
  assert.ok(offer >= suggestion && offer >= latest && offer >= pending,
    'Gas price increased beyond the frozen offer; prepare a new release before signing');
}

export function matchingRuntime(expected, actual, immutableReferences) {
  if (!/^0x(?:[a-fA-F0-9]{2})+$/.test(actual) || expected.length !== actual.length) return false;
  const left = Buffer.from(expected.slice(2), 'hex');
  const right = Buffer.from(actual.slice(2), 'hex');
  for (const references of Object.values(immutableReferences)) {
    for (const { start, length } of references) {
      assert.ok(Number.isInteger(start) && start >= 0 && Number.isInteger(length) && length > 0 && start + length <= left.length);
      left.fill(0, start, start + length);
      right.fill(0, start, start + length);
    }
  }
  return left.equals(right);
}

function durableWrite(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = filename + '.tmp';
  const descriptor = fs.openSync(temporary, 'w', 0o600);
  try { fs.writeFileSync(descriptor, json(value)); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, filename);
  const directory = fs.openSync(path.dirname(filename), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...arguments_] = argv;
  assert.ok(['prepare', 'sign', 'broadcast', 'verify'].includes(command),
    'Use prepare|sign|broadcast|verify --network mainnet|sepolia --directory PATH [--quote-signer ADDRESS for mainnet prepare] [--keystore PATH --password-file PATH]. RPC: ETHEREUM_PRE111K_RPC_URL or ALCHEMY_API_KEY.');
  const options = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    assert.ok(['--network', '--quote-signer', '--directory', '--keystore', '--password-file'].includes(key) && arguments_[index + 1] && !options[key], 'Invalid or repeated option');
    options[key] = arguments_[index + 1];
  }
  const network = options['--network'] || 'sepolia';
  assert.ok(!options['--quote-signer'] || (command === 'prepare' && network === 'mainnet'), '--quote-signer is only allowed for mainnet prepare');
  const directory = path.resolve(options['--directory'] || path.join(project, '.local/pre111k-' + network));
  const manifestPath = path.join(directory, 'manifest.json');
  const journalPath = path.join(directory, 'transactions.private.json');
  const manifest = command === 'prepare' ? null : JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const configuration = manifest ? validateDeploymentConfiguration(manifest, network) : deploymentConfiguration(network, options['--quote-signer']);
  const deployer = configuration.deployer;
  const rpcUrl = process.env.ETHEREUM_PRE111K_RPC_URL ||
    (process.env.ALCHEMY_API_KEY ? 'https://eth-' + network + '.g.alchemy.com/v2/' + encodeURIComponent(process.env.ALCHEMY_API_KEY) : null);
  assert.ok(rpcUrl, 'Missing ' + network + ' RPC configuration');
  const parsedRpcUrl = new URL(rpcUrl);
  assert.ok(parsedRpcUrl.protocol === 'https:', 'Public deployment requires an HTTPS RPC');
  const rpc = async (method, params = []) => {
    const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
    assert.ok(response.ok, network + ' RPC HTTP ' + response.status);
    const body = await response.json();
    assert.ok(!body.error && Object.hasOwn(body, 'result'), network + ' RPC failed for ' + method);
    return body.result;
  };
  const requireChain = async () => {
    const chainId = await rpc('eth_chainId');
    assert.ok(typeof chainId === 'string' && /^0x[0-9a-f]+$/i.test(chainId), 'Invalid RPC chain ID');
    assert.equal(BigInt(chainId), BigInt(configuration.chainId), 'RPC does not match the selected deployment network');
  };
  await requireChain();

  if (command === 'prepare') {
    assert.ok(!fs.existsSync(manifestPath) && !fs.existsSync(journalPath), 'Deployment directory already contains a release; resume it instead');
    const artifact = JSON.parse(fs.readFileSync(path.join(project, 'out/Pre111K.sol/Pre111K.json'), 'utf8'));
    assert.equal(artifact.metadata.compiler.version, '0.8.38+commit.1835d247');
    assert.equal(artifact.metadata.settings.optimizer.runs, 500);
    assert.equal(artifact.metadata.settings.evmVersion, 'prague');
    const nonce = BigInt(await rpc('eth_getTransactionCount', [deployer, 'latest']));
    assert.equal(BigInt(await rpc('eth_getTransactionCount', [deployer, 'pending'])), nonce, 'Resolve pending deployer transactions first');
    const predicted = run(['compute-address', deployer, '--nonce', nonce.toString()]).match(/0x[0-9a-fA-F]{40}/)?.[0]?.toLowerCase();
    assert.ok(predicted);
    assert.equal(await rpc('eth_getCode', [predicted, 'latest']), '0x', 'Predicted deployment address already has code');
    const constructorArgs = deploymentConstructorArgs(configuration);
    const creationCode = artifact.bytecode.object + constructorArgs.slice(2);
    const estimate = await rpc('eth_estimateGas', [{ from: deployer, data: creationCode, value: '0x0' }]);
    const gas = deploymentGas(estimate, await rpc('eth_gasPrice'), configuration.maximumFeeWei);
    validateDeploymentBalance(await rpc('eth_getBalance', [deployer, 'latest']), gas.maximumFeeWei);
    const sources = {};
    for (const [source, metadata] of Object.entries(artifact.metadata.sources)) {
      const filename = path.resolve(project, source);
      assert.ok(filename.startsWith(project), 'Source escapes contract project');
      const content = fs.readFileSync(filename, 'utf8');
      assert.equal(hashHex('0x' + Buffer.from(content).toString('hex')), metadata.keccak256, 'Build artifact is stale: ' + source);
      sources[source] = { content };
    }
    const { compilationTarget, ...settings } = artifact.metadata.settings;
    assert.deepEqual(compilationTarget, { 'src/Pre111K.sol': 'Pre111K' });
    const standardInput = { language: 'Solidity', sources,
      settings: { ...settings, outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'metadata'] } } } };
    const manifest = { network, ...configuration, preparedAt: new Date().toISOString(), contractAddress: predicted,
      nonce: nonce.toString(), constructorArgs, creationCode, ...gas,
      artifactSha256: sha256(json(artifact)), standardInputSha256: sha256(json(standardInput)) };
    durableWrite(path.join(directory, 'Pre111K.artifact.json'), artifact);
    durableWrite(path.join(directory, 'Pre111K.standard-input.json'), standardInput);
    durableWrite(manifestPath, manifest);
    console.log(json({ prepared: true, contractAddress: predicted, nonce: manifest.nonce,
      gasEstimate: manifest.gasEstimate, gasLimit: manifest.gasLimit, maximumFeeWei: manifest.maximumFeeWei }));
    return;
  }

  assert.equal(manifest.constructorArgs, deploymentConstructorArgs(configuration), 'Constructor configuration changed');
  validateDeploymentFee(manifest, configuration.maximumFeeWei);
  const predicted = run(['compute-address', deployer, '--nonce', manifest.nonce])
    .match(/0x[0-9a-fA-F]{40}/)?.[0]?.toLowerCase();
  assert.equal(manifest.contractAddress, predicted, 'Predicted CREATE address changed');
  const artifact = JSON.parse(fs.readFileSync(path.join(directory, 'Pre111K.artifact.json'), 'utf8'));
  const standardInput = JSON.parse(fs.readFileSync(path.join(directory, 'Pre111K.standard-input.json'), 'utf8'));
  assert.equal(sha256(json(artifact)), manifest.artifactSha256, 'Frozen artifact changed');
  assert.equal(sha256(json(standardInput)), manifest.standardInputSha256, 'Frozen compiler input changed');
  assert.equal(manifest.creationCode, artifact.bytecode.object + manifest.constructorArgs.slice(2), 'Creation bytecode changed');
  const manifestSha256 = sha256(json(manifest));

  if (command === 'sign') {
    assert.ok(options['--keystore'] && options['--password-file'], 'Signing requires --keystore and --password-file');
    assert.ok(!fs.existsSync(journalPath), 'A transaction is already journaled; resume broadcast or verification');
    for (const [source, frozen] of Object.entries(standardInput.sources)) {
      const filename = path.resolve(project, source);
      assert.ok(filename.startsWith(project), 'Source escapes contract project');
      assert.equal(fs.readFileSync(filename, 'utf8'), frozen.content, 'Source changed after preparation: ' + source);
    }
    const walletArgs = ['--keystore', options['--keystore'], '--password-file', options['--password-file']];
    assert.equal(run(['wallet', 'address', ...walletArgs]).toLowerCase(), deployer, 'Wrong deployer keystore');
    for (const block of ['latest', 'pending']) {
      assert.equal(BigInt(await rpc('eth_getTransactionCount', [deployer, block])).toString(), manifest.nonce, 'Deployer nonce changed; prepare a new release');
    }
    const estimate = BigInt(await rpc('eth_estimateGas', [{ from: deployer, data: manifest.creationCode, value: '0x0' }]));
    assert.ok(estimate <= BigInt(manifest.gasLimit), 'Deployment gas estimate increased; prepare a new release');
    const [suggestedGasPrice, latestBlock, pendingBlock, latestBalance, pendingBalance] = await Promise.all([
      rpc('eth_gasPrice'), rpc('eth_getBlockByNumber', ['latest', false]), rpc('eth_getBlockByNumber', ['pending', false]),
      rpc('eth_getBalance', [deployer, 'latest']), rpc('eth_getBalance', [deployer, 'pending']),
    ]);
    validateDeploymentGasPrice(manifest.gasPrice, suggestedGasPrice, latestBlock?.baseFeePerGas, pendingBlock?.baseFeePerGas);
    for (const balance of [latestBalance, pendingBalance]) {
      validateDeploymentBalance(balance, BigInt(manifest.gasPrice) * BigInt(manifest.gasLimit));
    }
    const raw = run(['mktx', '--legacy', '--chain', String(configuration.chainId), '--nonce', manifest.nonce, '--gas-limit', manifest.gasLimit,
      '--gas-price', manifest.gasPrice, '--value', '0', ...walletArgs, '--create', manifest.creationCode]);
    assert.match(raw, /^0x(?:[0-9a-f]{2})+$/i);
    validateRaw(raw, manifest);
    const journal = { manifestSha256, transactionHash: hashHex(raw), raw, signedAt: new Date().toISOString() };
    durableWrite(journalPath, journal);
    console.log(json({ signedAndJournaled: true, transactionHash: journal.transactionHash, nonce: manifest.nonce }));
    return;
  }

  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  assert.equal(journal.manifestSha256, manifestSha256, 'Manifest changed after signing');
  assert.equal(hashHex(journal.raw), journal.transactionHash, 'Journaled transaction changed');
  validateRaw(journal.raw, manifest);
  if (command === 'broadcast') {
    const existing = await rpc('eth_getTransactionByHash', [journal.transactionHash]);
    if (!existing) {
      for (const block of ['latest', 'pending']) {
        assert.equal(BigInt(await rpc('eth_getTransactionCount', [deployer, block])).toString(), manifest.nonce, 'Nonce occupied; reconcile before retrying');
      }
      journal.broadcastAttemptedAt = new Date().toISOString();
      durableWrite(journalPath, journal);
      await requireChain();
      assert.equal(await rpc('eth_sendRawTransaction', [journal.raw]), journal.transactionHash);
      journal.broadcastAcceptedAt = new Date().toISOString();
      durableWrite(journalPath, journal);
    }
    console.log(json({ broadcast: true, transactionHash: journal.transactionHash, contractAddress: manifest.contractAddress }));
    return;
  }

  const receipt = await rpc('eth_getTransactionReceipt', [journal.transactionHash]);
  assert.ok(receipt, 'Transaction is not confirmed yet');
  assert.equal(receipt.status, '0x1', 'Deployment reverted');
  assert.equal(receipt.contractAddress?.toLowerCase(), manifest.contractAddress, 'Unexpected deployed address');
  assert.equal(receipt.from?.toLowerCase(), deployer);
  assert.equal(receipt.to, null);
  const latest = await rpc('eth_getBlockByNumber', ['latest', false]);
  assert.ok(BigInt(latest.number) >= BigInt(receipt.blockNumber) + 2n, 'Wait for three confirmations');
  const canonical = await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
  assert.equal(canonical.hash, receipt.blockHash, 'Deployment receipt is no longer canonical');
  const transaction = await rpc('eth_getTransactionByHash', [journal.transactionHash]);
  assert.equal(transaction.input, manifest.creationCode);
  assert.equal(transaction.from.toLowerCase(), deployer);
  assert.equal(transaction.to, null);
  assert.equal(BigInt(transaction.value), 0n);
  assert.equal(BigInt(transaction.nonce).toString(), manifest.nonce);
  assert.equal(BigInt(transaction.chainId), BigInt(configuration.chainId));
  const code = await rpc('eth_getCode', [manifest.contractAddress, receipt.blockNumber]);
  assert.ok(matchingRuntime(artifact.deployedBytecode.object, code, artifact.deployedBytecode.immutableReferences), 'Deployed runtime mismatch');
  const call = async (signature, type) => {
    const data = run(['calldata', signature]);
    const result = await rpc('eth_call', [{ to: manifest.contractAddress, data }, receipt.blockNumber]);
    return type === 'address' ? '0x' + result.slice(-40) : BigInt(result).toString();
  };
  for (const getter of ['admin', 'treasury', 'quoteSigner']) assert.equal(await call(getter + '()', 'address'), manifest[getter]);
  assert.equal(await call('price()', 'uint256'), manifest.priceWei);
  assert.equal(await call('MAX_RELICS()', 'uint256'), '18');
  assert.equal(await call('MAX_AUTHORIZATION_LIFETIME()', 'uint256'), '600');
  assert.equal(await call('totalReserved()', 'uint256'), '0');
  assert.equal(BigInt(await rpc('eth_getBalance', [manifest.contractAddress, receipt.blockNumber])), 0n);
  const report = { chainId: manifest.chainId, contractAddress: manifest.contractAddress, deploymentBlock: Number(BigInt(receipt.blockNumber)),
    deploymentBlockHash: receipt.blockHash, transactionHash: journal.transactionHash, deployer, admin: manifest.admin, treasury: manifest.treasury,
    quoteSigner: manifest.quoteSigner, priceWei: manifest.priceWei, maxRelics: 18, runtimeBytes: (code.length - 2) / 2,
    runtimeKeccak256: hashHex(code), artifactSha256: manifest.artifactSha256, standardInputSha256: manifest.standardInputSha256,
    constructorArgs: manifest.constructorArgs, confirmations: Number(BigInt(latest.number) - BigInt(receipt.blockNumber) + 1n),
    verifiedAt: new Date().toISOString(), receipt };
  durableWrite(path.join(directory, 'deployment.json'), report);
  journal.verifiedAt = report.verifiedAt;
  durableWrite(journalPath, journal);
  console.log(json(report));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof assert.AssertionError ? error.message : 'Pre111K deployment operation failed; inspect the journal before retrying.');
    process.exitCode = 1;
  });
}
