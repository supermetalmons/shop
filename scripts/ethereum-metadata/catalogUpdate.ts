import { randomInt, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeRevealCatalogDescriptor, revealCatalogMedia, validateRevealAssetCatalog,
  type RevealAssetCatalog } from '../../shared/ethereum/revealAssetCatalog.ts';
import { revealCatalogAdditions, revealCatalogUpdateHash, validateRevealCatalogUpdateBatch,
  type RevealCatalogUpdateBatch, type RevealCatalogUpdateBody } from '../../shared/ethereum/revealCatalogUpdate.ts';
import { selectRevealCollectionBlocks, validateRevealCollectionBlocks } from '../../shared/ethereum/revealCollectionBlocks.ts';
import type { EthereumRevealCatalogUpdateRequest, EthereumRevealCatalogUpdateResult } from '../../shared/ethereum/revealMaintenance.ts';
import { withEthereumRevealMaintenance } from '../shared/ethereumRevealMaintenance.ts';
import { buildRevealAssetCatalog, withRevealAssetImportLock } from './assetImport.ts';
import { sha256 } from './catalog.ts';
import { withMetadataLock } from './lock.ts';
import { getOwnerHatchingGrail } from '../../shared/ethereum/ownerHatchingCatalog.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ASSETS = 'scripts/ethereum-metadata/reveal-assets/111k_devnet';
const ANCESTORS = 'shared/ethereum/revealCatalogAncestors.json';
export type RevealCatalogUpdateInput = { sourcePath: string; catalogVersion?: string; rootDirectory?: string;
  eggIds?: number[]; eggCutoff?: number };
export type RevealCatalogUpdateBundle = { batch: RevealCatalogUpdateBatch; source: string; predecessorSource: string };
export type RevealCatalogUpdateSummary = {
  predecessorVersion: string; targetVersion: string; sourceSha256: string; additions: number;
  oldEggCount: number; newEggCount: number; firstCutoffEgg: number; lastCutoffEgg: number;
  addedByCategory: Record<string, number>;
};
export type RevealCatalogMediaPreflight = { batchId: string; batchSha256: string; checkedAt: string; objects: number; reportSha256: string };
type UpdateTransport = (request: EthereumRevealCatalogUpdateRequest) => Promise<EthereumRevealCatalogUpdateResult>;

async function optionalFile(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

function requireUnchangedSource(before: string, after: string): void {
  const previous = JSON.parse(before) as Record<string, unknown>;
  const next = JSON.parse(after) as Record<string, unknown>;
  if (Object.entries(previous).some(([path, dimensions]) => {
    const updated = next[path];
    return !Array.isArray(dimensions) || !Array.isArray(updated) ||
      dimensions[0] !== updated[0] || dimensions[1] !== updated[1];
  })) {
    throw new Error('Catalog expansion cannot remove or change existing source paths or dimensions.');
  }
  if (Object.entries(previous).some(([path, dimensions]) => Array.isArray(dimensions) && dimensions.length === 3 &&
    dimensions[2] !== (next[path] as unknown[])[2])) {
    throw new Error('Catalog expansion cannot remove or change existing collection block labels.');
  }
}

export function ordinaryRevealCatalogSource(bytes: string): string {
  const source: unknown = JSON.parse(bytes);
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Invalid ordinary reveal source.');
  const paths = [...bytes.matchAll(/("(?:\\.|[^"\\])*")\s*:/g)].map(match => JSON.parse(match[1]) as string);
  if (new Set(paths).size !== paths.length) throw new Error('Artwork source contains duplicate paths.');
  let removed = false;
  const entries = Object.entries(source).filter(([path, value]) => {
    const match = /^animated\/([1-9]\d*)\.(png|gif|mp4)$/.exec(path);
    const grail = match && getOwnerHatchingGrail('animated', Number(match[1]));
    if (!grail) return true;
    if (!Array.isArray(value) || value.length < 2 || !Number.isSafeInteger(value[0]) || !Number.isSafeInteger(value[1]) ||
      value[0] * grail.aspectRatio.height !== value[1] * grail.aspectRatio.width ||
      value[2] !== undefined && value[2] !== grail.collectionBlock) throw new Error('Existing owner hatching artwork changed.');
    removed = true;
    return false;
  });
  return removed ? `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n` : bytes;
}

async function inputCatalogs(input: RevealCatalogUpdateInput) {
  const root = resolve(input.rootDirectory ?? ROOT);
  const [inputSource, predecessorSource, manifest, descriptor, blockSource, blockArtifact] = await Promise.all([
    readFile(resolve(input.sourcePath), 'utf8'), readFile(join(root, ASSETS, 'source.json'), 'utf8'),
    readFile(join(root, ASSETS, 'manifest.json'), 'utf8'), readFile(join(root, 'shared/ethereum/revealCatalog.json'), 'utf8'),
    optionalFile(join(root, ASSETS, 'collection-blocks.source.json')), optionalFile(join(root, ASSETS, 'collection-blocks.json')),
  ]);
  const source = ordinaryRevealCatalogSource(inputSource);
  const previous: unknown = JSON.parse(manifest);
  const previousDescriptor = JSON.parse(descriptor);
  validateRevealAssetCatalog(previous, previousDescriptor);
  if (previous.source.sha256 !== sha256(predecessorSource)) throw new Error('Saved reveal source checksum mismatch.');
  const catalogVersion = input.catalogVersion ?? `111k-v${Number(previous.catalogVersion.slice(6)) + 1}`;
  const target = buildRevealAssetCatalog(source, { catalogVersion, availableEggs: previous.importSettings.availableEggs });
  requireUnchangedSource(predecessorSource, source);
  if (blockSource !== null || blockArtifact !== null) {
    if (blockSource === null || blockArtifact === null) throw new Error('Collection block source and artifact must both exist.');
    const blocks: unknown = JSON.parse(blockArtifact);
    validateRevealCollectionBlocks(blocks);
    if (sha256(blockSource) !== blocks.source.sha256) throw new Error('Saved collection block source checksum mismatch.');
    if (!selectRevealCollectionBlocks(blocks, previousDescriptor)) throw new Error('Collection blocks do not cover the predecessor catalog.');
    requireUnchangedSource(blockSource, source);
  }
  const additions = revealCatalogAdditions(previous, target);
  return { source, predecessorSource, predecessor: { manifest: previous, descriptor: previousDescriptor },
    target: { manifest: target, descriptor: computeRevealCatalogDescriptor(target) }, additions };
}

export async function inspectRevealCatalogUpdate(input: RevealCatalogUpdateInput): Promise<RevealCatalogUpdateSummary> {
  const { predecessor, target, additions } = await inputCatalogs(input);
  return { predecessorVersion: predecessor.manifest.catalogVersion, targetVersion: target.manifest.catalogVersion,
    sourceSha256: target.manifest.source.sha256, additions: additions.length,
    oldEggCount: predecessor.manifest.categories.eggs.count, newEggCount: target.manifest.categories.eggs.count,
    firstCutoffEgg: target.manifest.categories.eggs.count + 1, lastCutoffEgg: predecessor.manifest.categories.eggs.count,
    addedByCategory: Object.fromEntries(['painting', 'video', '3d', 'animated'].map(category =>
      [category, additions.filter(row => row.category === category).length])) };
}

export function buildRevealCatalogUpdateBatch(predecessor: RevealAssetCatalog, target: RevealAssetCatalog,
  choose: (maximum: number) => number = randomInt, explicit?: { eggIds: number[]; eggCutoff: number }): RevealCatalogUpdateBatch {
  const additions = revealCatalogAdditions(predecessor, target);
  for (let index = additions.length - 1; index > 0; index--) {
    const selected = choose(index + 1);
    if (!Number.isSafeInteger(selected) || selected < 0 || selected > index) throw new Error('Invalid catalog shuffle result.');
    [additions[index], additions[selected]] = [additions[selected], additions[index]];
  }
  const eggIds = explicit ? [...explicit.eggIds].sort((a, b) => a - b) : additions.map((_, index) => target.categories.eggs.count + index + 1);
  if (eggIds.length !== additions.length) throw new Error('Explicit cutoff eggs must match the ordinary artwork additions.');
  const body: RevealCatalogUpdateBody = { ...(explicit ? { version: 2 as const, eggCutoff: explicit.eggCutoff } : { version: 1 as const }), nonce: randomUUID(),
    predecessor: { manifest: predecessor, descriptor: computeRevealCatalogDescriptor(predecessor) },
    target: { manifest: target, descriptor: computeRevealCatalogDescriptor(target) },
    mappings: additions.map((addition, index) => ({ eggId: eggIds[index], ...addition })) };
  const batchSha256 = revealCatalogUpdateHash(body);
  const batch = { ...body, batchId: `catalog-${batchSha256.slice(0, 32)}`, batchSha256 };
  validateRevealCatalogUpdateBatch(batch);
  return batch;
}

export async function readRevealCatalogUpdateBundle(directory: string): Promise<RevealCatalogUpdateBundle> {
  const [raw, source, predecessorSource] = await Promise.all(['batch.json', 'source.json', 'predecessor-source.json']
    .map(name => readFile(join(directory, name), 'utf8')));
  const batch: unknown = JSON.parse(raw);
  validateRevealCatalogUpdateBatch(batch);
  if (sha256(source) !== batch.target.manifest.source.sha256 || sha256(predecessorSource) !== batch.predecessor.manifest.source.sha256) {
    throw new Error('Frozen catalog source checksum mismatch.');
  }
  requireUnchangedSource(predecessorSource, source);
  const generated = buildRevealAssetCatalog(source, { catalogVersion: batch.target.descriptor.catalogVersion,
    availableEggs: batch.target.manifest.importSettings.availableEggs });
  if (computeRevealCatalogDescriptor(generated).manifestSha256 !== batch.target.descriptor.manifestSha256) {
    throw new Error('Frozen target manifest does not reproduce from its source.');
  }
  return { batch, source, predecessorSource };
}

async function writeBundleDirectory(directory: string, bundle: RevealCatalogUpdateBundle): Promise<void> {
  const staging = `${directory}.staging-${randomUUID()}`;
  await mkdir(staging);
  try {
    await Promise.all([['batch.json', `${JSON.stringify(bundle.batch, null, 2)}\n`], ['source.json', bundle.source],
      ['predecessor-source.json', bundle.predecessorSource]].map(([name, bytes]) => writeFile(join(staging, name), bytes, { flag: 'wx' })));
    await rename(staging, directory);
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export async function prepareRevealCatalogUpdate(input: RevealCatalogUpdateInput & { directory: string }): Promise<RevealCatalogUpdateBundle> {
  const directory = resolve(input.directory);
  await mkdir(dirname(directory), { recursive: true });
  return withMetadataLock(`${directory}.lock`, async () => {
    if (await optionalFile(join(directory, 'batch.json'))) {
      const existing = await readRevealCatalogUpdateBundle(directory);
      if (existing.source !== ordinaryRevealCatalogSource(await readFile(resolve(input.sourcePath), 'utf8')) ||
        input.catalogVersion !== undefined && input.catalogVersion !== existing.batch.target.descriptor.catalogVersion ||
        input.eggIds !== undefined && (existing.batch.version !== 2 || existing.batch.eggCutoff !== input.eggCutoff ||
          JSON.stringify(existing.batch.mappings.map(row => row.eggId)) !== JSON.stringify([...input.eggIds].sort((a, b) => a - b)))) {
        throw new Error('Frozen bundle already exists for different catalog inputs.');
      }
      return existing;
    }
    const catalogs = await inputCatalogs(input);
    if ((input.eggIds === undefined) !== (input.eggCutoff === undefined)) throw new Error('Explicit cutoff requires both egg IDs and cutoff.');
    const batch = buildRevealCatalogUpdateBatch(catalogs.predecessor.manifest, catalogs.target.manifest, randomInt,
      input.eggIds === undefined ? undefined : { eggIds: input.eggIds, eggCutoff: input.eggCutoff! });
    const bundle = { batch, source: catalogs.source, predecessorSource: catalogs.predecessorSource };
    await writeBundleDirectory(directory, bundle);
    return bundle;
  });
}

export async function prepareRevealCatalogUpdateFromBundle(fromDirectory: string, targetDirectory: string): Promise<RevealCatalogUpdateBundle> {
  const directory = resolve(targetDirectory);
  if (resolve(fromDirectory) === directory) throw new Error('A new catalog operation requires a new bundle directory.');
  const original = await readRevealCatalogUpdateBundle(resolve(fromDirectory));
  await mkdir(dirname(directory), { recursive: true });
  return withMetadataLock(`${directory}.lock`, async () => {
    if (await optionalFile(join(directory, 'batch.json'))) {
      const existing = await readRevealCatalogUpdateBundle(directory);
      if (existing.source !== original.source || existing.predecessorSource !== original.predecessorSource ||
        existing.batch.target.descriptor.manifestSha256 !== original.batch.target.descriptor.manifestSha256 ||
        JSON.stringify(existing.batch.mappings) !== JSON.stringify(original.batch.mappings) || existing.batch.nonce === original.batch.nonce) {
        throw new Error('Frozen retry bundle has different catalog inputs or is not a new operation.');
      }
      return existing;
    }
    const body = { ...original.batch, nonce: randomUUID() };
    const batchSha256 = revealCatalogUpdateHash(body);
    const bundle = { ...original, batch: { ...body, batchSha256, batchId: `catalog-${batchSha256.slice(0, 32)}` } };
    validateRevealCatalogUpdateBatch(bundle.batch);
    await writeBundleDirectory(directory, bundle);
    return bundle;
  });
}

export async function promoteRevealCatalogUpdate(directory: string, options: { rootDirectory?: string; write: boolean }): Promise<void> {
  if (!options.write) throw new Error('Catalog promotion requires --write.');
  const root = resolve(options.rootDirectory ?? ROOT);
  const bundle = await readRevealCatalogUpdateBundle(directory);
  await withRevealAssetImportLock(root, async importAssets => {
    await importAssets();
    const descriptor = JSON.parse(await readFile(join(root, 'shared/ethereum/revealCatalog.json'), 'utf8'));
    if (JSON.stringify(descriptor) === JSON.stringify(bundle.batch.target.descriptor)) {
      await importAssets({ check: true });
      return;
    }
    if (JSON.stringify(descriptor) !== JSON.stringify(bundle.batch.predecessor.descriptor)) throw new Error('Catalog promotion predecessor changed.');
    const ancestorPath = join(root, ANCESTORS);
    const ancestors: unknown = JSON.parse(await optionalFile(ancestorPath) ?? '[]');
    if (!Array.isArray(ancestors)) throw new Error('Invalid supported catalog ancestors.');
    for (const catalog of ancestors) validateRevealAssetCatalog(catalog);
    const prior = ancestors.find(catalog => catalog.catalogVersion === bundle.batch.predecessor.manifest.catalogVersion);
    if (prior && computeRevealCatalogDescriptor(prior).manifestSha256 !== bundle.batch.predecessor.descriptor.manifestSha256) {
      throw new Error('Conflicting supported predecessor catalog.');
    }
    if (!prior) {
      const staging = `${ancestorPath}.${randomUUID()}.tmp`;
      await writeFile(staging, `${JSON.stringify([...ancestors, bundle.batch.predecessor.manifest], null, 2)}\n`, { flag: 'wx' });
      await rename(staging, ancestorPath);
    }
    await importAssets({ sourcePath: join(resolve(directory), 'source.json'),
      catalogVersion: bundle.batch.target.descriptor.catalogVersion, availableEggs: bundle.batch.target.manifest.importSettings.availableEggs });
  });
}

export async function preflightRevealCatalogUpdateMedia(batch: RevealCatalogUpdateBatch,
  fetchSource: typeof fetch = fetch): Promise<RevealCatalogMediaPreflight> {
  validateRevealCatalogUpdateBatch(batch);
  const media = batch.mappings.flatMap(row => {
    const value = revealCatalogMedia(batch.target.manifest, row.category, row.assetId);
    return [{ url: value.image, kind: 'image' }, ...(value.animation_url ? [{ url: value.animation_url,
      kind: row.category === '3d' ? 'model' : 'video' }] : [])];
  });
  const evidence: Array<{ url: string; etag: string | null; type: string }> = [];
  for (let index = 0; index < media.length; index += 12) {
    const page = await Promise.all(media.slice(index, index + 12).map(async item => {
      const response = await fetchSource(item.url, { method: 'GET', redirect: 'manual',
        headers: { Range: 'bytes=0-32', Origin: 'https://mons.shop', 'User-Agent': 'Mozilla/5.0 MonsCatalogPreflight/1.0' },
        signal: AbortSignal.timeout(20_000) });
      try {
        const type = (response.headers.get('content-type') ?? '').split(';')[0].toLowerCase();
        const cors = response.headers.get('access-control-allow-origin');
        const validType = item.kind === 'image' ? /^image\/(png|webp)$/.test(type) :
          item.kind === 'model' ? ['model/gltf-binary', 'application/octet-stream'].includes(type) : type === 'video/mp4';
        if (![200, 206].includes(response.status) || !validType || !['*', 'https://mons.shop'].includes(cors ?? '')) {
          throw new Error(`New artwork media preflight failed: ${item.url} (HTTP ${response.status}, ${type}, CORS ${cors}).`);
        }
        return { url: item.url, etag: response.headers.get('etag'), type };
      } finally { await response.body?.cancel(); }
    }));
    evidence.push(...page);
  }
  return { batchId: batch.batchId, batchSha256: batch.batchSha256, checkedAt: new Date().toISOString(), objects: evidence.length,
    reportSha256: sha256(JSON.stringify(evidence)) };
}

export type RunRevealCatalogUpdateOptions = {
  directory: string; deploymentId: string; expectedRevision: number; action: 'apply' | 'inspect' | 'verify' | 'cancel';
  transport?: UpdateTransport; fetchSource?: typeof fetch; sleep?: (ms: number) => Promise<void>;
  onProgress?: (result: EthereumRevealCatalogUpdateResult) => void;
};

export async function runRevealCatalogUpdate(options: RunRevealCatalogUpdateOptions): Promise<EthereumRevealCatalogUpdateResult> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(options.deploymentId) || !Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 1) {
    throw new Error('Catalog update requires a deployment ID and positive expected original revision.');
  }
  if (options.action === 'apply' || options.action === 'cancel') {
    await readRevealCatalogUpdateBundle(resolve(options.directory));
    return withMetadataLock(join(resolve(options.directory), `${options.deploymentId}.operation.lock`), () => executeRevealCatalogUpdate(options));
  }
  return executeRevealCatalogUpdate(options);
}

export async function inspectEligibleCutoffEggs(options: {
  deploymentId: string; expectedRevision: number; eggCutoff: number; transport?: UpdateTransport;
}): Promise<{ deploymentId: string; catalogRevision: number; eggCutoff: number; eggIds: number[] }> {
  const execute = async (transport: UpdateTransport) => {
    const eggIds: number[] = [];
    let afterEggId = options.eggCutoff;
    let catalogRevision: number | undefined;
    for (;;) {
      const result = await transport({ deploymentId: options.deploymentId, expectedRevision: options.expectedRevision,
        batchId: `catalog-${'0'.repeat(32)}`, action: 'inspect', eggCutoff: options.eggCutoff, afterEggId });
      if (result.deploymentId !== options.deploymentId || catalogRevision !== undefined && result.catalogRevision !== catalogRevision ||
        !Array.isArray(result.eligibleEggIds) || result.eligibleEggIds.length > 256 || result.eligibleEggIds.some((id, index, ids) =>
          !Number.isSafeInteger(id) || id <= (index ? ids[index - 1] : afterEggId) || id > 111_111)) {
        throw new Error('Invalid or changed eligible cutoff inventory.');
      }
      catalogRevision = result.catalogRevision;
      eggIds.push(...result.eligibleEggIds);
      if (result.nextEligibleEggId === null) return { deploymentId: options.deploymentId, catalogRevision, eggCutoff: options.eggCutoff, eggIds };
      if (result.nextEligibleEggId !== result.eligibleEggIds.at(-1) || !Number.isSafeInteger(result.nextEligibleEggId) ||
        result.nextEligibleEggId! <= afterEggId || eggIds.length > 111_111) throw new Error('Cutoff inventory cursor did not advance.');
      afterEggId = result.nextEligibleEggId!;
    }
  };
  if (options.transport) return execute(options.transport);
  return withEthereumRevealMaintenance(async transport => {
    if (!transport.catalogUpdate) throw new Error('Catalog update maintenance is not available.');
    return execute(request => transport.catalogUpdate!(request));
  });
}

async function executeRevealCatalogUpdate(options: RunRevealCatalogUpdateOptions): Promise<EthereumRevealCatalogUpdateResult> {
  const directory = resolve(options.directory);
  const { batch } = await readRevealCatalogUpdateBundle(directory);
  const request = { deploymentId: options.deploymentId, expectedRevision: options.expectedRevision, batchId: batch.batchId };
  const journalPath = join(directory, `${options.deploymentId}.journal.json`);
  const journal = await optionalFile(journalPath);
  if (journal) {
    const previous = JSON.parse(journal);
    if (previous.batchSha256 !== batch.batchSha256 || previous.expectedRevision !== options.expectedRevision ||
      previous.deploymentId !== options.deploymentId) throw new Error('Catalog operation journal belongs to a different batch or original revision.');
  }
  const execute = async (transport: UpdateTransport) => {
    if (options.action === 'verify') {
      let cursor = batch.version === 2 ? batch.eggCutoff : batch.target.manifest.categories.eggs.count;
      while (true) {
        const result = await transport({ ...request, action: 'verify', verificationAfterEggId: cursor });
        if (result.deploymentId !== request.deploymentId || result.batchId !== batch.batchId) throw new Error('Catalog verification returned a different operation identity.');
        options.onProgress?.(result);
        if (result.nextVerificationEggId === null) return result;
        if (!Number.isSafeInteger(result.nextVerificationEggId) || result.nextVerificationEggId! <= cursor ||
          result.nextVerificationEggId! > (batch.version === 2 ? batch.predecessor.manifest.importSettings.availableEggs
            : batch.predecessor.manifest.categories.eggs.count)) throw new Error('Catalog verification cursor did not advance.');
        cursor = result.nextVerificationEggId!;
      }
    }
    if (options.action !== 'apply') return transport({ ...request, action: options.action });
    const preflight = await preflightRevealCatalogUpdateMedia(batch, options.fetchSource);
    await writeJson(join(directory, `${options.deploymentId}.media-preflight.json`), preflight);
    await writeJson(journalPath, { ...request, batchSha256: batch.batchSha256, result: null });
    let result = await transport({ ...request, action: 'begin', batch });
    while (true) {
      if (result.deploymentId !== request.deploymentId || result.batchId !== batch.batchId) throw new Error('Catalog maintenance returned a different operation identity.');
      await writeJson(journalPath, { ...request, batchSha256: batch.batchSha256, result });
      options.onProgress?.(result);
      if (result.complete || result.phase === 'cancelled') return result;
      const delay = Math.min(5_000, Math.max(0, result.retryAfterMs ?? 0));
      if (delay) await (options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(delay);
      result = await transport({ ...request, action: 'advance' });
    }
  };
  if (options.transport) return execute(options.transport);
  return withEthereumRevealMaintenance(async transport => {
    if (!transport.catalogUpdate) throw new Error('Catalog update maintenance is not available.');
    return execute(request => transport.catalogUpdate!(request));
  });
}
