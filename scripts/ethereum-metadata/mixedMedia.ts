import { validateStagedRevealMetadata, fetchRevealAttributePayload } from '../../cloud/workers/api/src/ethereumRevealAttributes.ts';
import { buildNewRevealedArtwork, REVEAL_ARTWORK_COUNT } from '../../cloud/workers/api/src/ethereumRevealCatalog.ts';
import { revealCollectionBlocks } from '../../cloud/workers/api/src/ethereumRevealCollectionBlocks.ts';
import { selectRevealCollectionBlocks, type RevealCollectionBlocks } from '../../shared/ethereum/revealCollectionBlocks.ts';
import { checkRevealMedia } from '../../shared/ethereum/revealMediaPreflight.ts';
import artworkTemplate from './templates/artwork.json';
import { getOwnerHatchingGrail } from '../../shared/ethereum/ownerHatchingCatalog.ts';
import { revealCatalogMedia, type RevealAssetCatalog } from '../../shared/ethereum/revealAssetCatalog.ts';
import { getRevealCatalog } from '../../shared/ethereum/revealCatalogRegistry.ts';
import { mixedAllocationHash, type MixedAllocationDefinition } from '../../shared/ethereum/revealMixedAllocation.ts';

const CONTENT_TYPES: Record<string, readonly string[]> = {
  png: ['image/png'], webp: ['image/webp'], gif: ['image/gif'], mp4: ['video/mp4'], glb: ['model/gltf-binary', 'application/octet-stream'],
};

function paintingAlternateIds(catalog: RevealAssetCatalog): readonly number[] {
  const paintings = catalog.categories.paintings;
  if (!paintings.variants?.alt) return [];
  return paintings.variants.alt.assetIds ?? Array.from({ length: paintings.count }, (_, index) => index + 1);
}

export async function preflightMixedMedia(definition: MixedAllocationDefinition, catalog: RevealAssetCatalog,
  fetchSource: typeof fetch = fetch, templateJson = JSON.stringify(artworkTemplate), preparedBlocks?: RevealCollectionBlocks,
  predecessor = getRevealCatalog(definition.predecessor.catalogVersion, definition.predecessor.manifestSha256)) {
  if (!predecessor) throw new Error('Mixed release predecessor catalog is unavailable.');
  const previousAlternates = new Set(paintingAlternateIds(predecessor));
  const blocks = preparedBlocks ? selectRevealCollectionBlocks(preparedBlocks, definition.target) : revealCollectionBlocks(definition.target);
  if (definition.groups.length && !blocks) throw new Error('Mixed release collection blocks are unavailable.');
  let mediaObjects = 0;
  let traitSources = 0;
  async function checkMedia(url: string) {
    try {
      await checkRevealMedia(url, CONTENT_TYPES[url.split('.').at(-1)!] ?? [], fetchSource);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : 'Media check failed.'} ${url}`, { cause: error });
    }
    mediaObjects++;
  }
  function* checks() {
    for (const group of definition.groups) {
      for (let id = group.firstId; id <= group.lastId; id++) {
        const supplemental = definition.version === 1 && group.category === 'animated';
        const media = supplemental ? getOwnerHatchingGrail(group.category, id) : revealCatalogMedia(catalog, group.category, id);
        if (!media) throw new Error('Missing mixed release media.');
        yield () => checkMedia(media.image);
        if (media.animation_url) yield () => checkMedia(media.animation_url!);
        yield async () => {
          const traits = await fetchRevealAttributePayload(group.category, id, AbortSignal.timeout(15_000), fetchSource, catalog, supplemental);
          const base = buildNewRevealedArtwork({
            templateJson, tokenId: String(REVEAL_ARTWORK_COUNT), crateTokenId: '116666', category: group.category, assetId: id,
            catalog, ownerHatching: supplemental,
            observation: { transactionHash: '0x' + '0'.repeat(64), blockHash: '0x' + '0'.repeat(64), blockNumber: 0 },
          }, blocks ?? undefined);
          if (base.artwork.attributes?.[0]?.value !== group.collectionBlock) throw new Error('Mixed release collection-block-mismatch.');
          validateStagedRevealMetadata(base, traits);
          traitSources++;
        };
      }
    }
    const alternate = catalog.categories.paintings.variants?.alt;
    if (!alternate) return;
    for (const id of paintingAlternateIds(catalog)) {
      if (previousAlternates.has(id)) continue;
      const url = (catalog.categories.paintings.baseUrl ?? catalog.baseUrl) + alternate.pathTemplate.replace('{id}', String(id));
      yield () => checkMedia(url);
    }
  }
  const iterator = checks();
  for (;;) {
    const page = [];
    while (page.length < 8) {
      const next = iterator.next();
      if (next.done) break;
      page.push(next.value);
    }
    if (!page.length) return { mediaObjects, traitSources, checkedAt: new Date().toISOString(), definitionSha256: mixedAllocationHash(definition) };
    await Promise.all(page.map(check => check()));
  }
}
