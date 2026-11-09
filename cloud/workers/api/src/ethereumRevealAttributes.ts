import { bytesToHex } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import { REVEAL_ENRICHMENT_VERSION, type EthereumArtworkCategory } from '../../../../shared/ethereum/reveal.js';
import { REVEAL_ASSET_FAMILIES } from '../../../../shared/ethereum/revealAssetCatalog.js';
import { cancelResponseBody, readBoundedResponseJson } from './boundedResponse.js';
import { metadataNumber, parseMetadataJson } from './ethereumMetadataJson.js';
import { REVEAL_CATEGORY_COUNTS } from './ethereumRevealCatalog.js';
import type { RevealAssetCatalog } from '../../../../shared/ethereum/revealAssetCatalog.js';

export const MAX_REVEAL_METADATA_BYTES = 128 * 1024;

export class InvalidRevealAttributes extends Error {}

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
  signal: AbortSignal, fetchSource: typeof fetch = fetch, catalog?: RevealAssetCatalog): Promise<string> {
  if (category === 'egg' || !Object.hasOwn(REVEAL_ASSET_FAMILIES, category) ||
    !Number.isSafeInteger(assetId) || assetId < 1 || assetId > (catalog?.categories[REVEAL_ASSET_FAMILIES[category]].count ?? REVEAL_CATEGORY_COUNTS[category])) {
    throw new InvalidRevealAttributes('Invalid trait source identity.');
  }
  const url = `https://cdn.lil.org/nft/111k/${REVEAL_ASSET_FAMILIES[category]}/json/${REVEAL_ENRICHMENT_VERSION}/${assetId}.json`;
  const response = await fetchSource(url, { signal, redirect: 'manual' });
  if (response.status !== 200) {
    await cancelResponseBody(response);
    const message = `Trait source returned HTTP ${response.status}.`;
    if (response.status >= 500 || [408, 425, 429].includes(response.status)) throw new Error(message);
    throw new InvalidRevealAttributes(message);
  }
  const source = await readBoundedResponseJson(response, { maxBytes: MAX_REVEAL_METADATA_BYTES, contentType: 'require-json', parseJson: parseMetadataJson,
    signal, createError: reason => reason === 'stream-failed' ? new Error('Trait source stream failed.') :
      new InvalidRevealAttributes(`Invalid trait source (${reason}).`) });
  if (!record(source) || typeof source['collection block'] !== 'string' || !source['collection block'].trim() ||
    !Array.isArray(source.attributes) || !source.attributes.every(validAttribute)) {
    throw new InvalidRevealAttributes('Invalid collection block or source attributes.');
  }
  return JSON.stringify([{ trait_type: 'collection block', value: source['collection block'] }, ...source.attributes]);
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
  const attributes = [payload[0], ...base.attributes, ...payload.slice(1)];
  const metadataJson = JSON.stringify({ ...base, attributes }) + '\n';
  const bytes = new TextEncoder().encode(metadataJson);
  if (bytes.length > MAX_REVEAL_METADATA_BYTES) throw new InvalidRevealAttributes('Enriched metadata exceeds 128 KiB.');
  return { metadataJson, metadataSha256: bytesToHex(sha256(bytes)) };
}

export async function fetchRevealAttributes(category: EthereumArtworkCategory, assetId: number, baseJson: string,
  signal: AbortSignal, fetchSource: typeof fetch = fetch, catalog?: RevealAssetCatalog): Promise<{ metadataJson: string; metadataSha256: string }> {
  return applyRevealAttributePayload(baseJson, await fetchRevealAttributePayload(category, assetId, signal, fetchSource, catalog));
}
