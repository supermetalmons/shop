import { randomUUID } from 'node:crypto';
import { open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { decodeReturn, encodeCall } from '../../shared/ethereum/abi.ts';
import { ethereumMetadataBaseUri } from '../../shared/ethereum/config.ts';
import { ETHEREUM_111K_CONTROL_SQL, parseEthereum111kControl } from '../../shared/ethereum/control.ts';
import { parseEthereumRevealDeployment, type EthereumRevealDeployment } from '../../shared/ethereum/revealDeployment.ts';
import { getRevealCatalog } from '../../shared/ethereum/revealCatalogRegistry.ts';
import type { EthereumRevealInspection, EthereumRevealPurgeResult, EthereumRevealReplacementInspection,
  EthereumRevealRetirementResult } from '../../shared/ethereum/revealMaintenance.ts';
import { verifyRevealDeployment } from '../../cloud/workers/api/src/ethereumRevealChain.ts';
import { run111kDeployment } from '../../onchain/ethereum/scripts/111k-deployment.mjs';
import { metadataIdentities, sha256 } from '../ethereum-metadata/catalog.ts';
import { withMetadataLock } from '../ethereum-metadata/lock.ts';
import { createD1MaintenanceRunner } from './d1MaintenanceRunner.ts';
import { sqlString } from './commerceD1Maintenance.ts';
import { ETHEREUM_111K_DATA_PREFLIGHT_SQL, ETHEREUM_111K_OPS_PREFLIGHT_SQL,
  requireZeroEthereum111kHistory } from './ethereum111kMaintenance.ts';
import { createCleanupStorage, deleteCleanupPrefix, inventoryCleanupPrefix, type CleanupInventory,
  type CleanupStorage, type MetadataCleanupPolicy } from './ethereum111kCleanupStorage.ts';
import { withEthereumRevealMaintenance, type EthereumRevealMaintenanceTransport } from './ethereumRevealMaintenance.ts';
import { cleanup111kReplacementArtifacts } from './ethereum111kReplacementArtifacts.ts';
import { PublicMetadataHashMismatch, read111kReplacementPublicSamples } from './ethereum111kReplacementPublicVerification.ts';

const CHAIN = 11155111;
const ROOT = '111k-sepolia/';
const CDN = 'https://cdn.mons.shop/';
const SHA = /^[a-f0-9]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DRAIN_MS = 65_000;
const OBSERVATION_MS = 5 * 60_000;
const IDENTITIES = [...metadataIdentities()];
const EXPECTED_FILES = new Set(IDENTITIES.map(identity => identity.file));
const ARTWORK_IDS = new Set(IDENTITIES.filter(identity => identity.kind === 'artwork').map(identity => identity.tokenId));
const MODEL_HASH = sha256([...EXPECTED_FILES].sort().join('\n'));
const READ_ONLY_RPC_METHODS = new Set(['eth_chainId', 'eth_getCode', 'eth_call', 'eth_getBlockByNumber',
  'eth_getTransactionByHash', 'eth_getTransactionReceipt']);

export type ReplacementDeployment = Pick<EthereumRevealDeployment, 'deploymentId' | 'chainId' | 'contractAddress' |
  'metadataBaseUri' | 'deploymentBlock' | 'catalogVersion' | 'revision' | 'state' | 'retiredAtMs' | 'replacementDeploymentId'>;
export type ReplacementRelease = { releaseDirectory: string; manifestSha256: string; previousContract: string;
  chainId: number; deploymentId: string; contractAddress: string; metadataBaseUri: string; deploymentBlock: number;
  deploymentTransactionHash: string; artifactSha256: string; standardInputSha256: string };
export type ReplacementSnapshot = { oldDeployment: ReplacementDeployment; newDeployment: ReplacementDeployment; commerceRevision: number };
export type ReplacementArtifactContext = { releaseDirectory: string; journalPath: string; oldDeployment: ReplacementDeployment;
  newDeployment: ReplacementDeployment; write: boolean };
export type ReplacementArtifactReport = { planPath: string; planSha256: string; complete: boolean; [key: string]: unknown };
export type ReplacementCleanupOptions = { releaseDirectory: string; write?: boolean; cancel?: boolean;
  cleanupArtifacts?: (context: ReplacementArtifactContext) => Promise<ReplacementArtifactReport> };
export type ReplacementCleanupJournal = {
  version: 2; kind: '111k-replacement-cleanup'; createdAtMs: number; release: ReplacementRelease;
  oldDeployment: ReplacementDeployment; newDeployment: ReplacementDeployment; commerceRevision: number;
  model: { objectCount: number; keysSha256: string }; oldInventory: CleanupInventory;
  replacementBaseline: EthereumRevealReplacementInspection; metadataSamples: Record<string, string>;
  initialSamplesPending?: true;
  enrichmentCheckpoint?: { frozenSamples: EthereumRevealReplacementInspection['frozenSamples']; metadataSamples: Record<string, string> };
  artifacts: { planPath: string; planSha256: string; report?: ReplacementArtifactReport };
  retirement?: EthereumRevealRetirementResult; purge?: EthereumRevealPurgeResult;
  recovery?: { replacementRevision: number; commerceRevision: number; retiredAtMs: number; verifiedAtMs: number };
  deletionInventory?: CleanupInventory; deletionStartedAtMs?: number;
  metadataDeletedAtMs?: number; backendVerifiedAtMs?: number; verifiedAtMs?: number; complete?: boolean;
};
export type ReplacementCleanupDependencies = {
  readRelease(directory: string): Promise<ReplacementRelease>;
  snapshot(release: ReplacementRelease): Promise<ReplacementSnapshot>;
  verifyChain(release: ReplacementRelease, snapshot: ReplacementSnapshot): Promise<void>;
  storage(policy: MetadataCleanupPolicy): Promise<CleanupStorage>;
  maintenance<T>(run: (transport: EthereumRevealMaintenanceTransport) => Promise<T>): Promise<T>;
  artifacts(context: ReplacementArtifactContext): Promise<ReplacementArtifactReport>;
  publicSamples(deployment: ReplacementDeployment, samples: Readonly<Record<string, string>>,
    options?: { onVerified: (file: string) => Promise<void> }): Promise<() => Promise<void>>;
  oldLease(deployment: ReplacementDeployment, write: boolean, requireAbsent?: boolean): Promise<void>;
  loadJournal(path: string): Promise<unknown | null>;
  saveJournal(path: string, journal: ReplacementCleanupJournal): Promise<void>;
  clearJournal(path: string): Promise<void>;
  now(): number;
  wait(ms: number): Promise<void>;
  progress(message: string): void;
};
type ReplacementRpc = (method: string, params?: unknown[]) => Promise<unknown>;
type FrozenReleaseVerifier = (argv: string[], overrides: { rpc: ReplacementRpc; configuration: Record<string, unknown> }) => Promise<unknown>;

function integer(value: unknown, minimum = 0): value is number { return Number.isSafeInteger(value) && Number(value) >= minimum; }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function equal(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function fields(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}
function identity(scope: ReplacementDeployment) {
  return { deploymentId: scope.deploymentId, chainId: scope.chainId, contractAddress: scope.contractAddress,
    metadataBaseUri: scope.metadataBaseUri, deploymentBlock: scope.deploymentBlock, catalogVersion: scope.catalogVersion };
}
function rpcIdentity(scope: ReplacementDeployment, revision = scope.revision) {
  return { deploymentId: scope.deploymentId, chainId: scope.chainId, contractAddress: scope.contractAddress,
    metadataBaseUri: scope.metadataBaseUri, revision };
}
function validAddress(value: unknown): value is string { return typeof value === 'string' && ADDRESS.test(value) && !/^0x0{40}$/.test(value); }
function prefix(scope: Pick<ReplacementDeployment, 'metadataBaseUri'>): string { return scope.metadataBaseUri.slice(CDN.length); }
function scopeFrom(deployment: EthereumRevealDeployment): ReplacementDeployment {
  return { ...identity(deployment), revision: deployment.revision, state: deployment.state,
    retiredAtMs: deployment.retiredAtMs ?? null, replacementDeploymentId: deployment.replacementDeploymentId ?? null };
}

export function parseReplacementRelease(directory: string, manifest: unknown, deployed: unknown, signedJournal: unknown): ReplacementRelease {
  if (!record(manifest) || !record(deployed) || !record(signedJournal) || !record(signedJournal.actions)
    || !record(signedJournal.actions.deploy) || !record(signedJournal.actions.deploy.receipt)
    || manifest.version !== 1 || manifest.network !== 'sepolia' || manifest.chainId !== CHAIN
    || typeof manifest.deploymentId !== 'string' || !ID.test(manifest.deploymentId)
    || !validAddress(manifest.contractAddress) || !validAddress(manifest.previousContract)
    || manifest.previousContract === manifest.contractAddress
    || manifest.metadataBaseURI !== `${CDN}${ROOT}${manifest.deploymentId}/`
    || typeof manifest.artifactSha256 !== 'string' || !SHA.test(manifest.artifactSha256)
    || typeof manifest.standardInputSha256 !== 'string' || !SHA.test(manifest.standardInputSha256)) throw new Error('Invalid frozen replacement release.');
  const manifestSha256 = sha256(`${JSON.stringify(manifest, null, 2)}\n`);
  const receipt = signedJournal.actions.deploy.receipt;
  if (signedJournal.manifestSha256 !== manifestSha256 || deployed.manifestSha256 !== manifestSha256
    || !fields(deployed, { chainId: CHAIN, deploymentId: manifest.deploymentId, contractAddress: manifest.contractAddress,
      metadataBaseURI: manifest.metadataBaseURI, artifactSha256: manifest.artifactSha256, standardInputSha256: manifest.standardInputSha256 })
    || !integer(deployed.deploymentBlock, 1) || typeof deployed.transactionHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(deployed.transactionHash)
    || receipt.status !== '0x1' || typeof receipt.blockNumber !== 'string' || !/^0x[0-9a-f]+$/i.test(receipt.blockNumber)
    || BigInt(receipt.blockNumber) !== BigInt(deployed.deploymentBlock)
    || typeof receipt.contractAddress !== 'string' || receipt.contractAddress.toLowerCase() !== manifest.contractAddress
    || signedJournal.actions.deploy.hash !== deployed.transactionHash) throw new Error('Replacement deployment evidence does not match the frozen signed manifest.');
  return { releaseDirectory: resolve(directory), manifestSha256, chainId: CHAIN, deploymentId: manifest.deploymentId,
    contractAddress: manifest.contractAddress, previousContract: manifest.previousContract, metadataBaseUri: manifest.metadataBaseURI,
    deploymentBlock: deployed.deploymentBlock, deploymentTransactionHash: deployed.transactionHash,
    artifactSha256: manifest.artifactSha256, standardInputSha256: manifest.standardInputSha256 };
}

export function validateReplacementSnapshot(release: ReplacementRelease, snapshot: ReplacementSnapshot): void {
  const old = snapshot.oldDeployment, current = snapshot.newDeployment;
  for (const deployment of [old, current]) {
    if (!deployment || !ID.test(deployment.deploymentId) || deployment.chainId !== CHAIN || !validAddress(deployment.contractAddress)
      || !integer(deployment.deploymentBlock, 1) || !integer(deployment.revision, 1)
      || !/^111k-v[1-9]\d{0,8}$/.test(deployment.catalogVersion)) throw new Error('Invalid replacement registry scope.');
    ethereumMetadataBaseUri(deployment.metadataBaseUri, CHAIN);
  }
  if (!fields(current, { chainId: release.chainId, deploymentId: release.deploymentId, contractAddress: release.contractAddress,
    metadataBaseUri: release.metadataBaseUri, deploymentBlock: release.deploymentBlock,
    state: 'active' }) || !getRevealCatalog(current.catalogVersion) || current.retiredAtMs != null || current.replacementDeploymentId != null
    || old.contractAddress !== release.previousContract || old.state !== 'paused'
    || old.contractAddress === current.contractAddress || old.deploymentId === current.deploymentId
    || old.metadataBaseUri === current.metadataBaseUri || !integer(snapshot.commerceRevision, 1)
    || old.retiredAtMs != null && (!integer(old.retiredAtMs, 1) || old.replacementDeploymentId !== current.deploymentId)
    || old.retiredAtMs == null && old.replacementDeploymentId != null) throw new Error('Old and replacement deployment controls do not match the frozen release.');
  const previousPrefix = prefix(old), currentPrefix = prefix(current);
  if (previousPrefix !== ROOT && (previousPrefix.startsWith(currentPrefix) || currentPrefix.startsWith(previousPrefix))) {
    throw new Error('Old and replacement metadata namespaces overlap.');
  }
}

export function replacementCleanupPolicy(snapshot: ReplacementSnapshot): MetadataCleanupPolicy {
  const old = prefix(snapshot.oldDeployment), current = prefix(snapshot.newDeployment);
  const oldFile = (file: string) => /^[1-9]\d{0,77}\.json$/.test(file) && BigInt(file.slice(0, -5)) < (1n << 256n);
  return { deletePrefixes: [old], hasPrefix: value => value === old || value === current,
    mayDeletePrefix: value => value === old && value !== current, files: () => EXPECTED_FILES,
    allowsFile: (value, file) => value === current ? EXPECTED_FILES.has(file) : value === old && oldFile(file),
    requiresCompleteCoverage: value => value === current,
    allowsNestedPrefix: (value, nested) => value === ROOT && /^111k-sepolia\/[a-z0-9][a-z0-9-]{0,63}\/$/.test(nested),
    mayReadKey: key => key.startsWith(current) && EXPECTED_FILES.has(key.slice(current.length)) };
}

function validateBaseline(scope: ReplacementDeployment, value: EthereumRevealReplacementInspection): void {
  if (!value || !fields(value, { ...rpcIdentity(scope), ready: true }) || !integer(value.frozenThroughMs)
    || !integer(value.frozenArtworks) || value.frozenArtworks > ARTWORK_IDS.size || !SHA.test(value.frozenMetadataSha256)
    || !Array.isArray(value.frozenSamples) || value.frozenSamples.length !== Math.min(8, value.frozenArtworks)
    || new Set(value.frozenSamples.map(sample => sample.tokenId)).size !== value.frozenSamples.length
    || value.frozenSamples.some(sample => !ARTWORK_IDS.has(sample.tokenId) || !SHA.test(sample.metadataSha256)
      || sample.enrichment !== undefined && (!sample.enrichment || sample.enrichment.version !== 'v0'
        || !SHA.test(sample.enrichment.sha256) || typeof sample.enrichment.published !== 'boolean'))) {
    throw new Error('Replacement readiness or frozen artwork fingerprint was not verified.');
  }
}

function validateArtifacts(report: ReplacementArtifactReport): void {
  if (!report || typeof report.planPath !== 'string' || !report.planPath || !SHA.test(report.planSha256)
    || typeof report.complete !== 'boolean') throw new Error('Local artifact cleanup did not provide a bound, reviewable plan.');
}

function validateRetirement(journal: ReplacementCleanupJournal, value: EthereumRevealRetirementResult): void {
  if (!value || !fields(value, { ...rpcIdentity(journal.oldDeployment, journal.oldDeployment.revision + 1),
    replacementDeploymentId: journal.newDeployment.deploymentId, replacementRevision: journal.newDeployment.revision, quiesced: true })
    || !integer(value.retiredAtMs, 1) || journal.recovery && value.retiredAtMs !== journal.recovery.retiredAtMs) {
    throw new Error('Replacement retirement was not confirmed.');
  }
}

function validatePurge(journal: ReplacementCleanupJournal, value: EthereumRevealInspection, requirePurge = false): void {
  if (!journal.retirement || !value || !fields(value, { ...rpcIdentity(journal.oldDeployment, journal.retirement.revision),
    storageEmpty: true, alarmCleared: true }) || requirePurge && (value as EthereumRevealPurgeResult).purged !== true) {
    throw new Error('Retired replacement storage purge was not confirmed.');
  }
}

function validateJournal(value: unknown, release: ReplacementRelease): ReplacementCleanupJournal {
  const journal = value as ReplacementCleanupJournal;
  if (!journal || journal.version !== 2 || journal.kind !== '111k-replacement-cleanup' || !equal(journal.release, release)
    || !integer(journal.createdAtMs, 1) || !equal(journal.model, { objectCount: EXPECTED_FILES.size, keysSha256: MODEL_HASH })
    || !journal.oldInventory || !record(journal.metadataSamples)
    || Object.values(journal.metadataSamples).some(hash => typeof hash !== 'string' || !SHA.test(hash))
    || [journal.deletionStartedAtMs, journal.metadataDeletedAtMs, journal.backendVerifiedAtMs, journal.verifiedAtMs]
      .some(time => time !== undefined && !integer(time, 1))) {
    throw new Error('Replacement cleanup journal identity, publication model or evidence changed.');
  }
  for (const inventory of [journal.oldInventory, ...(journal.deletionInventory ? [journal.deletionInventory] : [])]) {
    if (!integer(inventory.objectCount) || !integer(inventory.totalBytes) || !SHA.test(inventory.sha256)) throw new Error('Invalid replacement cleanup inventory.');
  }
  validateReplacementSnapshot(release, journal);
  validateBaseline(journal.newDeployment, journal.replacementBaseline);
  if (journal.initialSamplesPending !== undefined && (journal.initialSamplesPending !== true || journal.enrichmentCheckpoint
    || journal.retirement || journal.recovery || !Object.keys(journal.metadataSamples).length
    || Object.entries(journal.metadataSamples).some(([file, hash]) =>
      !journal.replacementBaseline.frozenSamples.some(s => file === `${s.tokenId}.json` && hash === s.enrichment?.sha256)))) {
    throw new Error('Invalid partial replacement metadata evidence.');
  }
  if (journal.enrichmentCheckpoint) {
    const current = journalBaseline(journal);
    validateBaseline(journal.newDeployment, current);
    unchangedBaseline(current, journal.replacementBaseline);
    const observed = journal.enrichmentCheckpoint.metadataSamples;
    if (!record(observed) || Object.values(observed).some(hash => !SHA.test(hash))) throw new Error('Invalid enrichment sample checkpoint.');
    requireSampleProgress(current, observed, journal.metadataSamples);
  }
  validateArtifacts({ ...journal.artifacts, complete: false });
  if (journal.retirement) validateRetirement(journal, journal.retirement);
  if (journal.recovery && (!integer(journal.recovery.replacementRevision, journal.newDeployment.revision)
    || !integer(journal.recovery.commerceRevision, journal.commerceRevision)
    || !integer(journal.recovery.retiredAtMs, 1) || !integer(journal.recovery.verifiedAtMs, journal.recovery.retiredAtMs)
    || journal.retirement && journal.recovery.retiredAtMs !== journal.retirement.retiredAtMs)) {
    throw new Error('Invalid replacement recovery checkpoint.');
  }
  if (journal.purge) validatePurge(journal, journal.purge, true);
  if (journal.deletionInventory && !journal.purge || journal.deletionStartedAtMs && (!journal.deletionInventory
      || journal.deletionStartedAtMs < journal.retirement!.retiredAtMs + DRAIN_MS)
    || journal.metadataDeletedAtMs && (!journal.deletionStartedAtMs || journal.metadataDeletedAtMs < journal.deletionStartedAtMs)
    || journal.backendVerifiedAtMs && (!journal.metadataDeletedAtMs || journal.backendVerifiedAtMs < journal.metadataDeletedAtMs)
    || journal.complete && (!journal.verifiedAtMs || !journal.metadataDeletedAtMs
      || journal.verifiedAtMs - journal.metadataDeletedAtMs < OBSERVATION_MS || !journal.artifacts.report?.complete)) {
    throw new Error('Replacement cleanup journal stages are inconsistent.');
  }
  return journal;
}

function unchangedSnapshot(release: ReplacementRelease, snapshot: ReplacementSnapshot, journal: ReplacementCleanupJournal,
  allowRevisionRecovery = false): boolean {
  validateReplacementSnapshot(release, snapshot);
  if (!equal(identity(snapshot.oldDeployment), identity(journal.oldDeployment))
    || !equal(identity(snapshot.newDeployment), identity(journal.newDeployment))) {
    throw new Error('Replacement identities or live control revisions changed during cleanup.');
  }
  const retired = snapshot.oldDeployment.retiredAtMs != null;
  if (snapshot.oldDeployment.revision !== journal.oldDeployment.revision + (retired ? 1 : 0)) {
    throw new Error('Old deployment revision changed outside this replacement cleanup.');
  }
  const retiredAtMs = journal.retirement?.retiredAtMs ?? journal.recovery?.retiredAtMs;
  if (retiredAtMs !== undefined && (snapshot.oldDeployment.retiredAtMs !== retiredAtMs
    || snapshot.oldDeployment.replacementDeploymentId !== journal.newDeployment.deploymentId)) throw new Error('The immutable retirement marker changed.');
  const replacementRevision = journal.recovery?.replacementRevision ?? journal.newDeployment.revision;
  const commerceRevision = journal.recovery?.commerceRevision ?? journal.commerceRevision;
  const changed = snapshot.newDeployment.revision !== replacementRevision || snapshot.commerceRevision !== commerceRevision;
  if (changed && (!allowRevisionRecovery || !retired || snapshot.newDeployment.revision < replacementRevision
    || snapshot.commerceRevision < commerceRevision)) throw new Error('Replacement identities or live control revisions changed during cleanup.');
  return changed;
}

function unchangedBaseline(current: EthereumRevealReplacementInspection, original: EthereumRevealReplacementInspection): void {
  if (!equal({ ...current, revision: original.revision, frozenSamples: original.frozenSamples }, original)
    || current.frozenSamples.length !== original.frozenSamples.length || current.frozenSamples.some((sample, i) => {
      const before = original.frozenSamples[i];
      return sample.tokenId !== before.tokenId || sample.metadataSha256 !== before.metadataSha256 || before.enrichment &&
        (sample.enrichment?.sha256 !== before.enrichment.sha256 || sample.enrichment.version !== before.enrichment.version
          || before.enrichment.published && !sample.enrichment.published);
    })) throw new Error('Replacement frozen artwork baseline changed.');
}

function journalBaseline(journal: ReplacementCleanupJournal) {
  return { ...journal.replacementBaseline, frozenSamples: journal.enrichmentCheckpoint?.frozenSamples ?? journal.replacementBaseline.frozenSamples };
}

function requireSampleProgress(baseline: EthereumRevealReplacementInspection, hashes: Record<string, string>, floor: Record<string, string>) {
  if (!equal(Object.keys(hashes).sort(), Object.keys(floor).sort()) || Object.entries(floor).some(([file, old]) => {
    if (hashes[file] === old) return false;
    const sample = baseline.frozenSamples.find(item => `${item.tokenId}.json` === file);
    return !sample || old !== sample.metadataSha256 || hashes[file] !== sample.enrichment?.sha256;
  })) throw new Error('Replacement metadata samples changed.');
}

function checkpointSamples(journal: ReplacementCleanupJournal, { baseline, hashes }: { baseline: EthereumRevealReplacementInspection; hashes: Record<string, string> }) {
  const current = journal.enrichmentCheckpoint ?? journal;
  if (equal(baseline.frozenSamples, journalBaseline(journal).frozenSamples) && equal(hashes, current.metadataSamples)) return false;
  journal.enrichmentCheckpoint = { frozenSamples: baseline.frozenSamples, metadataSamples: hashes };
  return true;
}

function sampleFiles(baseline: EthereumRevealReplacementInspection): string[] {
  const bounds = new Map<string, string[]>();
  for (const entry of IDENTITIES) {
    if (entry.kind === 'artwork') continue;
    const pair = bounds.get(entry.kind);
    if (pair) pair[1] = entry.file;
    else bounds.set(entry.kind, [entry.file, entry.file]);
  }
  return [...new Set([...bounds.values()].flat().concat(baseline.frozenSamples.map(sample => `${sample.tokenId}.json`)))].sort();
}

async function samples(storage: CleanupStorage, current: ReplacementDeployment,
  baseline: EthereumRevealReplacementInspection): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const files = sampleFiles(baseline);
  for (let index = 0; index < files.length; index += 4) {
    const batch = await Promise.all(files.slice(index, index + 4).map(async file => [file, sha256(await storage.get(`${prefix(current)}${file}`))] as const));
    for (const [file, hash] of batch) result[file] = hash;
  }
  return result;
}

async function verifiedSamples(deps: ReplacementCleanupDependencies, storage: CleanupStorage, deployment: ReplacementDeployment,
  initial: EthereumRevealReplacementInspection, journal: ReplacementCleanupJournal | undefined,
  confirm: (baseline: EthereumRevealReplacementInspection, file: string, hash: string) => Promise<void>) {
  let baseline = initial;
  let floor = (journal?.enrichmentCheckpoint ?? journal)?.metadataSamples;
  async function refresh() {
    const current = await inspectNew(deps, deployment, baseline.frozenThroughMs);
    unchangedBaseline(current, baseline);
    baseline = current;
  }
  for (;;) {
    const hashes = await samples(storage, deployment, baseline);
    const unmatched = baseline.frozenSamples.filter(sample => {
      const observed = hashes[`${sample.tokenId}.json`];
      return observed !== sample.enrichment?.sha256 && (sample.enrichment?.published || observed !== sample.metadataSha256);
    });
    if (unmatched.length && unmatched.every(sample => !sample.enrichment)) await refresh();
    for (const { tokenId } of unmatched) {
      const sample = baseline.frozenSamples.find(item => item.tokenId === tokenId)!;
      if (hashes[`${tokenId}.json`] !== sample.enrichment?.sha256) {
        throw new Error(`Replacement frozen metadata is not published correctly for token ${tokenId}.`);
      }
    }
    if (floor) requireSampleProgress(baseline, hashes, journal?.initialSamplesPending ? { ...hashes, ...floor } : floor);
    if (unmatched.length) {
      floor = hashes;
      continue;
    }
    try {
      const verifyMedia = await deps.publicSamples(deployment, hashes, { onVerified: file => confirm(baseline, file, hashes[file]) });
      return { baseline, hashes, verifyMedia };
    } catch (error) {
      if (!(error instanceof PublicMetadataHashMismatch)) throw error;
      if (baseline.frozenSamples.some(sample => !sample.enrichment && Object.hasOwn(error.observed, `${sample.tokenId}.json`))) await refresh();
      floor = { ...hashes, ...error.observed };
      requireSampleProgress(baseline, floor, hashes);
    }
  }
}

async function inspectNew(deps: ReplacementCleanupDependencies, current: ReplacementDeployment,
  frozenThroughMs?: number): Promise<EthereumRevealReplacementInspection> {
  const result = await deps.maintenance(async transport => {
    if (!transport.inspectReplacement) throw new Error('Deploy the replacement maintenance API before finalizing.');
    return transport.inspectReplacement({ deploymentId: current.deploymentId, expectedRevision: current.revision,
      ...(frozenThroughMs === undefined ? {} : { frozenThroughMs }) });
  });
  validateBaseline(current, result);
  if (frozenThroughMs !== undefined && result.frozenThroughMs !== frozenThroughMs) throw new Error('Replacement frozen baseline cutoff changed.');
  return result;
}

async function waitUntil(deps: ReplacementCleanupDependencies, time: number, label: string): Promise<void> {
  while (deps.now() < time) {
    const remaining = time - deps.now();
    deps.progress(`${label}: ${Math.ceil(remaining / 1000)} seconds remaining.`);
    await deps.wait(Math.min(30_000, remaining));
  }
}

export async function execute111kReplacementCleanup(options: ReplacementCleanupOptions,
  deps: ReplacementCleanupDependencies): Promise<Record<string, unknown>> {
  const release = await deps.readRelease(resolve(options.releaseDirectory));
  const journalPath = join(release.releaseDirectory, 'cleanup-finalization.json');
  if (options.cancel) {
    const stored = await deps.loadJournal(journalPath);
    if (stored === null) throw new Error('There is no replacement cleanup journal to cancel.');
    const journal = validateJournal(stored, release);
    if (journal.retirement || journal.recovery || journal.purge || journal.deletionInventory || journal.deletionStartedAtMs
      || journal.metadataDeletedAtMs || journal.backendVerifiedAtMs || journal.complete) {
      throw new Error('Retirement has already committed; keep its journal and resume finalization.');
    }
    const request = { deploymentId: journal.oldDeployment.deploymentId, expectedRevision: journal.oldDeployment.revision,
      replacementDeploymentId: journal.newDeployment.deploymentId, expectedReplacementRevision: journal.newDeployment.revision };
    if (!options.write) return { planned: true, cancelled: false, journalPath, request };
    const result = await deps.maintenance(async transport => {
      if (!transport.cancelRetirement) throw new Error('Deploy retirement cancellation support before cancelling.');
      return transport.cancelRetirement(request);
    });
    if (!result || result.deploymentId !== request.deploymentId || result.replacementDeploymentId !== request.replacementDeploymentId
      || !integer(result.revision, request.expectedRevision + 1) || typeof result.cancelled !== 'boolean'
      || typeof result.retired !== 'boolean' || result.cancelled === result.retired) throw new Error('Retirement cancellation was not confirmed.');
    if (result.retired) return { ...result, journalPath, journalRetained: true };
    if (!equal(await deps.loadJournal(journalPath), stored)) throw new Error('Cleanup journal changed during cancellation; inspect it before retrying.');
    await deps.clearJournal(journalPath);
    return { ...result, journalPath, journalRetained: false };
  }
  const initial = await deps.snapshot(release);
  validateReplacementSnapshot(release, initial);
  await deps.verifyChain(release, initial);
  await deps.oldLease(initial.oldDeployment, false);
  const stored = await deps.loadJournal(journalPath);
  let journal = stored === null ? undefined : validateJournal(stored, release);
  const recovering = journal ? unchangedSnapshot(release, initial, journal, true) : false;
  const context = (write: boolean): ReplacementArtifactContext => ({ releaseDirectory: release.releaseDirectory, journalPath,
    oldDeployment: journal?.oldDeployment ?? initial.oldDeployment, newDeployment: initial.newDeployment, write });
  const artifactPlan = await deps.artifacts(context(false));
  validateArtifacts(artifactPlan);
  if (journal && (journal.artifacts.planSha256 !== artifactPlan.planSha256 || journal.artifacts.planPath !== artifactPlan.planPath)) {
    throw new Error('The bound local artifact cleanup plan changed.');
  }
  const baseline = await inspectNew(deps, initial.newDeployment, journal?.replacementBaseline.frozenThroughMs);
  const policy = replacementCleanupPolicy(initial);
  const storage = await deps.storage(policy);
  try {
    const [oldInventory] = await Promise.all([
      inventoryCleanupPrefix(policy, storage, prefix(initial.oldDeployment), deps.progress),
      inventoryCleanupPrefix(policy, storage, prefix(initial.newDeployment), deps.progress),
    ]);
    if (journal) {
      const sealed = journal.deletionInventory;
      if (sealed && (oldInventory.objectCount > sealed.objectCount || oldInventory.totalBytes > sealed.totalBytes
          || !journal.deletionStartedAtMs && !equal(oldInventory, sealed))
        || journal.metadataDeletedAtMs && oldInventory.objectCount !== 0) throw new Error('Retired metadata inventory changed or was recreated after sealing.');
    }
    const save = () => deps.saveJournal(journalPath, journal!);
    const saveSamples = async (frozen: EthereumRevealReplacementInspection, hashes: Record<string, string>, partial: boolean) => {
      if (!journal) {
        const old = { ...initial.oldDeployment };
        if (old.retiredAtMs != null) { old.revision--; old.retiredAtMs = null; old.replacementDeploymentId = null; }
        journal = { version: 2, kind: '111k-replacement-cleanup', createdAtMs: deps.now(), release, oldDeployment: old,
          newDeployment: initial.newDeployment, commerceRevision: initial.commerceRevision,
          model: { objectCount: EXPECTED_FILES.size, keysSha256: MODEL_HASH }, oldInventory,
          replacementBaseline: frozen, metadataSamples: hashes, ...(partial && { initialSamplesPending: true }),
          artifacts: { planPath: artifactPlan.planPath, planSha256: artifactPlan.planSha256 } };
      } else if (journal.initialSamplesPending) {
        journal.replacementBaseline = { ...journal.replacementBaseline, frozenSamples: frozen.frozenSamples };
        journal.metadataSamples = hashes;
        if (!partial) delete journal.initialSamplesPending;
      } else if (!checkpointSamples(journal, { baseline: frozen, hashes })) return;
      await save();
    };
    let saving = Promise.resolve();
    const confirm = (frozen: EthereumRevealReplacementInspection, file: string, hash: string) => {
      if (!frozen.frozenSamples.some(sample => file === `${sample.tokenId}.json` && sample.enrichment?.sha256 === hash)) return Promise.resolve();
      saving = saving.then(async () => {
        const prior = (journal?.enrichmentCheckpoint ?? journal)?.metadataSamples;
        if (prior?.[file] !== hash || !equal(journalBaseline(journal!).frozenSamples, frozen.frozenSamples)) {
          await saveSamples(frozen, { ...prior, [file]: hash }, true);
        }
      });
      return saving;
    };
    const verifyReplacement = async (deployment: ReplacementDeployment, inspection?: EthereumRevealReplacementInspection) => {
      const frozen = inspection ?? await inspectNew(deps, deployment, journal!.replacementBaseline.frozenThroughMs);
      if (journal) unchangedBaseline(frozen, journalBaseline(journal));
      const verified = await verifiedSamples(deps, storage, deployment, frozen, journal, confirm);
      await saveSamples(verified.baseline, verified.hashes, false);
      return verified;
    };
    const verified = await verifyReplacement(initial.newDeployment, baseline);
    await verified.verifyMedia();
    const verifyStableReplacement = async (deployment: ReplacementDeployment, afterSamples?: () => Promise<void>) => {
      let inspection = await inspectNew(deps, deployment, journal!.replacementBaseline.frozenThroughMs);
      for (;;) {
        const verified = await verifyReplacement(deployment, inspection);
        await verified.verifyMedia();
        await afterSamples?.();
        unchangedSnapshot(release, await deps.snapshot(release), journal!);
        inspection = await inspectNew(deps, deployment, inspection.frozenThroughMs);
        unchangedBaseline(inspection, verified.baseline);
        if (equal(inspection.frozenSamples, verified.baseline.frozenSamples)) return;
      }
    };
    const recovery = recovering ? { replacementRevision: initial.newDeployment.revision, commerceRevision: initial.commerceRevision,
      retiredAtMs: initial.oldDeployment.retiredAtMs!, verifiedAtMs: deps.now() } : journal.recovery;
    const beforeMutation = await deps.snapshot(release);
    unchangedSnapshot(release, beforeMutation, { ...journal, recovery });
    if (!options.write) {
      return { planned: true, complete: false, journalPath, oldDeployment: rpcIdentity(journal.oldDeployment),
        newDeployment: rpcIdentity(beforeMutation.newDeployment), remainingObjects: oldInventory.objectCount, newObjectCount: EXPECTED_FILES.size,
        artifactPlan: journal.artifacts };
    }
    await deps.verifyChain(release, beforeMutation);
    if (recovering) {
      journal.recovery = recovery;
      await save();
    }
    if (!journal.retirement) {
      const retirement = await deps.maintenance(async transport => {
        if (!transport.retireForReplacement) throw new Error('Deploy replacement retirement support before finalizing.');
        return transport.retireForReplacement({ deploymentId: journal!.oldDeployment.deploymentId,
          expectedRevision: journal!.oldDeployment.revision, replacementDeploymentId: journal!.newDeployment.deploymentId,
          expectedReplacementRevision: journal!.newDeployment.revision });
      });
      validateRetirement(journal, retirement);
      journal.retirement = retirement;
      await save();
    }
    await waitUntil(deps, journal.retirement.retiredAtMs + DRAIN_MS, 'Draining retired metadata writes');
    const afterDrain = await deps.snapshot(release);
    unchangedSnapshot(release, afterDrain, journal);
    await deps.verifyChain(release, afterDrain);
    const oldRequest = { deploymentId: journal.oldDeployment.deploymentId, expectedRevision: journal.retirement.revision };
    if (!journal.purge) await verifyStableReplacement(afterDrain.newDeployment);
    await deps.maintenance(async transport => {
      if (journal!.purge) validatePurge(journal!, await transport.inspectRetired(oldRequest));
      else {
        const purged = await transport.purgeRetired(oldRequest);
        validatePurge(journal!, purged, true);
        journal!.purge = purged;
        await save();
      }
    });
    if (!journal.metadataDeletedAtMs) {
      unchangedSnapshot(release, await deps.snapshot(release), journal);
      await deps.oldLease(journal.oldDeployment, false);
      let deletionLimit = oldInventory.objectCount;
      if (!journal.deletionInventory) {
        journal.deletionInventory = await inventoryCleanupPrefix(policy, storage, prefix(journal.oldDeployment), deps.progress);
        deletionLimit = journal.deletionInventory.objectCount;
        await save();
      }
      await verifyStableReplacement(afterDrain.newDeployment);
      if (!journal.deletionStartedAtMs) {
        journal.deletionStartedAtMs = deps.now();
        await save();
      }
      await deleteCleanupPrefix(policy, storage, prefix(journal.oldDeployment), deletionLimit, deps.progress, undefined, { concurrency: 4 });
      await deps.oldLease(journal.oldDeployment, true);
      journal.metadataDeletedAtMs = deps.now();
      await save();
    }
    const audit = async (fullCoverage: boolean, afterSamples?: () => Promise<void>) => {
      const fresh = await deps.snapshot(release);
      unchangedSnapshot(release, fresh, journal!);
      await deps.verifyChain(release, fresh);
      await deps.oldLease(journal!.oldDeployment, false, true);
      await deps.maintenance(async transport => validatePurge(journal!, await transport.inspectRetired(oldRequest)));
      const [old] = await Promise.all([
        inventoryCleanupPrefix(policy, storage, prefix(journal!.oldDeployment), deps.progress),
        ...(fullCoverage ? [inventoryCleanupPrefix(policy, storage, prefix(journal!.newDeployment), deps.progress)] : []),
      ]);
      if (old.objectCount !== 0) throw new Error('Retired metadata was recreated after cleanup.');
      await verifyStableReplacement(fresh.newDeployment, afterSamples);
    };
    await audit(true);
    journal.backendVerifiedAtMs = deps.now();
    await save();
    const artifactResult = await deps.artifacts(context(true));
    validateArtifacts(artifactResult);
    if (!artifactResult.complete || artifactResult.planPath !== journal.artifacts.planPath
      || artifactResult.planSha256 !== journal.artifacts.planSha256) throw new Error('Local artifact cleanup has not completed for the bound plan.');
    journal.artifacts.report = artifactResult;
    await save();
    await waitUntil(deps, journal.metadataDeletedAtMs + OBSERVATION_MS, 'Observing retired metadata across a scheduler interval');
    await audit(false, async () => {
      const report = await deps.artifacts(context(false));
      validateArtifacts(report);
      if (!report.complete || report.planPath !== journal!.artifacts.planPath
        || report.planSha256 !== journal!.artifacts.planSha256) throw new Error('Retired local artifacts were recreated or their cleanup proof changed.');
      journal!.artifacts.report = report;
    });
    journal.verifiedAtMs = deps.now();
    journal.complete = true;
    await save();
    return { complete: true, journalPath, retiredDeployment: rpcIdentity(journal.oldDeployment, journal.retirement.revision),
      replacementDeployment: rpcIdentity(journal.newDeployment, journal.recovery?.replacementRevision), deletedObjects: journal.deletionInventory!.objectCount,
      replacementObjectCount: EXPECTED_FILES.size, observationMs: journal.verifiedAtMs - journal.metadataDeletedAtMs,
      artifacts: journal.artifacts.report };
  } finally { storage.close(); }
}

async function readRelease(directory: string): Promise<ReplacementRelease> {
  const files = await Promise.all(['manifest.json', 'deployment.json', 'transactions.private.json'].map(async file => JSON.parse(await readFile(join(directory, file), 'utf8'))));
  return parseReplacementRelease(directory, files[0], files[1], files[2]);
}

export async function verify111kReplacementTransactions(release: ReplacementRelease, rpc: ReplacementRpc,
  overrides: { readManifest?: () => Promise<unknown>; verify?: FrozenReleaseVerifier } = {}): Promise<void> {
  const manifest = await (overrides.readManifest ?? (async () => JSON.parse(await readFile(join(release.releaseDirectory, 'manifest.json'), 'utf8'))))();
  if (!record(manifest) || sha256(`${JSON.stringify(manifest, null, 2)}\n`) !== release.manifestSha256
    || !validAddress(manifest.deployer) || !validAddress(manifest.owner) || !validAddress(manifest.quoteSigner)
    || manifest.deployer !== manifest.owner || manifest.previousContract !== release.previousContract) {
    throw new Error('Frozen replacement signer or constructor evidence changed.');
  }
  const readOnlyRpc: ReplacementRpc = (method, params = []) => {
    if (!READ_ONLY_RPC_METHODS.has(method)) throw new Error('Replacement verification cannot submit transactions or mutate the chain.');
    return rpc(method, params);
  };
  const verified = await (overrides.verify ?? run111kDeployment)(['verify', '--directory', release.releaseDirectory,
    '--network', 'sepolia', '--deployment-id', release.deploymentId], { rpc: readOnlyRpc,
    configuration: { chainId: release.chainId, deployer: manifest.deployer, owner: manifest.owner,
      quoteSigner: manifest.quoteSigner, previousContract: manifest.previousContract } });
  if (!record(verified) || !fields(verified, { verified: true, chainId: release.chainId, contractAddress: release.contractAddress,
    deploymentId: release.deploymentId, metadataBaseURI: release.metadataBaseUri })
    || !record(verified.state) || verified.state.saleActive !== true || !Array.isArray(verified.transactions)
    || verified.transactions.filter(transaction => record(transaction) && transaction.action === 'deploy'
      && transaction.hash === release.deploymentTransactionHash && transaction.blockNumber === release.deploymentBlock).length !== 1) {
    throw new Error('Signed replacement transactions and live deployment were not verified against the frozen release.');
  }
}

async function readSnapshot(release: ReplacementRelease): Promise<ReplacementSnapshot> {
  const ops = createD1MaintenanceRunner('ops');
  const commerce = createD1MaintenanceRunner('commerce');
  const rows = ops.query(`SELECT * FROM ethereum_reveal_deployments WHERE chain_id = ${CHAIN}
    AND contract_address IN (${sqlString(release.previousContract)}, ${sqlString(release.contractAddress)})`).map(parseEthereumRevealDeployment);
  const old = rows.find(row => row.contractAddress === release.previousContract);
  const current = rows.find(row => row.contractAddress === release.contractAddress);
  if (rows.length !== 2 || !old || !current || old.dropId !== '111k_devnet' || current.dropId !== '111k_devnet') throw new Error('Both frozen replacement scopes must have canonical reveal registrations.');
  const scope = `chain_id = ${CHAIN} AND contract_address = ${sqlString(old.contractAddress)}`;
  const queries: Record<string, string> = { control: ETHEREUM_111K_CONTROL_SQL };
  for (const table of ['ethereum_delivery_quotes', 'ethereum_delivery_checkouts', 'ethereum_crate_claims', 'ethereum_reconciliation_cursor']) {
    queries[table] = `SELECT COUNT(*) AS count FROM ${table} WHERE ${scope}`;
  }
  queries.attempts = `SELECT COUNT(*) AS count FROM ethereum_delivery_checkout_attempts a JOIN ethereum_delivery_checkouts c USING(checkout_id)
    WHERE c.chain_id = ${CHAIN} AND c.contract_address = ${sqlString(old.contractAddress)}`;
  queries.documents = `SELECT COUNT(*) AS count FROM commerce_documents WHERE drop_id = '111k_devnet'
    AND json_extract(document_json, '$.chainId') = ${CHAIN} AND json_extract(document_json, '$.contractAddress') = ${sqlString(old.contractAddress)}`;
  queries.ambiguous = `SELECT COUNT(*) AS count FROM commerce_documents WHERE drop_id = '111k_devnet'
    AND (json_type(document_json, '$.chainId') IS NULL OR json_type(document_json, '$.contractAddress') IS NULL)`;
  const counts = commerce.queryBatch(queries);
  const control = parseEthereum111kControl(counts.control[0]);
  for (const [name, rows] of Object.entries(counts)) if (name !== 'control'
    && (rows.length !== 1 || rows[0].count !== 0)) throw new Error(`Old replacement commerce state remains in ${name}.`);
  if (control.paused || control.resetGuardId !== null || control.chainId !== CHAIN || control.contractAddress !== release.contractAddress) {
    throw new Error('Replacement commerce control is not active on the frozen new contract.');
  }
  requireZeroEthereum111kHistory(createD1MaintenanceRunner('data').query(ETHEREUM_111K_DATA_PREFLIGHT_SQL), 'unscoped legacy DATA pack-status history');
  requireZeroEthereum111kHistory(ops.query(ETHEREUM_111K_OPS_PREFLIGHT_SQL), 'unscoped legacy OPS reveal submissions');
  const { unstable_readConfig } = await import('wrangler');
  const config = unstable_readConfig({ config: 'cloud/workers/api/wrangler.jsonc', 'env-file': ['cloud/workers/api/release.env'] });
  const expected = { chainId: CHAIN, contractAddress: release.contractAddress, metadataBaseUri: release.metadataBaseUri,
    deploymentBlock: release.deploymentBlock };
  if (!fields({ chainId: Number(config.vars.ETHEREUM_111K_CHAIN_ID), contractAddress: config.vars.ETHEREUM_111K_CONTRACT_ADDRESS,
    metadataBaseUri: config.vars.ETHEREUM_111K_METADATA_BASE_URI, deploymentBlock: Number(config.vars.ETHEREUM_111K_DEPLOYMENT_BLOCK) }, expected)) {
    throw new Error('Repository API configuration does not match the frozen replacement.');
  }
  const response = await fetch('https://mons.shop/api/ethereum/111k/config', { headers: { Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(15_000) });
  if (!response.ok || !fields(await response.json() as Record<string, unknown>, { ...expected, enabled: true })) throw new Error('Live API configuration does not match the frozen replacement.');
  return { oldDeployment: scopeFrom(old), newDeployment: scopeFrom(current), commerceRevision: control.revision };
}

async function verifyChain(release: ReplacementRelease, snapshot: ReplacementSnapshot): Promise<void> {
  const key = process.env.ALCHEMY_API_KEY || process.env.ALCHEMY_MI_NOTE_API_KEY;
  const endpoint = process.env.ETHEREUM_111K_RPC_URL || (key ? `https://eth-sepolia.g.alchemy.com/v2/${encodeURIComponent(key)}` : '');
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error('Set the existing Sepolia deployment RPC credentials.'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Replacement verification requires an HTTPS RPC endpoint.');
  const rpc: ReplacementRpc = async (method, params = []) => {
    if (!READ_ONLY_RPC_METHODS.has(method)) throw new Error('Replacement verification only permits read-only chain requests.');
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const body = await response.json() as { id?: number; result?: unknown; error?: unknown };
    if (!response.ok || body.id !== 1 || body.error || !Object.hasOwn(body, 'result')) throw new Error('Replacement chain verification failed.');
    return body.result;
  };
  await verify111kReplacementTransactions(release, rpc);
  await verifyRevealDeployment({ ALCHEMY_MI_NOTE_API_KEY: 'replacement-verification' }, snapshot.newDeployment,
    AbortSignal.timeout(45_000), (_input, init) => fetch(endpoint, init));
  const checks = [[release.contractAddress, 'saleActive()', true], [release.previousContract, 'saleActive()', false],
    [release.previousContract, 'redemptionsPaused()', true]] as const;
  for (const [contract, method, expected] of checks) {
    const value = await rpc('eth_call', [{ to: contract, data: encodeCall(method, [], []) }, 'latest']);
    if (typeof value !== 'string' || decodeReturn(['bool'], value)[0] !== expected) throw new Error('Replacement sale or retired-contract pause state is not ready for finalization.');
  }
}

async function oldLease(deployment: ReplacementDeployment, write: boolean, requireAbsent = false): Promise<void> {
  const ops = createD1MaintenanceRunner('ops');
  const uri = sqlString(deployment.metadataBaseUri);
  const now = "CAST(strftime('%s', 'now') AS INTEGER) * 1000";
  const rows = ops.query(`SELECT lease_id, expires_at_ms, updated_at_ms, ${now} AS now_ms FROM ethereum_metadata_publication_leases WHERE metadata_base_uri=${uri}`);
  if (requireAbsent && rows.length) throw new Error('Obsolete publication lease remains.');
  if (rows.length > 1 || rows.length === 1 && (!integer(rows[0].expires_at_ms) || !integer(rows[0].updated_at_ms)
    || Number(rows[0].expires_at_ms) + DRAIN_MS > Number(rows[0].now_ms))) throw new Error('Old publication lease has not drained.');
  if (write && rows.length) {
    const row = rows[0];
    ops.query(`DELETE FROM ethereum_metadata_publication_leases WHERE metadata_base_uri=${uri} AND lease_id=${sqlString(String(row.lease_id))}
      AND expires_at_ms=${row.expires_at_ms} AND updated_at_ms=${row.updated_at_ms} AND expires_at_ms+${DRAIN_MS}<=${now}
      AND EXISTS (SELECT 1 FROM ethereum_reveal_deployments WHERE deployment_id=${sqlString(deployment.deploymentId)}
        AND retired_at_ms IS NOT NULL AND state='paused' AND metadata_base_uri=${uri}) RETURNING metadata_base_uri`);
    if (ops.query(`SELECT metadata_base_uri FROM ethereum_metadata_publication_leases WHERE metadata_base_uri=${uri}`).length) throw new Error('Old publication lease changed during cleanup.');
  }
}

export async function run111kReplacementCleanup(options: ReplacementCleanupOptions,
  overrides: Partial<ReplacementCleanupDependencies> = {}): Promise<Record<string, unknown>> {
  if (!options || typeof options.releaseDirectory !== 'string' || !options.releaseDirectory.trim()) throw new Error('A frozen replacement release directory is required.');
  const releaseDirectory = await realpath(resolve(options.releaseDirectory));
  const deps: ReplacementCleanupDependencies = { readRelease, snapshot: readSnapshot, verifyChain, storage: createCleanupStorage,
    maintenance: withEthereumRevealMaintenance, oldLease, publicSamples: read111kReplacementPublicSamples,
    artifacts: options.cleanupArtifacts ?? (async context => cleanup111kReplacementArtifacts({ oldDeployment: context.oldDeployment,
      newDeployment: context.newDeployment, journalPath: context.journalPath }, { write: context.write })),
    loadJournal: async path => { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } },
    saveJournal: async (path, journal) => {
      const temporary = `${path}.${randomUUID()}.tmp`;
      const handle = await open(temporary, 'wx', 0o600);
      try {
        try { await handle.writeFile(`${JSON.stringify(journal, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, path);
        const directory = await open(dirname(path), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } finally {
        await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    },
    clearJournal: async path => {
      await unlink(path);
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    },
    now: Date.now, wait: async ms => { await delay(ms); }, progress: message => console.error(message), ...overrides };
  return withMetadataLock(join(releaseDirectory, 'cleanup-finalization.lock'), () => execute111kReplacementCleanup({ ...options, releaseDirectory }, deps));
}
