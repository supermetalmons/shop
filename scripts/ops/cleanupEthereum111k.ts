import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { metadataIdentities, sha256 } from '../ethereum-metadata/catalog.ts';
import { withMetadataLock } from '../ethereum-metadata/lock.ts';
import { acquireRetired111kPreviewCleanupLease, type MetadataWriteFence } from '../ethereum-metadata/publicationLease.ts';
import { createD1MaintenanceRunner } from '../shared/d1MaintenanceRunner.ts';
import { ETHEREUM_111K_DATA_PREFLIGHT_SQL, ETHEREUM_111K_OPS_PREFLIGHT_SQL, requireZeroEthereum111kHistory } from '../shared/ethereum111kMaintenance.ts';
import { withEthereumRevealMaintenance, type EthereumRevealMaintenanceTransport } from '../shared/ethereumRevealMaintenance.ts';
import { ETHEREUM_111K_CONTROL_SQL, parseEthereum111kControl } from '../../shared/ethereum/control.ts';
import { parseEthereumRevealDeployment } from '../../shared/ethereum/revealDeployment.ts';
import type { EthereumRevealInspection, EthereumRevealPurgeResult } from '../../shared/ethereum/revealMaintenance.ts';
import { createCleanupStorage as createScopedCleanupStorage, inventoryCleanupPrefix as inventoryScopedPrefix,
  deleteCleanupPrefix as deleteScopedPrefix, validateCleanupObject as validateScopedObject,
  type CleanupObject, type CleanupStorage, type MetadataCleanupPolicy } from '../shared/ethereum111kCleanupStorage.ts';
import { run111kReplacementCleanup, type ReplacementCleanupOptions } from '../shared/ethereum111kReplacementCleanup.ts';

export { run111kReplacementCleanup } from '../shared/ethereum111kReplacementCleanup.ts';

const ROOT = '111k-sepolia/';
const PREVIEW = `${ROOT}reliquaries-v1/`;
const CDN = 'https://cdn.mons.shop/';
const OBJECT_COUNT = 344984;
const HASH = /^[0-9a-f]{64}$/;
export const CLEANUP_CURRENT = Object.freeze({ deploymentId: 'v16', chainId: 11155111,
  contractAddress: '0x938b6a488951b2797b29284d6939dd70efe146a0', metadataBaseUri: `${CDN}${ROOT}v16/`,
  deploymentBlock: 12087015, catalogVersion: '111k-v5' });
const CURRENT_PREFIX = `${ROOT}v16/`;
export const CLEANUP_TARGETS = Object.freeze([
  ['sepolia-8b4044db', '0x8b4044dbd10c05d84d067208980de58e9d5fe915', ROOT, '111k-v1'],
  ['v7', '0xc7571e9dc4b1cd646d092d51cfa89a76a6461fec', `${ROOT}v7/`, '111k-v1'],
  ['v8', '0xab705be519d707a56f43abd63f0869e88fc882b7', `${ROOT}v8/`, '111k-v1'],
  ['v9', '0x4d127fceeaa8b652744c4cb1f62f1101290180a8', `${ROOT}v9/`, '111k-v1'],
  ['v10', '0xc495131aab4eddb3c9a90a761bd0ab1550ce35a5', `${ROOT}v10/`, '111k-v1'],
  ['v11', '0xef5ffe06eb0d94a575656eb6ffcd97b8e2121b1c', `${ROOT}v11/`, '111k-v1'],
  ['v12', '0x320cf00a3606350821ed90ea435e93955b180874', `${ROOT}v12/`, '111k-v1'],
  ['v13', '0x8ef2789bc22098749a8ca746263fd85442949eff', `${ROOT}v13/`, '111k-v2'],
  ['v14', '0x6d194e6cc762424e408b84907c25d60f0db29d12', `${ROOT}v14/`, '111k-v3'],
  ['v15', '0xe665d1043f72886f49894006ea196450b33f0f89', `${ROOT}v15/`, '111k-v4'],
].map(([deploymentId, contractAddress, prefix, catalogVersion]) => Object.freeze({ deploymentId, contractAddress,
  chainId: 11155111, metadataBaseUri: `${CDN}${prefix}`, catalogVersion })));
const DELETE_PREFIXES = [...CLEANUP_TARGETS.map(target => target.metadataBaseUri.slice(CDN.length)), PREVIEW];
const ALL_PREFIXES = [...DELETE_PREFIXES, CURRENT_PREFIX];
const NESTED_PREFIXES = new Set(ALL_PREFIXES.filter(prefix => prefix !== ROOT));
const IDENTITIES = [...metadataIdentities()];
const EXPECTED_FILES = new Set(IDENTITIES.map(identity => identity.file));
const PREVIEW_FILES = new Set(Array.from({ length: 30 }, (_, index) => `${117172 + index}.json`));
const ROOT_FILES = new Set(IDENTITIES.filter(identity => identity.kind !== 'relic' && identity.kind !== 'relic_receipt').map(identity => identity.file));
const V7_FILES = new Set([...ROOT_FILES, ...PREVIEW_FILES]);
const V8_FILES = new Set(IDENTITIES.filter(identity => identity.kind !== 'relic_receipt').map(identity => identity.file));

function expectedCleanupFiles(prefix: string): ReadonlySet<string> {
  return prefix === PREVIEW ? PREVIEW_FILES : prefix === ROOT ? ROOT_FILES
    : prefix === `${ROOT}v7/` ? V7_FILES : prefix === `${ROOT}v8/` ? V8_FILES : EXPECTED_FILES;
}

export type { CleanupObject, CleanupPage, CleanupStorage } from '../shared/ethereum111kCleanupStorage.ts';
export type CleanupSnapshot = { currentRevision: number; commerceRevision: number; targets: Array<typeof CLEANUP_TARGETS[number] & { revision: number }> };
export type CleanupInventory = { objectCount: number; totalBytes: number; sha256: string };
export type CleanupManifest = {
  version: 1; createdAt: string; current: typeof CLEANUP_CURRENT; snapshot: CleanupSnapshot;
  inventory: Record<string, CleanupInventory>; currentArtworkSha256: Record<string, string>;
  startedAt?: string; receipts: Record<string, EthereumRevealPurgeResult>; completedPrefixes: string[]; verifiedAt?: string;
};
type Args = { command: 'plan' | 'apply' | 'verify'; manifest: string; write: boolean };
export type CleanupDependencies = {
  snapshot(): Promise<CleanupSnapshot>;
  storage: CleanupStorage;
  maintenance<T>(run: (transport: EthereumRevealMaintenanceTransport) => Promise<T>): Promise<T>;
  previewLease(write: boolean, requireAbsent?: boolean): Promise<void>;
  previewMutation<T>(work: (fence: MetadataWriteFence) => Promise<T>): Promise<T>;
  load(path: string): Promise<unknown>;
  save(path: string, value: CleanupManifest, create: boolean): Promise<void>;
  now(): string;
  progress(message: string): void;
};

export function parseCleanupEthereum111kArgs(argv: string[]): Args {
  const { values, positionals, tokens } = parseArgs({ args: argv, allowPositionals: true, tokens: true,
    options: { manifest: { type: 'string' }, write: { type: 'boolean', default: false } } });
  const seen = new Set<string>();
  for (const token of tokens) if (token.kind === 'option') {
    if (seen.has(token.name)) throw new Error(`Duplicate option --${token.name}.`);
    seen.add(token.name);
  }
  if (positionals.length !== 1 || !['plan', 'apply', 'verify'].includes(positionals[0]) || !values.manifest?.trim()
    || values.write && positionals[0] !== 'apply') throw new Error('Usage: cleanup:ethereum111k -- <plan|apply|verify> --manifest FILE [--write]');
  return { command: positionals[0] as Args['command'], manifest: resolve(values.manifest), write: values.write };
}

export function parse111kReplacementCleanupArgs(argv: string[]): ReplacementCleanupOptions {
  const { values, positionals, tokens } = parseArgs({ args: argv, allowPositionals: true, tokens: true,
    options: { 'release-directory': { type: 'string' }, write: { type: 'boolean', default: false } } });
  const seen = new Set<string>();
  for (const token of tokens) if (token.kind === 'option') {
    if (seen.has(token.name)) throw new Error(`Duplicate option --${token.name}.`);
    seen.add(token.name);
  }
  if (positionals.length !== 1 || !['finalize', 'cancel'].includes(positionals[0]) || !values['release-directory']?.trim()) {
    throw new Error('Usage: cleanup:ethereum111k -- <finalize|cancel> --release-directory DIR [--write]');
  }
  return { releaseDirectory: resolve(values['release-directory']), write: values.write,
    ...(positionals[0] === 'cancel' ? { cancel: true } : {}) };
}

function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
function equal(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function sameFields(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

export function validateCleanupSnapshot(snapshot: CleanupSnapshot): void {
  if (!snapshot || !positive(snapshot.currentRevision) || !positive(snapshot.commerceRevision)
    || !Array.isArray(snapshot.targets) || snapshot.targets.length !== CLEANUP_TARGETS.length
    || !CLEANUP_TARGETS.every((target, index) => snapshot.targets[index]
      && sameFields(snapshot.targets[index], target) && positive(snapshot.targets[index].revision))) {
    throw new Error('Cleanup deployment identities or revisions do not match the fixed retirement allowlist.');
  }
}

export function validateCleanupManifest(value: unknown): CleanupManifest {
  const manifest = value as CleanupManifest;
  if (!manifest || manifest.version !== 1 || !sameFields(manifest.current ?? {}, CLEANUP_CURRENT)
    || typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt))
    || manifest.startedAt !== undefined && !Number.isFinite(Date.parse(manifest.startedAt))
    || !manifest.inventory || !equal(Object.keys(manifest.inventory).sort(), [...ALL_PREFIXES].sort())
    || !manifest.currentArtworkSha256 || Object.keys(manifest.currentArtworkSha256).length !== 20
    || !Array.from({ length: 20 }, (_, i) => `${i + 1}.json`).every(file => HASH.test(manifest.currentArtworkSha256[file] ?? ''))
    || !manifest.receipts || Array.isArray(manifest.receipts) || typeof manifest.receipts !== 'object'
    || !Object.keys(manifest.receipts).every(id => CLEANUP_TARGETS.some(target => target.deploymentId === id))
    || !Array.isArray(manifest.completedPrefixes) || new Set(manifest.completedPrefixes).size !== manifest.completedPrefixes.length
    || !manifest.completedPrefixes.every(prefix => DELETE_PREFIXES.includes(prefix))) throw new Error('Invalid cleanup manifest.');
  validateCleanupSnapshot(manifest.snapshot);
  for (const inventory of Object.values(manifest.inventory)) {
    if (!inventory || !Number.isSafeInteger(inventory.objectCount) || inventory.objectCount < 0
      || !Number.isSafeInteger(inventory.totalBytes) || inventory.totalBytes < 0 || !HASH.test(inventory.sha256)) throw new Error('Invalid cleanup inventory.');
  }
  if (manifest.inventory[CURRENT_PREFIX].objectCount !== OBJECT_COUNT) throw new Error('Current collection coverage is incomplete.');
  return manifest;
}

const LEGACY_POLICY: MetadataCleanupPolicy = {
  deletePrefixes: DELETE_PREFIXES,
  hasPrefix: prefix => ALL_PREFIXES.includes(prefix),
  mayDeletePrefix: prefix => DELETE_PREFIXES.includes(prefix),
  files: expectedCleanupFiles,
  requiresCompleteCoverage: prefix => prefix === CURRENT_PREFIX,
  allowsNestedPrefix: (prefix, nested) => prefix === ROOT && NESTED_PREFIXES.has(nested),
  mayReadKey: key => new RegExp(`^${CURRENT_PREFIX}(?:[1-9]|1[0-9]|20)\\.json$`).test(key),
};

export function validateCleanupObject(prefix: string, object: CleanupObject): void {
  validateScopedObject(LEGACY_POLICY, prefix, object);
}

export function inventoryCleanupPrefix(storage: CleanupStorage, prefix: string,
  progress: (message: string) => void = () => {}): Promise<CleanupInventory> {
  return inventoryScopedPrefix(LEGACY_POLICY, storage, prefix, progress);
}

async function parallel<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  let failure: unknown;
  const results = await Promise.allSettled(Array.from({ length: Math.min(8, items.length) }, async () => {
    while (index < items.length && !failure) {
      const item = items[index++];
      try { await work(item); } catch (error) { failure = error; throw error; }
    }
  }));
  const rejected = results.find(result => result.status === 'rejected');
  if (rejected?.status === 'rejected') throw rejected.reason;
}

async function inventories(deps: CleanupDependencies): Promise<Record<string, CleanupInventory>> {
  const found: Record<string, CleanupInventory> = {};
  await parallel(ALL_PREFIXES, async prefix => { found[prefix] = await inventoryCleanupPrefix(deps.storage, prefix, deps.progress); });
  return Object.fromEntries(ALL_PREFIXES.map(prefix => [prefix, found[prefix]]));
}

async function artworkHashes(storage: CleanupStorage): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  await parallel(Array.from({ length: 20 }, (_, i) => `${i + 1}.json`), async file => {
    found[file] = sha256(await storage.get(`${CURRENT_PREFIX}${file}`));
  });
  return Object.fromEntries(Array.from({ length: 20 }, (_, i) => `${i + 1}.json`).map(file => [file, found[file]]));
}

export function validateCleanupReceipt(target: CleanupSnapshot['targets'][number], receipt: EthereumRevealInspection,
  requirePurge = false): void {
  if (!receipt || !sameFields(receipt, { deploymentId: target.deploymentId, chainId: target.chainId,
    contractAddress: target.contractAddress, metadataBaseUri: target.metadataBaseUri, revision: target.revision,
    storageEmpty: true, alarmCleared: true }) || requirePurge && (receipt as EthereumRevealPurgeResult).purged !== true) {
    throw new Error(`Reveal purge was not confirmed for ${target.deploymentId}.`);
  }
}

export function deleteCleanupPrefix(storage: CleanupStorage, prefix: string, maximum: number,
  progress: (message: string) => void = () => {}, fence?: MetadataWriteFence): Promise<number> {
  return deleteScopedPrefix(LEGACY_POLICY, storage, prefix, maximum, progress, fence);
}

export async function executeCleanupEthereum111k(args: Args, deps: CleanupDependencies): Promise<Record<string, unknown>> {
  const snapshot = await deps.snapshot();
  validateCleanupSnapshot(snapshot);
  await deps.previewLease(false);
  if (args.command === 'plan') {
    const manifest: CleanupManifest = { version: 1, createdAt: deps.now(), current: CLEANUP_CURRENT, snapshot,
      inventory: await inventories(deps), currentArtworkSha256: await artworkHashes(deps.storage), receipts: {}, completedPrefixes: [] };
    if (!equal(snapshot, await deps.snapshot())) throw new Error('Deployment controls changed during inventory.');
    await deps.save(args.manifest, manifest, true);
    return { command: 'plan', manifest: args.manifest, targets: snapshot.targets.length,
      deleteObjects: DELETE_PREFIXES.reduce((sum, prefix) => sum + manifest.inventory[prefix].objectCount, 0),
      currentObjects: manifest.inventory[CURRENT_PREFIX].objectCount };
  }
  const manifest = validateCleanupManifest(await deps.load(args.manifest));
  if (!equal(snapshot, manifest.snapshot)) throw new Error('Deployment identities or revisions changed since the cleanup plan.');
  const observed = await inventories(deps);
  if (!equal(manifest.currentArtworkSha256, await artworkHashes(deps.storage))) throw new Error('Current immutable artwork metadata changed.');
  for (const prefix of DELETE_PREFIXES) {
    if (!manifest.startedAt && !equal(observed[prefix], manifest.inventory[prefix])
      || observed[prefix].objectCount > manifest.inventory[prefix].objectCount
      || observed[prefix].totalBytes > manifest.inventory[prefix].totalBytes
      || manifest.completedPrefixes.includes(prefix) && observed[prefix].objectCount !== 0) {
      throw new Error(`Cleanup inventory changed under ${prefix}.`);
    }
  }
  if (args.command === 'apply' && !args.write) return { command: 'apply', dryRun: true, manifest: args.manifest,
    remainingObjects: DELETE_PREFIXES.reduce((sum, prefix) => sum + observed[prefix].objectCount, 0) };
  let saveChain = Promise.resolve();
  const save = () => {
    saveChain = saveChain.then(() => deps.save(args.manifest, manifest, false));
    return saveChain;
  };
  if (args.command === 'verify') {
    if (!manifest.startedAt || DELETE_PREFIXES.some(prefix => observed[prefix].objectCount !== 0)) throw new Error('Retired metadata remains.');
    await deps.maintenance(async transport => {
      for (const target of snapshot.targets) {
        validateCleanupReceipt(target, manifest.receipts[target.deploymentId], true);
        validateCleanupReceipt(target, await transport.inspectRetired({ deploymentId: target.deploymentId, expectedRevision: target.revision }));
      }
    });
    if (!equal(snapshot, await deps.snapshot())) throw new Error('Deployment controls changed during verification.');
    await deps.previewLease(false, true);
    manifest.verifiedAt = deps.now();
    await save();
    return { command: 'verify', verified: true, manifest: args.manifest, currentObjects: observed[CURRENT_PREFIX].objectCount };
  }
  manifest.startedAt ??= deps.now();
  await save();
  await deps.maintenance(async transport => {
    for (const target of snapshot.targets) {
      const request = { deploymentId: target.deploymentId, expectedRevision: target.revision };
      if (manifest.receipts[target.deploymentId]) {
        validateCleanupReceipt(target, manifest.receipts[target.deploymentId], true);
        validateCleanupReceipt(target, await transport.inspectRetired(request));
      } else {
        const receipt = await transport.purgeRetired(request);
        validateCleanupReceipt(target, receipt, true);
        manifest.receipts[target.deploymentId] = receipt;
        await save();
      }
      deps.progress(`Confirmed retired reveal storage is empty: ${target.deploymentId}`);
    }
  });
  if (!equal(snapshot, await deps.snapshot())) throw new Error('Deployment controls changed before metadata deletion.');
  await parallel(DELETE_PREFIXES, async prefix => {
    const remove = (fence?: MetadataWriteFence) => deleteCleanupPrefix(deps.storage, prefix, observed[prefix].objectCount, deps.progress, fence);
    if (prefix === PREVIEW && observed[prefix].objectCount > 0) await deps.previewMutation(remove);
    else await remove();
    if (!manifest.completedPrefixes.includes(prefix)) manifest.completedPrefixes.push(prefix);
    await save();
  });
  await deps.previewLease(true);
  if (!equal(snapshot, await deps.snapshot())) throw new Error('Deployment controls changed during cleanup.');
  if (!equal(manifest.currentArtworkSha256, await artworkHashes(deps.storage))) throw new Error('Current immutable artwork metadata changed.');
  return { command: 'apply', completed: true, manifest: args.manifest, deletedPrefixes: [...DELETE_PREFIXES],
    next: 'Run verify after at least one five-minute scheduler interval.' };
}

async function readLiveSnapshot(): Promise<CleanupSnapshot> {
  const commerce = createD1MaintenanceRunner('commerce');
  const ops = createD1MaintenanceRunner('ops');
  const data = createD1MaintenanceRunner('data');
  const { unstable_readConfig } = await import('wrangler');
  const config = unstable_readConfig({ config: 'cloud/workers/api/wrangler.jsonc', 'env-file': ['cloud/workers/api/release.env'] });
  const vars = config.vars;
  if (vars.ETHEREUM_111K_CONTRACT_ADDRESS !== CLEANUP_CURRENT.contractAddress
    || vars.ETHEREUM_111K_METADATA_BASE_URI !== CLEANUP_CURRENT.metadataBaseUri
    || Number(vars.ETHEREUM_111K_CHAIN_ID) !== CLEANUP_CURRENT.chainId
    || Number(vars.ETHEREUM_111K_DEPLOYMENT_BLOCK) !== CLEANUP_CURRENT.deploymentBlock) throw new Error('Repository configuration is no longer the protected v16 deployment.');
  const response = await fetch('https://mons.shop/api/ethereum/111k/config', { headers: { Accept: 'application/json' },
    cache: 'no-store', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error('Cannot verify live storefront configuration.');
  const live = await response.json() as Record<string, unknown>;
  if (!sameFields(live, { chainId: CLEANUP_CURRENT.chainId, contractAddress: CLEANUP_CURRENT.contractAddress,
    metadataBaseUri: CLEANUP_CURRENT.metadataBaseUri, deploymentBlock: CLEANUP_CURRENT.deploymentBlock, enabled: true })) {
    throw new Error('Live storefront is no longer the protected v16 deployment.');
  }
  const rows = ops.query("SELECT * FROM ethereum_reveal_deployments WHERE chain_id = 11155111 AND drop_id = '111k_devnet'")
    .map(parseEthereumRevealDeployment);
  const current = rows.find(row => row.deploymentId === 'v16');
  if (rows.length !== 11 || !current || current.state !== 'active' || !sameFields(current, CLEANUP_CURRENT)) throw new Error('Reveal registry no longer matches the cleanup deployment set.');
  const targets = CLEANUP_TARGETS.map(target => {
    const row = rows.find(candidate => candidate.deploymentId === target.deploymentId);
    if (!row || row.state !== 'paused' || !sameFields(row, target)) throw new Error(`Retired deployment identity changed: ${target.deploymentId}.`);
    return { ...target, revision: row.revision };
  });
  const scope = `chain_id = 11155111 AND contract_address <> '${CLEANUP_CURRENT.contractAddress}'`;
  const queries: Record<string, string> = { control: ETHEREUM_111K_CONTROL_SQL };
  for (const table of ['ethereum_delivery_quotes', 'ethereum_delivery_checkouts', 'ethereum_crate_claims', 'ethereum_reconciliation_cursor']) {
    queries[table] = `SELECT COUNT(*) AS count FROM ${table} WHERE ${scope}`;
  }
  queries.attempts = `SELECT COUNT(*) AS count FROM ethereum_delivery_checkout_attempts a
    LEFT JOIN ethereum_delivery_checkouts c USING(checkout_id) WHERE c.checkout_id IS NULL OR (c.chain_id = 11155111 AND c.contract_address <> '${CLEANUP_CURRENT.contractAddress}')`;
  queries.documents = `SELECT COUNT(*) AS count FROM commerce_documents WHERE drop_id = '111k_devnet'
    AND (json_extract(document_json, '$.chainId') IS NOT 11155111 OR json_extract(document_json, '$.contractAddress') IS NOT '${CLEANUP_CURRENT.contractAddress}')`;
  const results = commerce.queryBatch(queries);
  const control = parseEthereum111kControl(results.control[0]);
  if (control.paused || control.resetGuardId !== null || control.chainId !== CLEANUP_CURRENT.chainId
    || control.contractAddress !== CLEANUP_CURRENT.contractAddress) throw new Error('Commerce control is not active on protected v16.');
  for (const [label, result] of Object.entries(results)) if (label !== 'control') requireZeroEthereum111kHistory(result, label);
  requireZeroEthereum111kHistory(data.query(ETHEREUM_111K_DATA_PREFLIGHT_SQL), 'DATA pack-status history');
  requireZeroEthereum111kHistory(ops.query(ETHEREUM_111K_OPS_PREFLIGHT_SQL), 'OPS legacy reveal submissions');
  return { currentRevision: current.revision, commerceRevision: control.revision, targets };
}

async function previewLease(write: boolean, requireAbsent = false): Promise<void> {
  const ops = createD1MaintenanceRunner('ops');
  const uri = `${CDN}${PREVIEW}`;
  const now = "CAST(strftime('%s', 'now') AS INTEGER) * 1000";
  const rows = ops.query(`SELECT expires_at_ms, updated_at_ms, ${now} AS now_ms
    FROM ethereum_metadata_publication_leases WHERE metadata_base_uri = '${uri}'`);
  if (requireAbsent && rows.length) throw new Error('Testnet preview publication lease remains.');
  if (rows.length > 1 || rows.length === 1 && (Number(rows[0].expires_at_ms) + 65000 > Number(rows[0].now_ms)
    || !Number.isSafeInteger(rows[0].expires_at_ms) || !Number.isSafeInteger(rows[0].updated_at_ms))) throw new Error('Testnet preview publication lease has not drained.');
  if (write && rows.length) {
    ops.query(`DELETE FROM ethereum_metadata_publication_leases WHERE metadata_base_uri = '${uri}'
      AND expires_at_ms = ${rows[0].expires_at_ms} AND updated_at_ms = ${rows[0].updated_at_ms}
      AND expires_at_ms + 65000 <= ${now} RETURNING metadata_base_uri`);
    if (ops.query(`SELECT metadata_base_uri FROM ethereum_metadata_publication_leases WHERE metadata_base_uri = '${uri}'`).length) {
      throw new Error('Testnet preview publication lease changed during cleanup.');
    }
  }
}

export function createCleanupStorage(env: NodeJS.ProcessEnv = process.env): Promise<CleanupStorage> {
  return createScopedCleanupStorage(LEGACY_POLICY, env);
}

export async function runCleanupEthereum111k(argv: string[], overrides: Partial<CleanupDependencies> = {}) {
  if (argv[0] === 'finalize' || argv[0] === 'cancel') return run111kReplacementCleanup(parse111kReplacementCleanupArgs(argv));
  const args = parseCleanupEthereum111kArgs(argv);
  return withMetadataLock(`${args.manifest}.lock`, async () => {
    const storage = overrides.storage ?? await createCleanupStorage();
    const deps: CleanupDependencies = { snapshot: readLiveSnapshot, storage, maintenance: withEthereumRevealMaintenance, previewLease,
      previewMutation: async work => {
        const lease = await acquireRetired111kPreviewCleanupLease();
        let result: Awaited<ReturnType<typeof work>>;
        try { result = await work(lease); } finally { await lease.close(); }
        console.error('Draining the testnet preview publication lease for 65 seconds.');
        for (const delay of [30_000, 30_000, 5_000]) await new Promise(done => setTimeout(done, delay));
        return result;
      },
      load: async path => JSON.parse(await readFile(path, 'utf8')),
      save: async (path, value, create) => {
        const content = `${JSON.stringify(value, null, 2)}\n`;
        if (create) await writeFile(path, content, { flag: 'wx', mode: 0o600 });
        else { await writeFile(`${path}.tmp`, content, { mode: 0o600 }); await rename(`${path}.tmp`, path); }
      }, now: () => new Date().toISOString(), progress: message => console.error(message), ...overrides };
    try { return await executeCleanupEthereum111k(args, deps); }
    finally { storage.close(); }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { console.log(JSON.stringify(await runCleanupEthereum111k(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Cleanup failed.'); process.exitCode = 1; }
}
