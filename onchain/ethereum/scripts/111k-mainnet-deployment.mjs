import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode } from '@metamask/abi-utils';
import { keccak_256 } from '@noble/hashes/sha3';
import { compileFrozen, frozenCompilerInput } from './111k-deployment.mjs';
import { load111kVerification, verify111kDeployment } from './111k-verification.mjs';
import { deploymentGas, validateDeploymentBalance, validateDeploymentGasPrice } from './pre111k-deployment.mjs';
import { parseProceedsConfig, parseInitialDeliveryReceiver } from './proceeds-config.mjs';
import { parseFreeMintConfigJson } from './free-mint-config.mjs';
import { parseDiscountCapConfigJson } from './discount-cap-config.mjs';
import { withMetadataLock } from '../../../scripts/ethereum-metadata/lock.ts';
import { createAsyncD1MaintenanceQuery } from '../../../scripts/shared/asyncD1MaintenanceQuery.ts';
import { sqlString } from '../../../scripts/shared/commerceD1Maintenance.ts';

export const NFT111K_MAINNET = Object.freeze({
  chainId: 1,
  network: 'mainnet',
  deploymentId: 'mainnet-v1',
  deployer: '0xd58d143ca63d9baccc33fdf69ea203f59c58ae93',
  owner: '0xd58d143ca63d9baccc33fdf69ea203f59c58ae93',
  initialDeliveryReceiver: '0xd58d143ca63d9baccc33fdf69ea203f59c58ae93',
  quoteSigner: '0x43c829cbb3648cc5eb8ebaa15fb7cfab21ecc2ea',
  metadataBaseURI: 'https://cdn.mons.shop/111k/',
  maximumFeeWei: '2000000000000000',
});

const project = fileURLToPath(new URL('../', import.meta.url));
const repository = path.resolve(project, '../..');
const configPaths = ['config/proceeds.json', 'config/free-mints.json', 'config/discount-caps.json', '../../src/ethereum/discounts/111k.json'];
const constructorTypes = ['address', 'address', 'address', 'string', 'bytes32', 'address[]', 'uint256[]', '(address,uint16,uint16,uint16)[]', 'uint256'];
const commands = ['prepare', 'sign', 'broadcast', 'verify'];
const maximumGas = 16_777_216n;
const json = value => `${JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? entry.toString() : entry, 2)}\n`;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const hashHex = value => `0x${Buffer.from(keccak_256(Buffer.from(value.slice(2), 'hex'))).toString('hex')}`;
const hex = value => `0x${BigInt(value).toString(16)}`;
const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function cast(args) {
  try { return execFileSync('cast', args, { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }).trim(); }
  catch { throw new Error(`Cast ${args[0]} failed; inspect the private mainnet release state`); }
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
  const allowed = filename => {
    const relative = path.relative(repository, filename);
    if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      assert.ok(relative.startsWith(`.cache${path.sep}`) || relative.startsWith(`onchain${path.sep}ethereum${path.sep}.local${path.sep}`),
        'Mainnet release state must be private and ignored or outside the repository');
    }
  };
  allowed(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assert.ok(fs.lstatSync(directory).isDirectory() && (fs.statSync(directory).mode & 0o077) === 0,
    'Mainnet release directory must have mode 0700');
  const canonical = fs.realpathSync(directory);
  allowed(canonical);
  return canonical;
}

export function parse111kMainnetDeploymentArgs(argv) {
  const [command, ...args] = argv;
  assert.ok(commands.includes(command), 'Use prepare|sign|broadcast|verify --directory PATH [--network mainnet]');
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    assert.ok(['--directory', '--network', '--deployment-id', '--keystore', '--password-file'].includes(key)
      && args[index + 1] && !Object.hasOwn(values, key), 'Invalid or repeated mainnet deployment option');
    values[key] = args[index + 1];
  }
  assert.equal(values['--network'] ?? 'mainnet', 'mainnet', 'This runner supports Ethereum mainnet only');
  assert.ok(command === 'prepare' || values['--deployment-id'] === undefined, '--deployment-id applies only to prepare');
  assert.equal(values['--deployment-id'] ?? NFT111K_MAINNET.deploymentId, NFT111K_MAINNET.deploymentId, 'Wrong mainnet deployment identity');
  assert.ok(command === 'sign' || values['--keystore'] === undefined && values['--password-file'] === undefined,
    'Signing credentials apply only to sign');
  assert.ok(command !== 'sign' || values['--keystore'] && values['--password-file'], 'Signing requires --keystore and --password-file');
  assert.ok(values['--directory'], 'An explicit private --directory is required');
  return { command, directory: path.resolve(values['--directory']), keystore: values['--keystore'], passwordFile: values['--password-file'] };
}

export function mainnet111kDeploymentGas(estimate, gasPrice) {
  const gas = deploymentGas(estimate, gasPrice, NFT111K_MAINNET.maximumFeeWei);
  assert.ok(BigInt(gas.gasLimit) <= maximumGas, 'Deployment gas limit exceeds the mainnet transaction cap');
  return gas;
}

function constructorArgs(manifest) {
  return `0x${Buffer.from(encode(constructorTypes, [manifest.owner, manifest.quoteSigner, manifest.initialDeliveryReceiver,
    manifest.metadataBaseURI, manifest.discountRoot, manifest.proceeds.mintRecipients, manifest.proceeds.mintSharesBps,
    manifest.freeMintAllocations.map(value => [value.wallet, value.crateLimit, value.warehouseLimit, value.relicLimit]),
    manifest.maxDiscountedMints])).toString('hex')}`;
}

function requireGas(manifest) {
  assert.ok(/^[1-9][0-9]*$/.test(manifest.gasLimit) && /^[1-9][0-9]*$/.test(manifest.gasPrice), 'Invalid frozen deployment gas');
  assert.ok(BigInt(manifest.gasLimit) <= maximumGas, 'Deployment gas limit exceeds the mainnet transaction cap');
  assert.equal((BigInt(manifest.gasLimit) * BigInt(manifest.gasPrice)).toString(), manifest.maximumFeeWei, 'Frozen fee changed');
  assert.ok(BigInt(manifest.maximumFeeWei) <= BigInt(NFT111K_MAINNET.maximumFeeWei), 'Deployment exceeds the mainnet fee ceiling');
}

function requireIdentity(manifest, configuration) {
  assert.equal(manifest.version, 1, 'Unsupported mainnet release manifest');
  for (const key of ['chainId', 'network', 'deploymentId', 'deployer', 'owner', 'quoteSigner', 'initialDeliveryReceiver', 'metadataBaseURI']) {
    assert.equal(manifest[key], configuration[key], `Mainnet release ${key} changed`);
  }
  assert.equal(manifest.previousContract, undefined, 'First mainnet deployment cannot replace another contract');
  assert.deepEqual(manifest.relicReservation, { quantity: 0, valueWei: '0' });
  assert.deepEqual(manifest.freeMintAllocations, [], 'Mainnet starts without free allowances');
  assert.equal(manifest.maxDiscountedMints, 500, 'Mainnet discounted-mint cap changed');
  assert.equal(manifest.proceeds.mintRecipients.length, 14, 'Expected the committed fourteen-recipient split');
  parseProceedsConfig(manifest.proceeds, manifest.contractAddress);
  parseInitialDeliveryReceiver({ initialReceiver: manifest.initialDeliveryReceiver }, manifest.contractAddress, manifest.proceeds.mintRecipients);
  assert.match(manifest.discountRoot, /^0x[0-9a-f]{64}$/);
  requireGas(manifest);
}

function parseConfigs(configs, contractAddress) {
  assert.deepEqual(Object.keys(configs).sort(), [...configPaths].sort(), 'Frozen configuration files changed');
  const proceeds = parseProceedsConfig(JSON.parse(configs['config/proceeds.json']), contractAddress);
  const freeMintAllocations = parseFreeMintConfigJson(configs['config/free-mints.json'], contractAddress, 1).allocations;
  const maxDiscountedMints = parseDiscountCapConfigJson(configs['config/discount-caps.json'], 1);
  const discounts = JSON.parse(configs['../../src/ethereum/discounts/111k.json']);
  assert.equal(Object.keys(discounts.proofs).length, 318, 'Expected the approved 318-wallet discount list');
  return { proceeds, freeMintAllocations, maxDiscountedMints, discountRoot: discounts.root };
}

function loadFrozen(directory, configuration, runCast) {
  const manifest = readJson(path.join(directory, 'manifest.json'));
  requireIdentity(manifest, configuration);
  const entries = [['artifact', 'artifactSha256'], ['standard-input', 'standardInputSha256'], ['compiler-output', 'compilerOutputSha256']];
  const frozen = {};
  for (const [name, field] of entries) {
    const body = fs.readFileSync(path.join(directory, `NFT111K.${name}.json`), 'utf8');
    assert.equal(sha256(body), manifest[field], `Frozen ${name} changed`);
    frozen[name] = JSON.parse(body);
  }
  const configs = readJson(path.join(directory, 'config.snapshot.json'));
  assert.equal(sha256(json(configs)), manifest.configSnapshotSha256, 'Frozen configuration changed');
  const parsed = parseConfigs(configs, manifest.contractAddress);
  for (const key of Object.keys(parsed)) assert.deepEqual(manifest[key], parsed[key], `Frozen ${key} changed`);
  assert.deepEqual(manifest.sourceConfigSha256, Object.fromEntries(Object.entries(configs).map(([name, body]) => [name, sha256(body)])));
  assert.equal(manifest.constructorArgs, constructorArgs(manifest), 'Frozen constructor arguments changed');
  assert.equal(manifest.creationCode, frozen.artifact.bytecode.object + manifest.constructorArgs.slice(2), 'Frozen creation bytecode changed');
  assert.ok((frozen.artifact.deployedBytecode.object.length - 2) / 2 <= 24576, 'Runtime exceeds EIP-170');
  assert.ok((manifest.creationCode.length - 2) / 2 <= 49152, 'Initcode exceeds EIP-3860');
  const predicted = runCast(['compute-address', manifest.deployer, '--nonce', manifest.nonce]).match(/0x[0-9a-fA-F]{40}/)?.[0]?.toLowerCase();
  assert.equal(predicted, manifest.contractAddress, 'Predicted deployment address changed');
  return { manifest, artifact: frozen.artifact, input: frozen['standard-input'], configs, manifestSha256: sha256(json(manifest)) };
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

function defaultRpc(environment = process.env) {
  const url = environment.ETHEREUM_111K_RPC_URL || (environment.ALCHEMY_API_KEY
    ? `https://eth-mainnet.g.alchemy.com/v2/${encodeURIComponent(environment.ALCHEMY_API_KEY)}` : undefined);
  assert.ok(url, 'Set ETHEREUM_111K_RPC_URL or ALCHEMY_API_KEY');
  const parsed = new URL(url);
  assert.ok(parsed.protocol === 'https:' && !parsed.username && !parsed.password, 'Mainnet deployment requires an HTTPS RPC');
  return async (method, params = []) => {
    let response;
    try {
      response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
    } catch { throw new Error(`Mainnet RPC request failed for ${method}`); }
    assert.ok(response.ok, `Mainnet RPC returned HTTP ${response.status}`);
    const body = await response.json();
    assert.ok(!body.error && Object.hasOwn(body, 'result'), `Mainnet RPC failed for ${method}`);
    return body.result;
  };
}

async function requireChain(rpc) {
  assert.equal(BigInt(await rpc('eth_chainId')), 1n, 'RPC is not Ethereum mainnet');
}

async function requireUnregisteredIdentity(configuration, query) {
  const rows = await query(`SELECT deployment_id FROM ethereum_reveal_deployments
    WHERE deployment_id = ${sqlString(configuration.deploymentId)}
      OR metadata_base_uri = ${sqlString(configuration.metadataBaseURI)}`);
  assert.equal(rows.length, 0, 'Mainnet deployment ID or metadata root is already registered; resume the original release');
}

async function requireNonce(rpc, manifest) {
  for (const block of ['latest', 'pending']) {
    assert.equal(BigInt(await rpc('eth_getTransactionCount', [manifest.deployer, block])).toString(), manifest.nonce,
      'Deployer nonce changed or is occupied; reconcile the same release journal');
  }
}

async function preflight(rpc, manifest) {
  await requireChain(rpc);
  await requireNonce(rpc, manifest);
  assert.equal(await rpc('eth_getCode', [manifest.contractAddress, 'latest']), '0x', 'Predicted address already has code');
  const request = { from: manifest.deployer, data: manifest.creationCode, value: '0x0' };
  const estimate = BigInt(await rpc('eth_estimateGas', [request]));
  assert.ok(estimate <= BigInt(manifest.gasLimit), 'Gas estimate exceeds the frozen allowance');
  const [suggestion, latest, pending, latestBalance, pendingBalance] = await Promise.all([
    rpc('eth_gasPrice'), rpc('eth_getBlockByNumber', ['latest', false]), rpc('eth_getBlockByNumber', ['pending', false]),
    rpc('eth_getBalance', [manifest.deployer, 'latest']), rpc('eth_getBalance', [manifest.deployer, 'pending']),
  ]);
  validateDeploymentGasPrice(manifest.gasPrice, suggestion, latest.baseFeePerGas, pending.baseFeePerGas);
  for (const balance of [latestBalance, pendingBalance]) validateDeploymentBalance(balance, manifest.maximumFeeWei);
  await rpc('eth_call', [{ ...request, gas: hex(manifest.gasLimit) }, 'pending']);
}

export function validateSigned111kMainnetDeployment(transaction, manifest, record, hash) {
  assert.equal(record.action, 'deploy', 'Mainnet runner permits only deployment');
  assert.equal(record.chainId, 1, 'Journal chain changed');
  assert.equal(record.from, manifest.deployer, 'Journal signer changed');
  assert.equal(record.to, null, 'Journal must contain contract creation');
  assert.equal(record.valueWei, '0', 'Deployment cannot transfer ETH');
  assert.equal(record.data, manifest.creationCode, 'Journal creation bytecode changed');
  for (const key of ['nonce', 'gasLimit', 'gasPrice', 'maximumFeeWei']) assert.equal(record[key], manifest[key], `Journal ${key} changed`);
  assert.equal(record.hash, hash, 'Journal transaction hash changed');
  assert.equal((transaction.signer ?? transaction.from)?.toLowerCase(), manifest.deployer, 'Unexpected transaction signer');
  assert.equal(transaction.type, '0x0', 'Expected a legacy transaction');
  assert.equal(BigInt(transaction.chainId), 1n, 'Wrong transaction chain');
  assert.equal(transaction.to, null, 'Expected contract creation');
  assert.equal(BigInt(transaction.value), 0n, 'Deployment cannot transfer ETH');
  assert.equal(transaction.input, manifest.creationCode, 'Signed creation bytecode changed');
  for (const [key, field] of [['nonce', 'nonce'], ['gas', 'gasLimit'], ['gasPrice', 'gasPrice']]) {
    assert.equal(BigInt(transaction[key]).toString(), manifest[field], `Signed ${field} changed`);
  }
  assert.equal(transaction.hash, hash, 'Signed transaction hash changed');
  requireGas(manifest);
}

async function confirm(rpc, manifest, record, options) {
  const wait = options.sleep ?? sleep;
  for (let attempt = 0; attempt < (options.maxReceiptPolls ?? 180); attempt++) {
    await requireChain(rpc);
    const receipt = await rpc('eth_getTransactionReceipt', [record.hash]);
    if (receipt) {
      assert.equal(receipt.transactionHash, record.hash, 'Receipt transaction hash changed');
      assert.equal(BigInt(receipt.status), 1n, 'Deployment reverted');
      assert.equal(receipt.contractAddress?.toLowerCase(), manifest.contractAddress, 'Unexpected deployed contract');
      assert.equal(receipt.from?.toLowerCase(), manifest.deployer, 'Receipt sender changed');
      assert.equal(receipt.to, null, 'Receipt is not contract creation');
      const [head, block, transaction] = await Promise.all([
        rpc('eth_getBlockByNumber', ['latest', false]), rpc('eth_getBlockByNumber', [receipt.blockNumber, false]),
        rpc('eth_getTransactionByHash', [record.hash]),
      ]);
      assert.equal(block?.hash, receipt.blockHash, 'Deployment receipt is no longer canonical');
      assert.equal(transaction?.blockHash, receipt.blockHash, 'Deployment transaction moved blocks');
      validateSigned111kMainnetDeployment(transaction, manifest, record, record.hash);
      if (BigInt(head.number) >= BigInt(receipt.blockNumber) + 2n) return receipt;
    }
    await wait(4000);
  }
  throw new Error('Deployment is pending three canonical confirmations; resume the same release');
}

export async function run111kMainnetDeployment(argv, overrides = {}) {
  const options = parse111kMainnetDeploymentArgs(argv);
  const rpc = overrides.rpc ?? defaultRpc();
  const runCast = overrides.cast ?? cast;
  const configuration = { ...NFT111K_MAINNET, ...(overrides.configuration ?? {}) };
  const query = overrides.query ?? createAsyncD1MaintenanceQuery('ops');
  const now = overrides.now ?? (() => new Date().toISOString());
  await requireChain(rpc);
  const directory = privateDirectory(options.directory);
  return withMetadataLock(path.join(directory, 'operation.lock'), async () => {
    if (options.command === 'prepare') {
      assert.ok(fs.readdirSync(directory).every(name => name === 'operation.lock' || /^\.operation\.lock-[a-zA-Z0-9]+$/.test(name)),
        'Prepare requires a fresh release directory; resume an existing release');
      await requireUnregisteredIdentity(configuration, query);
      const nonce = BigInt(await rpc('eth_getTransactionCount', [configuration.deployer, 'latest'])).toString();
      await requireNonce(rpc, { ...configuration, nonce });
      const contractAddress = runCast(['compute-address', configuration.deployer, '--nonce', nonce]).match(/0x[0-9a-fA-F]{40}/)?.[0]?.toLowerCase();
      assert.ok(contractAddress, 'Cannot predict deployment address');
      const configs = Object.fromEntries(configPaths.map(source => [source, fs.readFileSync(path.resolve(project, source), 'utf8')]));
      const parsed = parseConfigs(configs, contractAddress);
      const original = readJson(path.join(project, 'out/NFT111K.sol/NFT111K.json'));
      const input = frozenCompilerInput(original);
      const { artifact, output, immutableNames } = compileFrozen(input, original);
      const manifest = { version: 1, ...configuration, contractAddress, nonce, ...parsed, initialDeliveryConfigId: 1,
        relicReservation: { quantity: 0, valueWei: '0' }, preparedAt: now(), immutableNames,
        artifactSha256: sha256(json(artifact)), standardInputSha256: sha256(json(input)), compilerOutputSha256: sha256(json(output)),
        configSnapshotSha256: sha256(json(configs)), sourceConfigSha256: Object.fromEntries(Object.entries(configs).map(([source, body]) => [source, sha256(body)])) };
      manifest.constructorArgs = constructorArgs(manifest);
      manifest.creationCode = artifact.bytecode.object + manifest.constructorArgs.slice(2);
      assert.ok((artifact.deployedBytecode.object.length - 2) / 2 <= 24576, 'Runtime exceeds EIP-170');
      assert.ok((manifest.creationCode.length - 2) / 2 <= 49152, 'Initcode exceeds EIP-3860');
      Object.assign(manifest, mainnet111kDeploymentGas(await rpc('eth_estimateGas', [{ from: manifest.deployer, data: manifest.creationCode, value: '0x0' }]),
        await rpc('eth_gasPrice')));
      requireIdentity(manifest, configuration);
      await preflight(rpc, manifest);
      for (const [name, value] of [['NFT111K.artifact', artifact], ['NFT111K.standard-input', input], ['NFT111K.compiler-output', output],
        ['config.snapshot', configs], ['manifest', manifest]]) durableWrite(path.join(directory, `${name}.json`), value);
      return { prepared: true, chainId: 1, deploymentId: manifest.deploymentId, contractAddress, nonce, metadataBaseURI: manifest.metadataBaseURI,
        owner: manifest.owner, quoteSigner: manifest.quoteSigner, initialDeliveryReceiver: manifest.initialDeliveryReceiver,
        maxDiscountedMints: manifest.maxDiscountedMints, freeMintAllocations: [], relicReservation: manifest.relicReservation,
        gasEstimate: manifest.gasEstimate, gasLimit: manifest.gasLimit, gasPrice: manifest.gasPrice, maximumFeeWei: manifest.maximumFeeWei };
    }

    const frozen = loadFrozen(directory, configuration, runCast);
    const verification = await load111kVerification(directory);
    const { manifest } = frozen;
    const journalPath = path.join(directory, 'transactions.private.json');
    const journal = fs.existsSync(journalPath) ? readJson(journalPath) : { version: 1, manifestSha256: frozen.manifestSha256, actions: {} };
    assert.equal(journal.version, 1, 'Unsupported mainnet transaction journal');
    assert.equal(journal.manifestSha256, frozen.manifestSha256, 'Transaction journal belongs to another manifest');
    assert.ok(Object.keys(journal.actions).every(action => action === 'deploy'), 'Mainnet journal contains an unauthorized action');
    const validateRaw = record => {
      assert.equal(hashHex(record.raw), record.hash, 'Journaled transaction changed');
      let decoded = JSON.parse(runCast(['decode-transaction', record.raw]));
      if (typeof decoded === 'string') decoded = JSON.parse(decoded);
      validateSigned111kMainnetDeployment(decoded, manifest, record, record.hash);
    };
    let record = journal.actions.deploy;
    if (record) validateRaw(record);

    if (options.command === 'sign') {
      requireCurrentSources(frozen);
      if (!record) {
        await requireUnregisteredIdentity(manifest, query);
        await preflight(rpc, manifest);
        const walletArgs = ['--keystore', options.keystore, '--password-file', options.passwordFile];
        assert.equal(runCast(['wallet', 'address', ...walletArgs]).toLowerCase(), manifest.deployer, 'Wrong deployer keystore');
        await requireNonce(rpc, manifest);
        record = { action: 'deploy', chainId: 1, from: manifest.deployer, contractAddress: manifest.contractAddress, to: null,
          data: manifest.creationCode, valueWei: '0', nonce: manifest.nonce, gasEstimate: manifest.gasEstimate,
          gasLimit: manifest.gasLimit, gasPrice: manifest.gasPrice, maximumFeeWei: manifest.maximumFeeWei, signedAt: now() };
        record.raw = runCast(['mktx', '--legacy', '--chain', '1', '--nonce', manifest.nonce, '--gas-limit', manifest.gasLimit,
          '--gas-price', manifest.gasPrice, '--value', '0', ...walletArgs, '--create', manifest.creationCode]);
        assert.match(record.raw, /^0x(?:[0-9a-f]{2})+$/i, 'Invalid signed transaction');
        record.hash = hashHex(record.raw);
        validateRaw(record);
        journal.actions.deploy = record;
        durableWrite(journalPath, journal);
      }
      return { signedAndJournaled: true, transactionHash: record.hash, contractAddress: manifest.contractAddress, nonce: manifest.nonce };
    }

    assert.ok(record, 'Sign and journal the deployment before broadcasting or verifying');
    if (options.command === 'broadcast') {
      if (!await rpc('eth_getTransactionByHash', [record.hash])) {
        await requireUnregisteredIdentity(manifest, query);
        requireCurrentSources(frozen);
        await preflight(rpc, manifest);
        record.broadcastAttemptedAt = now();
        durableWrite(journalPath, journal);
        await requireChain(rpc);
        await requireNonce(rpc, manifest);
        await requireUnregisteredIdentity(manifest, query);
        assert.equal(await rpc('eth_sendRawTransaction', [record.raw]), record.hash, 'RPC returned an unexpected transaction hash');
        record.broadcastAcceptedAt = now();
        durableWrite(journalPath, journal);
      }
      record.receipt = await confirm(rpc, manifest, record, overrides);
      record.confirmedAt = now();
      durableWrite(journalPath, journal);
      const report = { chainId: 1, deploymentId: manifest.deploymentId, contractAddress: manifest.contractAddress,
        metadataBaseURI: manifest.metadataBaseURI, owner: manifest.owner, quoteSigner: manifest.quoteSigner,
        initialDeliveryReceiver: manifest.initialDeliveryReceiver, deploymentBlock: Number(BigInt(record.receipt.blockNumber)),
        transactionHash: record.hash, receipt: record.receipt };
      durableWrite(path.join(directory, 'deployment.json'), report);
      return report;
    }

    const report = await verify111kDeployment(verification, rpc, 'closed');
    durableWrite(path.join(directory, 'deployment-closed.json'), report);
    return report;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run111kMainnetDeployment(process.argv.slice(2)).then(result => console.log(json(result))).catch(error => {
    console.error(error instanceof assert.AssertionError || error?.message?.startsWith('Deployment is pending')
      ? error.message : '111K mainnet deployment failed; inspect the private journal before retrying.');
    process.exitCode = 1;
  });
}
