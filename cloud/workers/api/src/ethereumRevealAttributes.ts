import { bytesToHex } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import { REVEAL_ENRICHMENT_VERSION, type EthereumArtworkCategory } from '../../../../shared/ethereum/reveal.js';
import { REVEAL_ASSET_FAMILIES } from '../../../../shared/ethereum/revealAssetCatalog.js';
import { cancelResponseBody, readBoundedResponseJson, type ResponseBodyFailure } from './boundedResponse.js';
import { metadataNumber, parseMetadataJson } from './ethereumMetadataJson.js';
import { REVEAL_CATEGORY_COUNTS } from './ethereumRevealCatalog.js';
import type { RevealAssetCatalog } from '../../../../shared/ethereum/revealAssetCatalog.js';
import { getOwnerHatchingGrail } from '../../../../shared/ethereum/ownerHatchingCatalog.js';

export const MAX_REVEAL_METADATA_BYTES = 512 * 1024;

export class InvalidRevealAttributes extends Error {}

class EnrichedRevealMetadataTooLarge extends InvalidRevealAttributes {}

export class RevealAttributeSourceUnavailable extends Error {
  constructor(readonly reason: ResponseBodyFailure | `http-${number}` | 'request-failed' | 'invalid-source-attributes' | 'collection-block-mismatch' | 'catalog-unavailable') {
    super(`Trait source unavailable (${reason}).`);
  }
}

export function attributePublisherName(scope: { chainId: number; contractAddress: string }): string {
  return `attributes:${scope.chainId}:${scope.contractAddress}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validAttribute(value: unknown): boolean {
  return record(value) && typeof value.trait_type === 'string' && value.trait_type.length > 0 &&
    (typeof value.value === 'string' || Number.isFinite(metadataNumber(value.value)));
}

export async function fetchRevealAttributePayload(category: EthereumArtworkCategory, assetId: number,
  signal: AbortSignal, fetchSource: typeof fetch = fetch, catalog?: RevealAssetCatalog, ownerHatching = false): Promise<string> {
  if (category === 'egg' || !Object.hasOwn(REVEAL_ASSET_FAMILIES, category) ||
    !Number.isSafeInteger(assetId) || assetId < 1 ||
    assetId > (catalog?.categories[REVEAL_ASSET_FAMILIES[category]].count ?? REVEAL_CATEGORY_COUNTS[category]) &&
      !(ownerHatching && getOwnerHatchingGrail(category, assetId))) {
    throw new InvalidRevealAttributes('Invalid trait source identity.');
  }
  const url = `https://cdn.lil.org/nft/111k/${REVEAL_ASSET_FAMILIES[category]}/json/${REVEAL_ENRICHMENT_VERSION}/${assetId}.json`;
  let response: Response;
  try { response = await fetchSource(url, { signal, redirect: 'manual' }); }
  catch {
    signal.throwIfAborted();
    throw new RevealAttributeSourceUnavailable('request-failed');
  }
  if (response.status !== 200) {
    await cancelResponseBody(response);
    throw new RevealAttributeSourceUnavailable(`http-${response.status}`);
  }
  const source = await readBoundedResponseJson(response, { maxBytes: MAX_REVEAL_METADATA_BYTES, contentType: 'require-json', parseJson: parseMetadataJson,
    signal, createError: reason => new RevealAttributeSourceUnavailable(reason) });
  if (!record(source) || typeof source['collection block'] !== 'string' || !source['collection block'].trim() ||
    !Array.isArray(source.attributes) || !source.attributes.every(validAttribute)) {
    throw new RevealAttributeSourceUnavailable('invalid-source-attributes');
  }
  const grail = ownerHatching ? getOwnerHatchingGrail(category, assetId) : undefined;
  if (grail && source['collection block'] !== grail.collectionBlock) throw new RevealAttributeSourceUnavailable('collection-block-mismatch');
  const payload = JSON.stringify([{ trait_type: 'collection block', value: source['collection block'] }, ...source.attributes]);
  if (new TextEncoder().encode(payload).byteLength > MAX_REVEAL_METADATA_BYTES) throw new RevealAttributeSourceUnavailable('too-large');
  return payload;
}

export function applyRevealAttributePayload(baseJson: string, attributesJson: string): { metadataJson: string; metadataSha256: string } {
  if (typeof attributesJson !== 'string' || new TextEncoder().encode(attributesJson).byteLength > MAX_REVEAL_METADATA_BYTES) {
    throw new InvalidRevealAttributes('Invalid frozen attribute payload.');
  }
  let payload: unknown;
  try { payload = parseMetadataJson(attributesJson); }
  catch { throw new InvalidRevealAttributes('Invalid frozen attribute payload.'); }
  if (!Array.isArray(payload) || !payload.length || !payload.every(validAttribute) || !record(payload[0]) ||
    payload[0].trait_type !== 'collection block' || typeof payload[0].value !== 'string' || !payload[0].value.trim()) {
    throw new InvalidRevealAttributes('Invalid frozen attribute payload.');
  }
  let base: unknown;
  try { base = parseMetadataJson(baseJson); }
  catch { throw new InvalidRevealAttributes('Invalid frozen artwork JSON.'); }
  if (!record(base) || !Array.isArray(base.attributes)) throw new InvalidRevealAttributes('Invalid frozen artwork metadata.');
  const block = payload[0];
  const authoritativeBlock = base.attributes.some(attribute => record(attribute) && attribute.trait_type === 'collection block');
  const remaining = [...base.attributes, ...payload.slice(1)].filter(attribute => {
    if (!authoritativeBlock) return true;
    if (!record(attribute) || attribute.trait_type !== 'collection block') return true;
    if (attribute.value !== block.value) throw new RevealAttributeSourceUnavailable('collection-block-mismatch');
    return false;
  });
  const attributes = [block, ...remaining];
  const metadataJson = JSON.stringify({ ...base, attributes }) + '\n';
  const bytes = new TextEncoder().encode(metadataJson);
  if (bytes.length > MAX_REVEAL_METADATA_BYTES) throw new EnrichedRevealMetadataTooLarge('Enriched metadata exceeds 512 KiB.');
  return { metadataJson, metadataSha256: bytesToHex(sha256(bytes)) };
}

export async function fetchRevealAttributes(category: EthereumArtworkCategory, assetId: number, baseJson: string,
  signal: AbortSignal, fetchSource: typeof fetch = fetch, catalog?: RevealAssetCatalog): Promise<{ metadataJson: string; metadataSha256: string }> {
  const payload = await fetchRevealAttributePayload(category, assetId, signal, fetchSource, catalog);
  try { return applyRevealAttributePayload(baseJson, payload); }
  catch (error) {
    if (error instanceof EnrichedRevealMetadataTooLarge) throw new RevealAttributeSourceUnavailable('too-large');
    throw error;
  }
}
