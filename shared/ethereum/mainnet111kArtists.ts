import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import source from './mainnet111kArtists.json';
import { getOwnerHatchingGrails } from './ownerHatchingCatalog.ts';
import type { EthereumArtworkAttribute } from './reveal.ts';
import type { RevealCollectionBlockCategory, RevealCollectionBlockLookup } from './revealCollectionBlocks.ts';

const credits = new Map<string, readonly string[]>();
for (const [block, artists] of Object.entries(source)) {
  if (!block.trim() || block.trim() !== block || !Array.isArray(artists) || !artists.length ||
    artists.some(artist => typeof artist !== 'string' || !artist.trim() || artist.trim() !== artist) ||
    new Set(artists).size !== artists.length) throw new Error(`Invalid 111k mainnet artist credits for ${block}.`);
  credits.set(block, Object.freeze(artists));
}

export const MAINNET_111K_ARTISTS_SHA256 = bytesToHex(sha256(JSON.stringify(source)));

export function isMainnet111kArtistDeployment(deployment: { chainId: number; dropId: string }): boolean {
  return deployment.chainId === 1 && deployment.dropId === '111k';
}

export function getMainnet111kArtists(collectionBlock: string): readonly string[] {
  const artists = credits.get(collectionBlock);
  if (!artists) throw new Error(`Missing 111k mainnet artist credits for ${collectionBlock}.`);
  return artists;
}

export function requireMainnet111kArtistCoverage(blocks: RevealCollectionBlockLookup | null): void {
  if (!blocks) throw new Error('Mainnet 111k artist coverage requires collection blocks.');
  for (const category of Object.keys(blocks.counts) as RevealCollectionBlockCategory[]) {
    let start = 1;
    for (const [end, block] of blocks.ranges[category]) {
      if (start > blocks.counts[category]) break;
      getMainnet111kArtists(block);
      start = end + 1;
    }
  }
  for (const grail of getOwnerHatchingGrails()) getMainnet111kArtists(grail.collectionBlock);
}

export function withMainnet111kArtistTraits(attributes: readonly EthereumArtworkAttribute[], collectionBlock: string,
  artists: readonly string[]): EthereumArtworkAttribute[] {
  return [{ trait_type: 'collection block', value: collectionBlock },
    ...artists.map(value => ({ trait_type: 'artist', value })),
    ...attributes.filter(attribute => attribute.trait_type !== 'collection block' && attribute.trait_type !== 'artist')];
}
