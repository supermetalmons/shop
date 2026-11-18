import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { MIXED_MAINNET_BATCH_ID, MIXED_ALLOCATION_DEFINITION_SHA256, MIXED_OWNER_PREDECESSOR_SHA256 } from '../../shared/ethereum/mixedAllocation20261117.ts';
import { mixedAllocationCounts, mixedAllocationHash, mixedReleaseBlockHash, validateMixedAllocationDefinition, type MixedAllocationDefinition } from '../../shared/ethereum/revealMixedAllocation.ts';
import { readOptionalFile } from '../shared/recoverableFileSet.ts';
import { withRevealAssetImportLock } from './assetImport.ts';
import { validateRevealCollectionBlocks } from '../../shared/ethereum/revealCollectionBlocks.ts';
import { sha256 } from './catalog.ts';
import { readArtworkSource } from './ownerHatchingCatalog.ts';
import { privateHatchPath } from './privateHatchPath.ts';
import { writeDurableFile } from '../shared/durableFile.ts';
import type { MixedReleasePolicy, PreparedMixedRelease } from './mixedAllocation.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const assets = join(root, 'scripts/ethereum-metadata/reveal-assets/111k_devnet');
const ownerPath = join(root, 'shared/ethereum/ownerHatchingCatalog.json');
const registryPath = join(root, 'shared/ethereum/mixedAllocationReleases.json');
const pretty = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));

function summary(definition: MixedAllocationDefinition) {
  return {
    catalog: definition.target, sourceSha256: definition.sourceSha256, definitionSha256: mixedAllocationHash(definition),
    ...mixedAllocationCounts(definition),
  };
}

function files(release: PreparedMixedRelease) {
  return {
    'original-input.json': release.originalSource, 'source.json': release.normalizedSource, 'definition.json': pretty(release.definition),
    'manifest.json': pretty(release.targetCatalog), 'predecessor.json': pretty(release.predecessor),
    'owner-supplement.json': pretty(release.ownerSupplement), 'collection-blocks.json': pretty(release.collectionBlocks),
  };
}

async function freeze(directory: string, release: PreparedMixedRelease) {
  const entries = Object.entries(files(release));
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(directory + '.tmp-');
  try {
    for (const [name, source] of entries) writeDurableFile({
      filePath: join(temporary, name), source, mode: 'create', verificationMessage: 'Mixed release freeze failed.',
    });
    await rename(temporary, directory);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function legacyPromotion(source: string) {
  return withRevealAssetImportLock(root, async importAssets => {
    const original = await readFile(source, 'utf8');
    const { buildMixedAllocation } = await import('./mixedAllocation.ts');
    const release = await buildMixedAllocation(original, 'e8ae1557e2aa5b4c98b525c1b8211e6aa4122468b421dbcaab078f9f33f9bc60');
    const { definition } = release;
    if (mixedAllocationHash(definition) !== MIXED_ALLOCATION_DEFINITION_SHA256) throw new Error('Mixed release differs from reviewed definition.');
    const ownerHash = mixedAllocationHash(await json(ownerPath));
    if (ownerHash !== MIXED_OWNER_PREDECESSOR_SHA256 && ownerHash !== definition.ownerSupplementSha256) throw new Error('Owner supplement predecessor changed.');
    const current = await json(join(root, 'shared/ethereum/revealCatalog.json'));
    if (![definition.predecessor, definition.target].some(d => d.catalogVersion === current.catalogVersion && d.manifestSha256 === current.manifestSha256)) throw new Error('Current catalog is outside the frozen mixed release.');
    const directory = join(root, 'releases/111k-catalog-v10');
    const frozen = files({ ...release, originalSource: original });
    for (const [name, bytes] of Object.entries(frozen)) {
      if (name !== 'predecessor.json' && await readFile(join(directory, name), 'utf8') !== bytes) throw new Error('Frozen mixed release changed: ' + name);
    }
    await importAssets({
      sourcePath: join(directory, 'source.json'), catalogVersion: definition.target.catalogVersion,
      availableEggs: release.predecessor.importSettings.availableEggs,
      mixedSupport: {
        descriptor: definition.target, collectionBlocks: release.collectionBlocks, registry: await readFile(registryPath, 'utf8'),
        ...(ownerHash !== definition.ownerSupplementSha256 ? { ownerSupplement: pretty(release.ownerSupplement) } : {}),
      },
    });
    return summary(definition);
  });
}

export async function mixedReleaseFileCommand(command: string, args: string[]) {
  const { values } = parseArgs({ args, options: {
    source: { type: 'string' }, policy: { type: 'string' }, bundle: { type: 'string' },
    'predecessor-source': { type: 'string' }, 'definition-sha256': { type: 'string' }, 'template-file': { type: 'string' }, write: { type: 'boolean' },
  } });
  if (command === 'promote') {
    if (!values.bundle || !values.write || !values['definition-sha256']) throw new Error('Promotion requires --bundle, --definition-sha256 and --write.');
    const directory = privateHatchPath(values.bundle);
    return withRevealAssetImportLock(root, async importAssets => {
      const { readPreparedMixedRelease, requireMixedHeadExtension } = await import('./mixedAllocation.ts');
      const release = await readPreparedMixedRelease(directory);
      const { definition } = release;
      if (definition.version !== 2 || definition.batchId === MIXED_MAINNET_BATCH_ID ||
        mixedAllocationHash(definition) !== values['definition-sha256']) throw new Error('Mixed release differs from reviewed definition.');
      const registry: unknown = await json(registryPath);
      if (!Array.isArray(registry)) throw new Error('Invalid installed mixed release registry.');
      let installed = false;
      for (const prior of registry) {
        validateMixedAllocationDefinition(prior);
        if (prior.version !== 2) throw new Error('Invalid installed mixed release registry.');
        if (prior.batchId === definition.batchId) {
          if (installed || mixedAllocationHash(prior) !== values['definition-sha256']) throw new Error('Mixed release name already belongs to a different definition.');
          installed = true;
        }
      }
      if (mixedAllocationHash(await json(ownerPath)) !== definition.ownerSupplementSha256) throw new Error('Owner supplement predecessor changed.');
      const current = await json(join(root, 'shared/ethereum/revealCatalog.json'));
      const { getRevealCatalog } = await import('../../shared/ethereum/revealCatalogRegistry.ts');
      if (!getRevealCatalog(definition.predecessor.catalogVersion, definition.predecessor.manifestSha256)) throw new Error('Missing mixed predecessor catalog.');
      const retained = getRevealCatalog(definition.target.catalogVersion, definition.target.manifestSha256);
      if (!retained) {
        const head = getRevealCatalog(current.catalogVersion, current.manifestSha256);
        if (!head) throw new Error('Current installed catalog is unavailable.');
        requireMixedHeadExtension(head, await readFile(join(assets, 'source.json'), 'utf8'), release.targetCatalog, readArtworkSource(release.normalizedSource));
      }
      if (retained) {
        const blocks: unknown = await json(join(assets, 'collection-blocks.json'));
        validateRevealCollectionBlocks(blocks);
        if (mixedReleaseBlockHash(blocks, definition.target) !== definition.collectionBlocksSha256 ||
          sha256(await readFile(join(assets, 'collection-blocks.source.json'))) !== blocks.source.sha256) {
          throw new Error('Historical release collection blocks differ from installed support.');
        }
        if (installed) {
          if (current.catalogVersion === definition.target.catalogVersion) await importAssets({ check: true });
          if (values['template-file'] === undefined) return { ...summary(definition), mediaPreflight: null };
        }
      }
      const { preflightMixedMedia } = await import('./mixedMedia.ts');
      const template = values['template-file'] === undefined ? undefined : await readFile(values['template-file'], 'utf8');
      const mediaPreflight = await preflightMixedMedia(definition, release.targetCatalog, fetch, template, release.collectionBlocks, release.predecessor);
      if (installed && retained) return { ...summary(definition), mediaPreflight };
      if (!installed) registry.push(definition);
      if (retained && current.catalogVersion !== definition.target.catalogVersion) {
        writeDurableFile({ filePath: registryPath, source: pretty(registry), mode: 'replace', verificationMessage: 'Failed to install reviewed mixed release.' });
      } else {
        await importAssets({
          sourcePath: join(directory, 'source.json'), catalogVersion: definition.target.catalogVersion,
          availableEggs: release.predecessor.importSettings.availableEggs,
          mixedSupport: { descriptor: definition.target, collectionBlocks: release.collectionBlocks, registry: pretty(registry) },
        });
      }
      return { ...summary(definition), mediaPreflight };
    });
  }
  if (!['inspect', 'prepare'].includes(command) || !values.policy || !values.source || command === 'prepare' && !values.bundle || values['template-file'] !== undefined || values.write) {
    throw new Error('Mixed inspection and preparation require --policy and --source. Preparation also requires --bundle.');
  }
  const policy = await json(values.policy) as MixedReleasePolicy;
  const originalSource = await readFile(values.source, 'utf8');
  const directory = command === 'prepare' ? privateHatchPath(values.bundle!) : undefined;
  const { prepareMixedRelease, readPreparedMixedRelease, mixedDefinitionForPolicy } = await import('./mixedAllocation.ts');
  if (directory && await readOptionalFile(join(directory, 'definition.json'))) {
    const frozen = await readPreparedMixedRelease(directory);
    if (values['predecessor-source'] && sha256(await readFile(values['predecessor-source'])) !== frozen.predecessor.source.sha256) {
      throw new Error('Mixed predecessor source differs from the frozen catalog.');
    }
    const requested = mixedDefinitionForPolicy(policy, originalSource, frozen);
    if (!isDeepStrictEqual(requested, frozen.definition)) throw new Error('Frozen mixed release differs from requested source or policy.');
    return summary(frozen.definition);
  }
  const { getRevealCatalog, getSupportedRevealCatalogVersions } = await import('../../shared/ethereum/revealCatalogRegistry.ts');
  const predecessor = getRevealCatalog(policy.predecessor.catalogVersion, policy.predecessor.manifestSha256);
  if (!predecessor) throw new Error('Mixed predecessor catalog is unavailable.');
  const current = await json(join(root, 'shared/ethereum/revealCatalog.json'));
  const installedSource = await readFile(join(assets, 'source.json'), 'utf8');
  const priorPath = values['predecessor-source'] ?? (current.manifestSha256 === policy.predecessor.manifestSha256
    ? undefined : join(root, 'releases', policy.predecessor.catalogVersion.replace('111k-', '111k-catalog-'), 'source.json'));
  const release = prepareMixedRelease({
    originalSource, predecessorSource: priorPath ? await readFile(priorPath, 'utf8') : installedSource, installedSource,
    policy, predecessor, ownerSupplement: await json(ownerPath), collectionBlocks: await json(join(assets, 'collection-blocks.json')),
    installedCatalogs: getSupportedRevealCatalogVersions().map(version => getRevealCatalog(version)!),
  });
  if (directory) await freeze(directory, release);
  return summary(release.definition);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: { source: { type: 'string' }, write: { type: 'boolean' } } });
  if (!values.source || !values.write) throw new Error('Historical mixed promotion requires --source and --write.');
  console.log(JSON.stringify(await legacyPromotion(resolve(values.source))));
}
