import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { keccak_256 } from '@noble/hashes/sha3';
import { encodeAbi } from '../../shared/ethereum/abi.ts';
import { normalizeEthereumAddress } from '../../shared/ethereum/protocol.ts';
import { withMetadataLock } from '../ethereum-metadata/lock.ts';
import {
  assertExistingTarotCredentialPin, assertTarotCredentialPin, assertTarotDeploymentActive, freezeTarotClaimLinks,
  loadTarotClaimLinks, privateDirectory, provisionTarotCredentials, readTarotCredentials, recordVerifiedTarotCredentials,
  TAROT_CREDENTIAL_PIN_PATH, tarotCredentialPin, verifyTarotCredentials, writeTarotJsonOnce,
  type TarotClaimLinks, type TarotCredentialDatabase,
} from './claimLinks.ts';

const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const transactionPattern = /^0x[0-9a-f]{64}$/;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Sepolia rebind evidence.');
  return value as Record<string, unknown>;
}

function readJson(filename: string, privateFile = false): Record<string, unknown> {
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || privateFile && (stat.mode & 0o777) !== 0o600) {
    throw new Error('Invalid Sepolia rebind evidence file.');
  }
  try { return object(JSON.parse(readFileSync(filename, 'utf8'))); }
  catch { throw new Error('Cannot read Sepolia rebind evidence.'); }
}

function address(value: unknown): string {
  const normalized = normalizeEthereumAddress(value);
  if (!normalized || normalized !== value || /^0x0{40}$/.test(normalized)) throw new Error('Invalid Sepolia deployment address.');
  return normalized;
}

function replacementDeployment(directory: string): { contractAddress: string; identitySha256: string } {
  const manifest = readJson(resolve(directory, 'manifest.json'));
  const deployment = readJson(resolve(directory, 'deployment.json'));
  const artifact = readJson(resolve(directory, 'TarotCards.artifact.json'));
  const input = readJson(resolve(directory, 'TarotCards.standard-input.json'));
  const contractAddress = address(manifest.contractAddress);
  const admin = address(manifest.admin);
  const deployer = address(manifest.deployer);
  const quoteSigner = address(manifest.quoteSigner);
  const renderer = address(manifest.renderer);
  const constructorArgs = encodeAbi(['address', 'address', 'address'], [admin, quoteSigner, renderer]);
  const bytecode = object(artifact.bytecode).object;
  const runtime = object(artifact.deployedBytecode).object;
  const metadata = object(artifact.metadata);
  const settings = object(metadata.settings);
  if (manifest.releaseVersion !== 2 || manifest.contractName !== 'TarotCards' || manifest.network !== 'sepolia' ||
    manifest.chainId !== 11155111 || quoteSigner === deployer || renderer === contractAddress ||
    typeof bytecode !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(bytecode) ||
    typeof runtime !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(runtime) ||
    object(metadata.compiler).version !== '0.8.38+commit.1835d247' || object(settings.optimizer).runs !== 200 ||
    settings.evmVersion !== 'prague' || json(settings.compilationTarget) !== json({ 'src/TarotCards.sol': 'TarotCards' }) ||
    manifest.constructorArgs !== constructorArgs || manifest.creationCode !== bytecode + constructorArgs.slice(2) ||
    manifest.artifactSha256 !== sha256(json(artifact)) || manifest.standardInputSha256 !== sha256(json(input))) {
    throw new Error('Replacement must be a frozen verified DMX Sepolia deployment.');
  }
  const sources = object(input.sources);
  const metadataSources = object(metadata.sources);
  if (JSON.stringify(Object.keys(sources).sort()) !== JSON.stringify(Object.keys(metadataSources).sort())) {
    throw new Error('Replacement source set differs from its artifact.');
  }
  for (const [name, source] of Object.entries(sources)) {
    const content = object(source).content;
    if (typeof content !== 'string' || object(metadataSources[name]).keccak256 !==
      '0x' + Buffer.from(keccak_256(Buffer.from(content))).toString('hex')) {
      throw new Error('Replacement source content differs from its artifact.');
    }
  }
  for (const key of ['releaseVersion', 'contractName', 'chainId', 'contractAddress', 'admin', 'deployer', 'quoteSigner',
    'renderer', 'artifactSha256', 'standardInputSha256', 'constructorArgs']) {
    if (deployment[key] !== manifest[key]) throw new Error('Replacement deployment report differs from its manifest.');
  }
  const receipt = object(deployment.receipt);
  if (!Number.isSafeInteger(deployment.deploymentBlock) || Number(deployment.deploymentBlock) < 1 ||
    !Number.isSafeInteger(deployment.confirmations) || Number(deployment.confirmations) < 3 ||
    typeof deployment.transactionHash !== 'string' || !transactionPattern.test(deployment.transactionHash) ||
    typeof deployment.deploymentBlockHash !== 'string' || !transactionPattern.test(deployment.deploymentBlockHash) ||
    typeof deployment.runtimeKeccak256 !== 'string' || !transactionPattern.test(deployment.runtimeKeccak256) ||
    deployment.runtimeBytes !== (runtime.length - 2) / 2 || deployment.initialCards !== 777 ||
    deployment.maxCards !== 999999 || deployment.receiptOffset !== 999999 || deployment.redemptionReceiptOffset !== 1000776 ||
    typeof deployment.verifiedAt !== 'string' || !Number.isFinite(Date.parse(deployment.verifiedAt)) ||
    receipt.status !== '0x1' || normalizeEthereumAddress(receipt.contractAddress) !== contractAddress ||
    normalizeEthereumAddress(receipt.from) !== deployer || receipt.to !== null ||
    receipt.transactionHash !== deployment.transactionHash || receipt.blockHash !== deployment.deploymentBlockHash ||
    receipt.blockNumber !== '0x' + Number(deployment.deploymentBlock).toString(16)) {
    throw new Error('Replacement deployment has not completed verification.');
  }
  return { contractAddress, identitySha256: sha256(json({ manifestSha256: sha256(json(manifest)),
    transactionHash: deployment.transactionHash, deploymentBlock: deployment.deploymentBlock,
    deploymentBlockHash: deployment.deploymentBlockHash, runtimeKeccak256: deployment.runtimeKeccak256 })) };
}

function overlaps(left: string, right: string): boolean {
  const child = relative(left, right);
  return !child || !isAbsolute(child) && child !== '..' && !child.startsWith('..' + sep);
}

export async function rebindTarotCredentials(options: {
  sourceDirectory: string; sourcePin: string; deploymentDirectory: string; directory: string; root: string;
}, database: TarotCredentialDatabase) {
  const root = resolve(options.root);
  const sourceDirectory = resolve(options.sourceDirectory);
  const directory = resolve(options.directory);
  const sourcePin = resolve(options.sourcePin);
  const deploymentDirectory = resolve(options.deploymentDirectory);
  if (overlaps(sourceDirectory, directory) || overlaps(directory, sourceDirectory) || overlaps(sourceDirectory, deploymentDirectory) ||
    sourcePin === resolve(root, TAROT_CREDENTIAL_PIN_PATH)) throw new Error('Rebind source and target must be distinct.');
  privateDirectory(sourceDirectory, root);
  privateDirectory(directory, root);
  const locks = [resolve(sourceDirectory, 'claim-links.lock'), resolve(directory, 'claim-links.lock'),
    resolve(deploymentDirectory, 'operation.lock')].sort();
  const locked = async <T>(index: number, work: () => Promise<T>): Promise<T> => index === locks.length
    ? work() : withMetadataLock(locks[index], () => locked(index + 1, work));
  return locked(0, async () => {
    const source = loadTarotClaimLinks(sourceDirectory, root);
    const pin = readJson(sourcePin);
    assertTarotCredentialPin(source, pin);
    verifyTarotCredentials(source, readTarotCredentials(source, database), true);
    const replacement = replacementDeployment(deploymentDirectory);
    if (source.contractAddress === replacement.contractAddress) throw new Error('Rebind requires a replacement contract.');
    const sourceManifestSha256 = sha256(json(source));
    const sourcePinSha256 = sha256(json(pin));
    const frozen = { version: 1, sourceContractAddress: source.contractAddress, sourceManifestSha256, sourcePinSha256,
      targetContractAddress: replacement.contractAddress, targetDeploymentSha256: replacement.identitySha256 };
    const journalPath = resolve(directory, 'credential-rebind.private.json');
    const existing = lstatSync(journalPath, { throwIfNoEntry: false }) ? readJson(journalPath, true) : null;
    if (!existing && lstatSync(resolve(directory, 'claim-links.private.json'), { throwIfNoEntry: false })) {
      throw new Error('Existing target credentials have no frozen rebind evidence.');
    }
    const createdAtMs = existing?.createdAtMs ?? Math.max(Date.now(), source.createdAtMs + 1);
    if (!Number.isSafeInteger(createdAtMs) || Number(createdAtMs) <= source.createdAtMs) throw new Error('Invalid frozen rebind timestamp.');
    const manifest: TarotClaimLinks = { version: 1, chainId: source.chainId, contractAddress: replacement.contractAddress,
      createdAtMs: Number(createdAtMs), links: source.links.map(({ tokenId, code, url }) => ({ tokenId, code, url })) };
    const journal = { ...frozen, createdAtMs, targetManifestSha256: sha256(json(manifest)) };
    if (existing && (Object.keys(existing).length !== Object.keys(journal).length ||
      Object.entries(journal).some(([key, value]) => existing[key] !== value))) {
      throw new Error('Rebind source or replacement changed after freezing.');
    }
    assertExistingTarotCredentialPin(manifest, root);
    assertTarotDeploymentActive(manifest, database);
    writeTarotJsonOnce(journalPath, journal);
    freezeTarotClaimLinks(directory, manifest, root);
    provisionTarotCredentials(manifest, database, root);
    const currentSource = loadTarotClaimLinks(sourceDirectory, root);
    if (sha256(json(currentSource)) !== sourceManifestSha256 || sha256(json(readJson(sourcePin))) !== sourcePinSha256 ||
      replacementDeployment(deploymentDirectory).identitySha256 !== replacement.identitySha256) {
      throw new Error('Rebind source or replacement changed during provisioning.');
    }
    verifyTarotCredentials(currentSource, readTarotCredentials(currentSource, database), true);
    if (sha256(json(loadTarotClaimLinks(directory, root))) !== journal.targetManifestSha256) {
      throw new Error('Target credentials changed during provisioning.');
    }
    assertTarotDeploymentActive(manifest, database);
    recordVerifiedTarotCredentials(manifest, readTarotCredentials(manifest, database), root);
    return { operation: 'rebind', ...tarotCredentialPin(manifest), sourceContractAddress: source.contractAddress,
      privateManifest: resolve(directory, 'claim-links.private.json'), verified: true };
  });
}
