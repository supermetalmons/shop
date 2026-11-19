import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import type { EthereumArtworkAttribute, EthereumArtworkCategory, EthereumRevealedArtwork } from '../../../../shared/ethereum/reveal.js';
import { parseMetadataJson } from './ethereumMetadataJson.js';
import { revealMetadataFits } from './ethereumRevealAttributes.js';
import type { RevealCanonicalMetadata } from './ethereumRevealCatalogTypes.js';
import type { RevealSql } from './ethereumRevealStore.js';

export type RevealArtistAnnotation = {
  token_id: string;
  category: Exclude<EthereumArtworkCategory, 'egg'>;
  asset_id: number;
  assignment_revision: number;
  collection_block: string;
  artists_json: string;
  operation_id: string;
  predecessor_revision: number;
  predecessor_sha256: string;
  predecessor_etag: string;
  target_sha256: string;
  published: number;
};

const revisionOffset = 2;
const hash = (body: string) => bytesToHex(sha256(body));

export function initializeRevealArtistAnnotations(sql: RevealSql): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS reveal_artist_annotations (
    token_id TEXT PRIMARY KEY REFERENCES assignments(token_id),
    category TEXT NOT NULL CHECK (category IN ('painting','video','3d','animated')),
    asset_id INTEGER NOT NULL,
    assignment_revision INTEGER NOT NULL,
    collection_block TEXT NOT NULL,
    artists_json TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    predecessor_revision INTEGER NOT NULL,
    predecessor_sha256 TEXT NOT NULL,
    predecessor_etag TEXT NOT NULL,
    target_sha256 TEXT NOT NULL,
    published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0,1))
  )`);
  sql.exec('CREATE INDEX IF NOT EXISTS reveal_artist_unpublished ON reveal_artist_annotations(operation_id,token_id) WHERE published=0');
  sql.exec(`CREATE TRIGGER IF NOT EXISTS reveal_artist_annotations_identity BEFORE UPDATE OF token_id,category,asset_id,assignment_revision,
    collection_block,artists_json,operation_id,predecessor_revision,predecessor_sha256,predecessor_etag,target_sha256 ON reveal_artist_annotations
    BEGIN SELECT RAISE(ABORT,'Artist annotation identity is immutable'); END`);
  sql.exec(`CREATE TRIGGER IF NOT EXISTS reveal_artist_annotations_ack_once BEFORE UPDATE OF published ON reveal_artist_annotations
    WHEN OLD.published!=0 OR NEW.published!=1 BEGIN SELECT RAISE(ABORT,'Invalid artist publication acknowledgement'); END`);
}

export function hasRevealArtistAnnotations(sql: RevealSql): boolean {
  return sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='reveal_artist_annotations'").toArray().length > 0;
}

export function readRevealArtistAnnotation(sql: RevealSql, tokenId: string): RevealArtistAnnotation | undefined {
  return hasRevealArtistAnnotations(sql)
    ? sql.exec<RevealArtistAnnotation>('SELECT * FROM reveal_artist_annotations WHERE token_id=?', tokenId).toArray()[0]
    : undefined;
}

function annotations(sql: RevealSql, ids: Iterable<string>): RevealArtistAnnotation[] {
  const tokenIds = [...ids];
  return tokenIds.length ? sql.exec<RevealArtistAnnotation>(`SELECT a.* FROM json_each(?) ids
    JOIN reveal_artist_annotations a ON a.token_id=ids.value`, JSON.stringify(tokenIds)).toArray() : [];
}

function distinctArtists(artists: unknown): artists is string[] {
  return Array.isArray(artists) && artists.length > 0 && new Set(artists).size === artists.length &&
    artists.every(name => typeof name === 'string' && name.length > 0 && name.trim() === name);
}

function artistTraits(artists: readonly string[]): EthereumArtworkAttribute[] {
  return artists.map(value => ({ trait_type: 'artist', value }));
}

function creditedMetadata(body: string, collectionBlock: string, artists: readonly string[]): {
  metadataJson: string; attributes: EthereumArtworkAttribute[];
} {
  const metadata = parseMetadataJson(body) as { attributes?: EthereumArtworkAttribute[] } | null;
  if (!metadata || !Array.isArray(metadata.attributes) || metadata.attributes[0]?.trait_type !== 'collection block' ||
    metadata.attributes[0].value !== collectionBlock || metadata.attributes.slice(1).some(attr => attr?.trait_type === 'collection block')) {
    throw new Error('Artist annotation collection block differs from canonical metadata.');
  }
  const [block, ...otherTraits] = metadata.attributes;
  const attributes = [block, ...artistTraits(artists), ...otherTraits.filter(trait => trait?.trait_type !== 'artist')];
  const metadataJson = JSON.stringify(attributes) === JSON.stringify(metadata.attributes) ? body : `${JSON.stringify({ ...metadata, attributes })}\n`;
  if (!revealMetadataFits(metadataJson)) throw new Error('Artist metadata exceeds the artwork metadata size limit.');
  return { metadataJson, attributes };
}

function storedArtists(annotation: RevealArtistAnnotation): string[] {
  const values: unknown = JSON.parse(annotation.artists_json);
  if (!distinctArtists(values)) throw new Error('Artist annotation has invalid credits.');
  return values;
}

export function stageRevealArtistAnnotation(sql: RevealSql, current: RevealCanonicalMetadata, collectionBlock: string,
  artists: readonly string[], operationId: string, predecessorEtag: string): RevealArtistAnnotation | undefined {
  if (current.category === 'egg' || !distinctArtists(artists) || hash(current.metadataJson) !== current.targetSha256) {
    throw new Error('Artist annotation requires a published artwork predecessor and valid credits.');
  }
  const target = creditedMetadata(current.metadataJson, collectionBlock, artists).metadataJson;
  if (target === current.metadataJson) return;
  return sql.exec<RevealArtistAnnotation>(`INSERT INTO reveal_artist_annotations(token_id,category,asset_id,assignment_revision,
    collection_block,artists_json,operation_id,predecessor_revision,predecessor_sha256,predecessor_etag,target_sha256)
    VALUES(?,?,?,?,?,?,?,?,?,?,?) RETURNING *`, current.tokenId, current.category, current.assetId, current.assignmentRevision,
    collectionBlock, JSON.stringify(artists), operationId, current.metadataRevision, current.targetSha256, predecessorEtag, hash(target)).toArray()[0];
}

export function acknowledgeRevealArtistAnnotation(sql: RevealSql, tokenId: string, operationId: string): boolean {
  return sql.exec(`UPDATE reveal_artist_annotations SET published=1 WHERE token_id=? AND operation_id=? AND published=0 RETURNING token_id`,
    tokenId, operationId).toArray().length === 1;
}

export function validateRevealArtistEnrichment(sql: RevealSql, tokenId: string, metadataJson: string): boolean {
  const annotation = readRevealArtistAnnotation(sql, tokenId);
  if (annotation) creditedMetadata(metadataJson, annotation.collection_block, storedArtists(annotation));
  return annotation !== undefined;
}

function applyAnnotation(current: RevealCanonicalMetadata, annotation: RevealArtistAnnotation): RevealCanonicalMetadata {
  if (current.category !== annotation.category || current.assetId !== annotation.asset_id || current.assignmentRevision !== annotation.assignment_revision ||
    current.metadataRevision < annotation.predecessor_revision || current.metadataRevision > annotation.predecessor_revision + 1) {
    throw new Error('Artist amendment artwork identity or predecessor revision changed.');
  }
  const artists = storedArtists(annotation);
  const { metadataJson, attributes } = creditedMetadata(current.metadataJson, annotation.collection_block, artists);
  const targetSha256 = hash(metadataJson);
  const expectedJsons = [current.metadataJson];
  if (current.metadataRevision === annotation.predecessor_revision) {
    if (current.targetSha256 !== annotation.predecessor_sha256 || targetSha256 !== annotation.target_sha256) {
      throw new Error('Artist amendment metadata checksum changed.');
    }
  } else {
    const predecessor = current.expectedJsons.find(body => hash(body) === annotation.predecessor_sha256);
    if (!predecessor) throw new Error('Artist amendment enrichment predecessor changed.');
    const credited = creditedMetadata(predecessor, annotation.collection_block, artists).metadataJson;
    if (hash(credited) !== annotation.target_sha256) throw new Error('Artist amendment enrichment checksum changed.');
    expectedJsons.push(predecessor, credited);
  }
  const metadataRevision = current.metadataRevision + revisionOffset;
  return { ...current, targetSha256, metadataJson, metadataRevision, expectedJsons, allowMissing: false,
    artwork: { ...current.artwork, attributes, metadataRevision } };
}

export function applyRevealArtistMetadata(sql: RevealSql, values: Map<string, RevealCanonicalMetadata>): void {
  for (const annotation of annotations(sql, values.keys())) {
    values.set(annotation.token_id, applyAnnotation(values.get(annotation.token_id)!, annotation));
  }
}

export function revealArtistPublication(sql: RevealSql, current: RevealCanonicalMetadata): RevealCanonicalMetadata {
  const annotation = readRevealArtistAnnotation(sql, current.tokenId);
  return annotation ? applyAnnotation(current, annotation) : current;
}

export function applyRevealArtistArtworks(sql: RevealSql, artworks: Map<string, EthereumRevealedArtwork>): void {
  for (const annotation of annotations(sql, artworks.keys())) {
    const artwork = artworks.get(annotation.token_id)!;
    if (artwork.category !== annotation.category) throw new Error('Artist amendment artwork category changed.');
    const existing = artwork.attributes ?? [];
    const collectionBlock = existing.find(attr => attr.trait_type === 'collection block') ??
      { trait_type: 'collection block', value: annotation.collection_block };
    if (collectionBlock.value !== annotation.collection_block) throw new Error('Artist amendment artwork collection block changed.');
    artworks.set(annotation.token_id, { ...artwork, attributes: [collectionBlock, ...artistTraits(storedArtists(annotation)),
      ...existing.filter(attr => attr.trait_type !== 'artist' && attr.trait_type !== 'collection block')],
      metadataRevision: Math.max(artwork.metadataRevision ?? 0, annotation.predecessor_revision) + revisionOffset });
  }
}
