import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import type { EthereumRevealedArtwork } from '../../../../shared/ethereum/reveal.js';
import { appendTwinTrait, type TwinRole } from '../../../../shared/ethereum/twinMetadataTrait.js';
import type { RevealCanonicalMetadata } from './ethereumRevealCatalogTypes.js';
import type { RevealSql } from './ethereumRevealStore.js';

type TwinAnnotation = {
  token_id: string; painting_id: number; role: TwinRole; predecessor_sha256: string; target_sha256: string; metadata_revision: number;
};

export function hasTwinAnnotations(sql: RevealSql): boolean {
  return sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='reveal_twin_annotations'").toArray().length > 0;
}

export function excludeTwinAnnotations(sql: RevealSql, tokenColumn: string): string {
  return hasTwinAnnotations(sql) ? `AND NOT EXISTS(SELECT 1 FROM reveal_twin_annotations twin WHERE twin.token_id=${tokenColumn})` : '';
}

function readAnnotations(sql: RevealSql, ids: Iterable<string>): TwinAnnotation[] {
  const tokenIds = [...ids];
  if (!tokenIds.length) return [];
  return sql.exec<TwinAnnotation>(`SELECT t.token_id,t.painting_id,t.role,t.predecessor_sha256,t.target_sha256,t.metadata_revision
    FROM json_each(?) i JOIN reveal_twin_annotations t ON t.token_id=i.value`, JSON.stringify(tokenIds)).toArray();
}

function annotatedArtwork(artwork: EthereumRevealedArtwork, twin: TwinAnnotation): EthereumRevealedArtwork {
  if (artwork.category !== 'painting' || artwork.image !== `https://cdn.lil.org/nft/111k/paintings/${twin.painting_id}.png` ||
    (twin.role !== 'good twin' && twin.role !== 'evil twin') || (artwork.metadataRevision ?? 0) >= twin.metadata_revision ||
    artwork.attributes?.some(trait => trait.trait_type === 'good twin' || trait.trait_type === 'evil twin')) {
    throw new Error('Twin annotation artwork identity changed.');
  }
  return { ...artwork, metadataRevision: twin.metadata_revision,
    attributes: [...artwork.attributes ?? [], { trait_type: twin.role, value: true }] };
}

export function applyTwinArtworks(sql: RevealSql, artworks: Map<string, EthereumRevealedArtwork>): void {
  for (const twin of readAnnotations(sql, artworks.keys())) artworks.set(twin.token_id, annotatedArtwork(artworks.get(twin.token_id)!, twin));
}

export function applyTwinMetadata(sql: RevealSql, values: Map<string, RevealCanonicalMetadata>): void {
  for (const twin of readAnnotations(sql, values.keys())) {
    const previous = values.get(twin.token_id)!;
    if (twin.painting_id !== previous.assetId || twin.predecessor_sha256 !== previous.targetSha256 ||
      twin.metadata_revision !== previous.metadataRevision + 1) throw new Error('Twin annotation metadata predecessor changed.');
    const metadataJson = appendTwinTrait(previous.metadataJson, twin.role);
    if (bytesToHex(sha256(metadataJson)) !== twin.target_sha256) throw new Error('Twin annotation metadata checksum changed.');
    values.set(twin.token_id, { ...previous, artwork: annotatedArtwork(previous.artwork, twin), metadataJson,
      metadataRevision: twin.metadata_revision, targetSha256: twin.target_sha256, expectedJsons: [previous.metadataJson], allowMissing: false, migration: true });
  }
}
