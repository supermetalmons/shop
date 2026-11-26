import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak_256 } from '@noble/hashes/sha3';
import { withMetadataLock } from '../../../scripts/ethereum-metadata/lock.ts';
import { dmxMetadataManifestSha256, loadDmxMetadataManifest, validateDmxMetadataManifest,
  verifyDmxPublishedMetadata } from '../../../scripts/tarot/metadata.ts';
import { deploymentGas, matchingRuntime, validateDeploymentBalance, validateDeploymentGasPrice } from './pre111k-deployment.mjs';

export { deploymentGas, matchingRuntime, validateDeploymentBalance, validateDeploymentGasPrice };

export const TAROT_SEPOLIA = Object.freeze({
  chainId: 11155111,
  deployer: '0xd58d143ca63d9baccc33fdf69ea203f59c58ae93',
  admin: '0xd58d143ca63d9baccc33fdf69ea203f59c58ae93',
  maximumFeeWei: '5000000000000000',
});

const project = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const repository = path.resolve(project, '../..');
const collectionImage = 'https://cdn.lil.org/nft/dmx/cards/1.png';
export const OFFCHAIN_COLLECTION_URI = 'https://cdn.mons.shop/dmx/collection.json';
const rendererNames = ['DMXWebpRenderer', 'DMXOffchainRenderer'];
const metadataPinNames = ['expectedCollectionUri', 'collectionMetadataSha256', 'metadataManifestSha256'];
const legacyCollectionImage = 'https://wip.lil.org/dmx/cards/1.webp';
const json = value => JSON.stringify(value, null, 2) + '\n';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const hashHex = value => '0x' + Buffer.from(keccak_256(Buffer.from(value.slice(2), 'hex'))).toString('hex');
const run = args => execFileSync('cast', args, { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function deploymentAddress(value, option) {
  assert.ok(typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value) && !/^0x0{40}$/i.test(value),
    'Preparation requires a nonzero --' + option + ' address');
  return value.toLowerCase();
}

function validatePinnedCollectionImage(image) {
  assert.ok(image === collectionImage || image === legacyCollectionImage, 'Unexpected deployment collection image');
}

export function deploymentConfiguration(network = 'sepolia', quoteSigner, renderer, contractName = 'TarotCards', roles = {}) {
  assert.ok(['sepolia', 'mainnet'].includes(network), 'Tarot deployment supports Sepolia or Ethereum mainnet only');
  assert.ok(['TarotCards', ...rendererNames].includes(contractName), 'Unsupported deployment contract');
  let configuration = TAROT_SEPOLIA;
  if (network === 'mainnet') {
    const deployer = deploymentAddress(roles.deployer, 'deployer');
    const admin = deploymentAddress(roles.admin, 'admin');
    assert.ok(typeof roles.feeCeilingWei === 'string' && /^[1-9][0-9]*$/.test(roles.feeCeilingWei)
      && BigInt(roles.feeCeilingWei) < 2n ** 256n, 'Mainnet preparation requires a positive --maximum-fee-wei ceiling');
    configuration = { chainId: 1, deployer, admin, maximumFeeWei: roles.feeCeilingWei, feeCeilingWei: roles.feeCeilingWei };
  } else {
    assert.equal(Object.keys(roles).length, 0, 'Explicit deployment roles and fee ceiling apply only to mainnet');
  }
  const common = { ...configuration, releaseVersion: 2, contractName };
  if (rendererNames.includes(contractName)) return common;
  const signer = deploymentAddress(quoteSigner, 'quote-signer');
  assert.ok(signer !== common.deployer && signer !== common.admin, 'Use a dedicated Tarot quote signer');
  assert.ok(typeof renderer === 'string' && /^0x[0-9a-f]{40}$/i.test(renderer) && !/^0x0{40}$/i.test(renderer),
    'Preparation requires a verified renderer release');
  return { ...common, quoteSigner: signer, renderer: deploymentAddress(renderer, 'renderer') };
}

export function validateDeploymentConfiguration(manifest, network = 'sepolia') {
  assert.equal(manifest.releaseVersion, 2, 'Legacy release is frozen; use a new private release directory for DMX');
  const roles = network === 'mainnet'
    ? { deployer: manifest.deployer, admin: manifest.admin, feeCeilingWei: manifest.feeCeilingWei } : {};
  const configuration = deploymentConfiguration(network, manifest.quoteSigner, manifest.renderer, manifest.contractName, roles);
  for (const key of Object.keys(configuration).filter(key => key !== 'maximumFeeWei')) {
    assert.equal(manifest[key], configuration[key], 'Unexpected deployment ' + key);
  }
  assert.equal(manifest.network, network, 'Deployment network changed');
  if (Object.hasOwn(manifest, 'expectedCollectionImage')) {
    validatePinnedCollectionImage(manifest.expectedCollectionImage);
  }
  if (manifest.contractName === 'DMXOffchainRenderer' || metadataPinNames.some(name => Object.hasOwn(manifest, name))) {
    metadataPins(manifest);
  }
  return configuration;
}

export function deploymentConstructorArgs(configuration) {
  if (rendererNames.includes(configuration.contractName)) return '0x';
  return run(['abi-encode', 'constructor(address,address,address)', configuration.admin,
    configuration.quoteSigner, configuration.renderer]);
}

export function rendererInterfaceId() {
  const selector = signature => BigInt('0x' + Buffer.from(keccak_256(Buffer.from(signature))).subarray(0, 4).toString('hex'));
  return '0x' + (selector('tokenURI(address,uint256)') ^ selector('contractURI(address)')).toString(16).padStart(8, '0');
}

function deploymentCollectionImage(manifest, deployment) {
  if (Object.hasOwn(manifest, 'expectedCollectionImage')) {
    validatePinnedCollectionImage(manifest.expectedCollectionImage);
    return manifest.expectedCollectionImage;
  }
  assert.ok(deployment, 'Historical release requires its original deployment metadata evidence');
  for (const key of ['releaseVersion', 'chainId', 'contractName', 'contractAddress', 'artifactSha256', 'standardInputSha256']) {
    assert.equal(deployment[key], manifest[key], 'Historical deployment differs from manifest: ' + key);
  }
  const image = deployment.collectionMetadata?.image;
  assert.ok(typeof image === 'string' && image.startsWith('https://'), 'Historical deployment has no collection image evidence');
  return image;
}

export function validateCollectionMetadata(uri, expectedImage = collectionImage) {
  assert.ok(typeof uri === 'string' && uri.startsWith('data:application/json;base64,'), 'Renderer must return inline JSON metadata');
  const encoded = uri.slice('data:application/json;base64,'.length);
  const bytes = Buffer.from(encoded, 'base64');
  assert.equal(bytes.toString('base64'), encoded, 'Malformed renderer metadata encoding');
  return validateMetadataObject(JSON.parse(bytes.toString('utf8')), expectedImage);
}

function validateMetadataObject(metadata, expectedImage) {
  assert.equal(metadata.name, 'divination machina x');
  assert.equal(metadata.symbol, 'DMX');
  assert.equal(metadata.image, expectedImage);
  assert.equal(metadata.external_link, 'https://mons.shop');
  return metadata;
}

export function metadataPins(manifest) {
  if (manifest.contractName !== 'DMXOffchainRenderer' && !metadataPinNames.some(name => Object.hasOwn(manifest, name))) return {};
  assert.equal(manifest.expectedCollectionUri, OFFCHAIN_COLLECTION_URI, 'Unexpected offchain collection metadata URI');
  for (const name of metadataPinNames.slice(1)) assert.match(manifest[name] ?? '', /^[0-9a-f]{64}$/, 'Missing metadata pin: ' + name);
  return Object.fromEntries(metadataPinNames.map(name => [name, manifest[name]]));
}

export async function resolveCollectionMetadata(uri, manifest = {}, expectedImage = collectionImage, fetcher = fetch) {
  const pins = metadataPins(manifest);
  if (!pins.expectedCollectionUri) return validateCollectionMetadata(uri, expectedImage);
  assert.equal(uri, pins.expectedCollectionUri, 'Offchain collection metadata URI differs from release');
  const response = await fetcher(uri, { redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { accept: 'application/json', 'cache-control': 'no-cache' } });
  assert.equal(response.status, 200, 'Offchain collection metadata HTTP failure');
  assert.ok(!response.redirected && (!response.url || response.url === uri), 'Offchain collection metadata redirect');
  assert.match(response.headers.get('content-type') ?? '', /^application\/json(?:\s*;|$)/i, 'Offchain collection metadata content type');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.length > 0 && bytes.length <= 1_048_576, 'Invalid offchain collection metadata size');
  assert.equal(sha256(bytes), pins.collectionMetadataSha256, 'Offchain collection metadata content hash differs');
  return validateMetadataObject(JSON.parse(bytes.toString('utf8')), expectedImage);
}

export function validateMetadataPublication(publication, verification, manifest) {
  validateDmxMetadataManifest(publication);
  const pins = metadataPins(manifest);
  assert.equal(dmxMetadataManifestSha256(publication), pins.metadataManifestSha256, 'Frozen metadata publication manifest changed');
  const collection = publication.objects.find(object => object.file === 'collection.json');
  assert.equal(collection?.sha256, pins.collectionMetadataSha256, 'Collection metadata hash differs from publication');
  assert.equal(verification?.version, 1, 'Missing metadata publication verification');
  assert.equal(verification.complete, true, 'Metadata publication is incomplete');
  assert.equal(verification.publicVerified, true, 'Metadata public verification is missing');
  assert.equal(verification.baseURI, publication.baseURI, 'Metadata verification origin changed');
  assert.equal(verification.manifestSha256, pins.metadataManifestSha256, 'Metadata verification manifest changed');
  assert.equal(verification.objectsSha256, publication.objectsSha256, 'Metadata verification objects changed');
  assert.equal(verification.objectCount, publication.objectCount, 'Metadata verification count changed');
}

function readMetadataPublication(directory, manifest) {
  const publicationManifest = JSON.parse(fs.readFileSync(path.join(directory, 'publication-manifest.json'), 'utf8'));
  const publicationVerification = JSON.parse(fs.readFileSync(path.join(directory, 'publication-verification.json'), 'utf8'));
  validateMetadataPublication(publicationManifest, publicationVerification, manifest);
  assert.equal(publicationVerification.storageVerified, true, 'Metadata storage verification is missing');
  return { publicationManifest, publicationVerification };
}

export async function verifyRendererPublication(release, options = {}) {
  if (!metadataPins(release.manifest).expectedCollectionUri) return;
  validateMetadataPublication(release.publicationManifest, release.publicationVerification, release.manifest);
  const verification = await verifyDmxPublishedMetadata(release.publicationManifest, { fetcher: options.fetch });
  validateMetadataPublication(release.publicationManifest, verification, release.manifest);
  return verification;
}

function validateFrozenContract(manifest, artifact, input) {
  const contractName = manifest.contractName;
  assert.equal(sha256(json(artifact)), manifest.artifactSha256, 'Frozen ' + contractName + ' artifact changed');
  assert.equal(sha256(json(input)), manifest.standardInputSha256, 'Frozen ' + contractName + ' sources changed');
  assert.deepEqual(artifact.metadata.settings.compilationTarget, { ['src/' + contractName + '.sol']: contractName });
  assert.deepEqual(Object.keys(input.sources).sort(), Object.keys(artifact.metadata.sources).sort());
  for (const [source, metadata] of Object.entries(artifact.metadata.sources)) {
    assert.equal(hashHex('0x' + Buffer.from(input.sources[source].content).toString('hex')), metadata.keccak256,
      'Frozen source differs from artifact: ' + source);
  }
  const { compilationTarget, ...settings } = artifact.metadata.settings;
  const { outputSelection, ...inputSettings } = input.settings;
  assert.deepEqual(inputSettings, settings, 'Frozen compiler settings differ from artifact');
}

function validateDeploymentEvidence(manifest, deployment, keys) {
  for (const key of [...keys, ...Object.keys(metadataPins(manifest))]) {
    assert.equal(deployment[key], manifest[key], 'Deployment differs from manifest: ' + key);
  }
  assert.ok(deployment.confirmations >= 3, 'Deployment needs three confirmations');
  assert.match(deployment.transactionHash, /^0x[0-9a-f]{64}$/);
  assert.match(deployment.deploymentBlockHash, /^0x[0-9a-f]{64}$/);
  assert.ok(Number.isSafeInteger(deployment.deploymentBlock) && deployment.deploymentBlock > 0);
  assert.equal(deployment.collectionMetadata?.image, deploymentCollectionImage(manifest, deployment),
    'Deployment collection image differs from manifest');
}

export function readRendererRelease(directory, network = 'sepolia') {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  validateDeploymentConfiguration(manifest, network);
  assert.ok(rendererNames.includes(manifest.contractName), 'Prerequisite must be a supported DMX renderer release');
  const name = manifest.contractName;
  const names = ['manifest.json', 'deployment.json', name + '.artifact.json', name + '.standard-input.json'];
  const files = Object.fromEntries(names.map(name => [name, JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))]));
  const deployment = files['deployment.json'];
  const artifact = files[name + '.artifact.json'];
  const input = files[name + '.standard-input.json'];
  assert.equal(manifest.constructorArgs, '0x');
  assert.equal(manifest.creationCode, artifact.bytecode.object);
  validateFrozenContract(manifest, artifact, input);
  validateDeploymentEvidence(manifest, deployment,
    ['chainId', 'contractName', 'contractAddress', 'artifactSha256', 'standardInputSha256', 'expectedCollectionImage',
      ...(network === 'mainnet' ? ['releaseVersion', 'deployer', 'admin', 'constructorArgs'] : [])]);
  const publication = metadataPins(manifest).expectedCollectionUri ? readMetadataPublication(directory, manifest) : {};
  if (publication.publicationManifest) {
    files['publication-manifest.json'] = publication.publicationManifest;
    files['publication-verification.json'] = publication.publicationVerification;
  }
  return { files, manifest, deployment, artifact, input, ...publication };
}

export function readCollectionRelease(directory, network = 'sepolia') {
  const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
  const manifest = read('manifest.json');
  const configuration = validateDeploymentConfiguration(manifest, network);
  assert.equal(manifest.contractName, 'TarotCards', 'Binding requires a TarotCards collection release');
  const deployment = read('deployment.json');
  const artifact = read('TarotCards.artifact.json');
  const input = read('TarotCards.standard-input.json');
  validateFrozenContract(manifest, artifact, input);
  assert.equal(manifest.constructorArgs, deploymentConstructorArgs(configuration), 'Constructor configuration changed');
  assert.equal(manifest.creationCode, artifact.bytecode.object + manifest.constructorArgs.slice(2), 'Creation bytecode changed');
  validateDeploymentFee(manifest, configuration.maximumFeeWei);
  const predicted = run(['compute-address', configuration.deployer, '--nonce', manifest.nonce])
    .match(/0x[0-9a-fA-F]{40}/)?.[0]?.toLowerCase();
  assert.equal(manifest.contractAddress, predicted, 'Predicted CREATE address changed');
  validateDeploymentEvidence(manifest, deployment, ['releaseVersion', 'chainId', 'contractName', 'contractAddress',
    'deployer', 'admin', 'quoteSigner', 'renderer', 'constructorArgs', 'artifactSha256', 'standardInputSha256', 'expectedCollectionImage']);
  const rendererRelease = readRendererRelease(path.join(directory, 'renderer'), network);
  assert.equal(rendererRelease.manifest.contractAddress, manifest.renderer, 'Renderer prerequisite address changed');
  assert.equal(manifest.rendererReleaseSha256, sha256(json(rendererRelease.files)), 'Frozen renderer release changed');
  return { manifest, deployment, artifact, input, rendererRelease };
}

export async function verifyRendererRelease(release, rpc, options = {}) {
  const { manifest, deployment, artifact } = release;
  assert.equal(BigInt(await rpc('eth_chainId', [])), BigInt(manifest.chainId), 'Renderer RPC chain differs from release');
  const block = '0x' + deployment.deploymentBlock.toString(16);
  const receipt = await rpc('eth_getTransactionReceipt', [deployment.transactionHash]);
  assert.equal(receipt?.status, '0x1', 'Renderer deployment receipt is missing or failed');
  assert.equal(receipt.contractAddress?.toLowerCase(), manifest.contractAddress);
  assert.equal(receipt.blockNumber, block);
  assert.equal(receipt.blockHash, deployment.deploymentBlockHash);
  assert.equal(receipt.from?.toLowerCase(), manifest.deployer);
  assert.equal(receipt.to, null);
  const canonical = await rpc('eth_getBlockByNumber', [block, false]);
  assert.equal(canonical?.hash, deployment.deploymentBlockHash, 'Renderer deployment is no longer canonical');
  const latest = await rpc('eth_getBlockByNumber', ['latest', false]);
  assert.ok(BigInt(latest.number) >= BigInt(block) + 2n, 'Renderer deployment needs three confirmations');
  const transaction = await rpc('eth_getTransactionByHash', [deployment.transactionHash]);
  assert.equal(transaction?.input, manifest.creationCode, 'Renderer creation bytecode differs');
  assert.equal(transaction.from?.toLowerCase(), manifest.deployer);
  assert.equal(transaction.to, null);
  assert.equal(BigInt(transaction.chainId), BigInt(manifest.chainId));
  assert.equal(BigInt(transaction.value), 0n);
  for (const at of [block, 'latest']) {
    const code = await rpc('eth_getCode', [manifest.contractAddress, at]);
    assert.ok(matchingRuntime(artifact.deployedBytecode.object, code, artifact.deployedBytecode.immutableReferences ?? {}), 'Renderer runtime mismatch');
  }
  const supports = await rpc('eth_call', [{ to: manifest.contractAddress,
    data: run(['calldata', 'supportsInterface(bytes4)', rendererInterfaceId()]) }, 'latest']);
  assert.equal(BigInt(supports), 1n, 'Renderer interface is unsupported');
  const metadata = await rpc('eth_call', [{ to: manifest.contractAddress,
    data: run(['calldata', 'contractURI(address)', manifest.admin]) }, 'latest']);
  await resolveCollectionMetadata(JSON.parse(run(['abi-decode', 'value()(string)', metadata, '--json']))[0], manifest,
    deploymentCollectionImage(manifest, deployment), options.fetch);
}

export async function verifyDeploymentState(manifest, rpc, block, deployment, options = {}) {
  const contractName = manifest.contractName;
  const expectedImage = deploymentCollectionImage(manifest, deployment);
  const call = async (signature, type, ...args) => {
    const data = run(['calldata', signature, ...args]);
    const result = await rpc('eth_call', [{ to: manifest.contractAddress, data }, block]);
    if (type === 'address') return '0x' + result.slice(-40);
    if (type === 'string') return JSON.parse(run(['abi-decode', 'value()(string)', result, '--json']))[0];
    return BigInt(result).toString();
  };
  let metadata;
  if (contractName === 'TarotCards') {
    assert.equal(await call('owner()', 'address'), manifest.admin);
    assert.equal(await call('quoteSigner()', 'address'), manifest.quoteSigner);
    assert.equal(await call('renderer()', 'address'), manifest.renderer);
    for (const [name, expected] of Object.entries({ INITIAL_CARDS: 777, MAX_CARDS: 999999, RECEIPT_OFFSET: 999999,
      REDEMPTION_RECEIPT_OFFSET: 1000776, MAX_TOKEN_ID: 2000775, MAX_AUTHORIZATION_LIFETIME: 600 })) {
      assert.equal(await call(name + '()', 'uint256'), String(expected));
    }
    assert.equal(await call('redemptionsPaused()', 'uint256'), '1');
    assert.equal(await call('mintingPaused()', 'uint256'), '0');
    assert.equal(await call('supportsInterface(bytes4)', 'uint256', '0x49064906'), '1');
    assert.equal(await call('receiptTokenId(uint256)', 'uint256', '1'), '1000000');
    assert.equal(await call('receiptTokenId(uint256)', 'uint256', '777'), '1000776');
    assert.equal(await call('redemptionReceiptTokenId(uint256)', 'uint256', '1'), '1000777');
    assert.equal(await call('redemptionReceiptTokenId(uint256)', 'uint256', '999999'), '2000775');
    assert.equal(await call('name()', 'string'), 'divination machina x');
    assert.equal(await call('symbol()', 'string'), 'DMX');
    const domainResult = await rpc('eth_call', [{ to: manifest.contractAddress, data: run(['calldata', 'eip712Domain()']) }, block]);
    const domain = JSON.parse(run(['abi-decode', 'domain()(bytes1,string,string,uint256,address,bytes32,uint256[])', domainResult, '--json']));
    assert.equal(domain[0], '0x0f');
    assert.equal(domain[1], 'divination machina x');
    assert.equal(domain[2], '1');
    assert.equal(String(domain[3]), String(manifest.chainId));
    assert.equal(domain[4].toLowerCase(), manifest.contractAddress);
    metadata = await resolveCollectionMetadata(await call('contractURI()', 'string'), manifest, expectedImage, options.fetch);
  } else {
    assert.equal(await call('supportsInterface(bytes4)', 'uint256', rendererInterfaceId()), '1');
    metadata = await resolveCollectionMetadata(await call('contractURI(address)', 'string', manifest.admin), manifest, expectedImage, options.fetch);
  }
  return metadata;
}

function validateDeploymentFee(manifest, maximumFeeWei) {
  assert.ok([manifest.gasPrice, manifest.gasLimit].every(value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value)),
    'Invalid deployment gas allowance');
  const fee = BigInt(manifest.gasPrice) * BigInt(manifest.gasLimit);
  assert.ok(fee <= BigInt(maximumFeeWei), 'Deployment exceeds the network fee ceiling');
  if (manifest.network === 'mainnet') assert.equal(manifest.maximumFeeWei, fee.toString(), 'Frozen maximum deployment fee changed');
}

export function validateSignedDeployment(transaction, manifest, hash) {
  const configuration = validateDeploymentConfiguration(manifest, manifest.network);
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

function privateDirectory(directory) {
  const allowed = candidate => {
    const relative = path.relative(repository, candidate);
    if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      assert.ok(relative.startsWith(`.operations${path.sep}`) || relative.startsWith(`.cache${path.sep}`) ||
        relative.startsWith(`onchain${path.sep}ethereum${path.sep}.local${path.sep}`),
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

export async function main(argv = process.argv.slice(2)) {
  const [command, ...arguments_] = argv;
  assert.ok(['prepare', 'sign', 'broadcast', 'verify'].includes(command),
    'Use prepare|sign|broadcast|verify --directory PATH [--network sepolia|mainnet] [--contract TarotCards|DMXWebpRenderer|DMXOffchainRenderer for prepare] [--metadata-directory PUBLISHED_METADATA for offchain renderer prepare] [--deployer ADDRESS --admin ADDRESS --maximum-fee-wei INTEGER for mainnet prepare] [--quote-signer ADDRESS --renderer-directory VERIFIED_RELEASE for collection prepare] [--keystore PATH --password-file PATH].');
  const options = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    assert.ok(['--network', '--contract', '--renderer-directory', '--quote-signer', '--directory', '--keystore', '--password-file',
      '--deployer', '--admin', '--maximum-fee-wei', '--metadata-directory'].includes(key) && arguments_[index + 1] && !options[key], 'Invalid or repeated option');
    options[key] = arguments_[index + 1];
  }
  const network = options['--network'] || 'sepolia';
  assert.ok(['sepolia', 'mainnet'].includes(network), 'Tarot deployment supports Sepolia or Ethereum mainnet only');
  for (const option of ['--quote-signer', '--renderer-directory', '--contract', '--deployer', '--admin', '--maximum-fee-wei', '--metadata-directory']) {
    assert.ok(!options[option] || command === 'prepare', option + ' is only allowed for prepare');
  }
  assert.ok(command === 'sign' || !options['--keystore'] && !options['--password-file'], 'Signing credentials apply only to sign');
  assert.ok(options['--directory']?.trim(), 'An explicit --directory is required for every deployment command');
  const directory = path.resolve(options['--directory']);
  if (command === 'prepare') {
    assert.equal(Boolean(options['--metadata-directory']), options['--contract'] === 'DMXOffchainRenderer',
      '--metadata-directory is required only for DMXOffchainRenderer preparation');
    const roles = preparationRoles(options);
    if (network === 'mainnet') deploymentConfiguration(network, undefined, undefined, 'DMXWebpRenderer', roles);
    const renderer = options['--renderer-directory'] ? readRendererRelease(path.resolve(options['--renderer-directory']), network) : null;
    deploymentConfiguration(network, options['--quote-signer'], renderer?.manifest.contractAddress, options['--contract'], roles);
  }
  const canonical = privateDirectory(directory);
  return withMetadataLock(path.join(canonical, 'operation.lock'), () => runDeployment(command, options, network, canonical));
}

function preparationRoles(options) {
  const pairs = [['--deployer', 'deployer'], ['--admin', 'admin'], ['--maximum-fee-wei', 'feeCeilingWei']];
  return Object.fromEntries(pairs.filter(([option]) => options[option] !== undefined).map(([option, key]) => [key, options[option]]));
}

async function runDeployment(command, options, network, directory) {
  const manifestPath = path.join(directory, 'manifest.json');
  const journalPath = path.join(directory, 'transactions.private.json');
  if (command === 'prepare') assert.ok(!fs.existsSync(manifestPath) && !fs.existsSync(journalPath),
    'Deployment directory already contains a release; resume it instead');
  if (command === 'sign') assert.ok(!fs.existsSync(journalPath),
    'A transaction is already journaled; resume broadcast or verification');
  const manifest = command === 'prepare' ? null : JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const rendererRelease = manifest?.contractName === 'TarotCards' ? readRendererRelease(path.join(directory, 'renderer'), network)
    : command === 'prepare' && options['--renderer-directory'] ? readRendererRelease(path.resolve(options['--renderer-directory']), network) : null;
  const configuration = manifest ? validateDeploymentConfiguration(manifest, network)
    : deploymentConfiguration(network, options['--quote-signer'], rendererRelease?.manifest.contractAddress, options['--contract'], preparationRoles(options));
  const contractName = configuration.contractName;
  let publication;
  let pins = manifest ? metadataPins(manifest) : rendererRelease ? metadataPins(rendererRelease.manifest) : {};
  if (contractName === 'DMXOffchainRenderer') {
    if (command === 'prepare') {
      const publicationManifest = await loadDmxMetadataManifest(path.resolve(options['--metadata-directory']));
      const publicationVerification = JSON.parse(fs.readFileSync(path.join(path.resolve(options['--metadata-directory']), 'verification.json'), 'utf8'));
      pins = { expectedCollectionUri: OFFCHAIN_COLLECTION_URI,
        collectionMetadataSha256: publicationManifest.objects.find(object => object.file === 'collection.json')?.sha256,
        metadataManifestSha256: dmxMetadataManifestSha256(publicationManifest) };
      validateMetadataPublication(publicationManifest, publicationVerification, { contractName, ...pins });
      assert.equal(publicationVerification.storageVerified, true, 'Metadata storage verification is missing');
      publication = { publicationManifest, publicationVerification };
    } else publication = readMetadataPublication(directory, manifest);
    await resolveCollectionMetadata(OFFCHAIN_COLLECTION_URI, { contractName, ...pins });
    await verifyRendererPublication({ manifest: { contractName, ...pins }, ...publication });
  }
  const deployer = configuration.deployer;
  const rpcUrl = (network === 'mainnet' ? process.env.ETHEREUM_TAROT_MAINNET_RPC_URL : process.env.ETHEREUM_TAROT_RPC_URL) ||
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
  if (rendererRelease) {
    assert.equal(rendererRelease.manifest.contractAddress, configuration.renderer, 'Renderer prerequisite address changed');
    if (manifest) assert.equal(manifest.rendererReleaseSha256, sha256(json(rendererRelease.files)), 'Frozen renderer release changed');
    if (command === 'prepare') {
      assert.equal(deploymentCollectionImage(rendererRelease.manifest, rendererRelease.deployment), collectionImage,
        'New collection preparation requires the current DMX renderer media');
    }
    await verifyRendererRelease(rendererRelease, rpc);
    await verifyRendererPublication(rendererRelease);
  }

  if (command === 'prepare') {
    const artifact = JSON.parse(fs.readFileSync(path.join(project, 'out', contractName + '.sol', contractName + '.json'), 'utf8'));
    assert.equal(artifact.metadata.compiler.version, '0.8.38+commit.1835d247');
    assert.equal(artifact.metadata.settings.optimizer.enabled, true);
    assert.equal(artifact.metadata.settings.optimizer.runs, 200);
    assert.equal(artifact.metadata.settings.evmVersion, 'prague');
    assert.ok(!artifact.metadata.settings.viaIR, 'Unexpected via-IR compiler setting');
    assert.equal(artifact.metadata.settings.metadata.bytecodeHash, 'none');
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
      assert.ok(filename.startsWith(project + path.sep), 'Source escapes contract project');
      const content = fs.readFileSync(filename, 'utf8');
      assert.equal(hashHex('0x' + Buffer.from(content).toString('hex')), metadata.keccak256, 'Build artifact is stale: ' + source);
      sources[source] = { content };
    }
    const { compilationTarget, ...settings } = artifact.metadata.settings;
    assert.deepEqual(compilationTarget, { ['src/' + contractName + '.sol']: contractName });
    const standardInput = { language: 'Solidity', sources,
      settings: { ...settings, outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'metadata'] } } } };
    const manifest = { network, ...configuration, expectedCollectionImage: collectionImage, ...pins,
      preparedAt: new Date().toISOString(), contractAddress: predicted,
      nonce: nonce.toString(), constructorArgs, creationCode, ...gas,
      ...(rendererRelease ? { rendererReleaseSha256: sha256(json(rendererRelease.files)) } : {}),
      artifactSha256: sha256(json(artifact)), standardInputSha256: sha256(json(standardInput)) };
    if (rendererRelease) {
      for (const [name, value] of Object.entries(rendererRelease.files)) durableWrite(path.join(directory, 'renderer', name), value);
    }
    if (publication) {
      durableWrite(path.join(directory, 'publication-manifest.json'), publication.publicationManifest);
      durableWrite(path.join(directory, 'publication-verification.json'), publication.publicationVerification);
    }
    durableWrite(path.join(directory, contractName + '.artifact.json'), artifact);
    durableWrite(path.join(directory, contractName + '.standard-input.json'), standardInput);
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
  const artifact = JSON.parse(fs.readFileSync(path.join(directory, contractName + '.artifact.json'), 'utf8'));
  const standardInput = JSON.parse(fs.readFileSync(path.join(directory, contractName + '.standard-input.json'), 'utf8'));
  assert.equal(sha256(json(artifact)), manifest.artifactSha256, 'Frozen artifact changed');
  assert.equal(sha256(json(standardInput)), manifest.standardInputSha256, 'Frozen compiler input changed');
  validateFrozenContract(manifest, artifact, standardInput);
  assert.equal(manifest.creationCode, artifact.bytecode.object + manifest.constructorArgs.slice(2), 'Creation bytecode changed');
  const manifestSha256 = sha256(json(manifest));

  if (command === 'sign') {
    assert.ok(options['--keystore'] && options['--password-file'], 'Signing requires --keystore and --password-file');
    for (const [source, frozen] of Object.entries(standardInput.sources)) {
      const filename = path.resolve(project, source);
      assert.ok(filename.startsWith(project + path.sep), 'Source escapes contract project');
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
  assert.ok(matchingRuntime(artifact.deployedBytecode.object, code, artifact.deployedBytecode.immutableReferences ?? {}), 'Deployed runtime mismatch');
  const previousDeployment = Object.hasOwn(manifest, 'expectedCollectionImage') ? undefined
    : JSON.parse(fs.readFileSync(path.join(directory, 'deployment.json'), 'utf8'));
  const metadata = await verifyDeploymentState(manifest, rpc, receipt.blockNumber, previousDeployment);
  assert.equal(BigInt(await rpc('eth_getBalance', [manifest.contractAddress, receipt.blockNumber])), 0n);
  const report = { releaseVersion: 2, contractName, chainId: manifest.chainId, contractAddress: manifest.contractAddress,
    ...metadataPins(manifest),
    ...(Object.hasOwn(manifest, 'expectedCollectionImage') ? { expectedCollectionImage: manifest.expectedCollectionImage } : {}),
    deploymentBlock: Number(BigInt(receipt.blockNumber)), deploymentBlockHash: receipt.blockHash,
    transactionHash: journal.transactionHash, deployer, admin: manifest.admin,
    ...(contractName === 'TarotCards' ? { quoteSigner: manifest.quoteSigner, renderer: manifest.renderer,
      initialCards: 777, maxCards: 999999, receiptOffset: 999999, redemptionReceiptOffset: 1000776,
      rendererArtifactSha256: rendererRelease.manifest.artifactSha256 } : {}),
    collectionMetadata: metadata, runtimeBytes: (code.length - 2) / 2,
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
    console.error(error instanceof assert.AssertionError || /^(Another metadata operation|Legacy or invalid metadata lock|Unrecognized metadata lock|Unreadable metadata lock)/.test(error?.message ?? '')
      ? error.message : 'TarotCards deployment operation failed; inspect the journal before retrying.');
    process.exitCode = 1;
  });
}
