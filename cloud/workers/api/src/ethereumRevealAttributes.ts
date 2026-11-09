import { bytesToHex } from '@noble/hashes/utils';
import { REVEAL_ENRICHMENT_VERSION, type EthereumArtworkCategory } from '../../../../shared/ethereum/reveal.js';
import { REVEAL_ASSET_FAMILIES } from '../../../../shared/ethereum/revealAssetCatalog.js';
import { cancelResponseBody, readBoundedResponseJson } from './boundedResponse.js';
import { metadataNumber, parseMetadataJson } from './ethereumMetadataJson.js';
import { REVEAL_CATEGORY_COUNTS } from './ethereumRevealCatalog.js';

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

export async function fetchRevealAttributes(category: EthereumArtworkCategory, assetId: number, baseJson: string,
  signal: AbortSignal, fetchSource: typeof fetch = fetch): Promise<{ metadataJson: string; metadataSha256: string }> {
  if (category === 'egg' || !Object.hasOwn(REVEAL_ASSET_FAMILIES, category) ||
    !Number.isSafeInteger(assetId) || assetId < 1 || assetId > REVEAL_CATEGORY_COUNTS[category]) {
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
  let base: unknown;
  try { base = parseMetadataJson(baseJson); }
  catch { throw new InvalidRevealAttributes('Invalid frozen artwork JSON.'); }
  if (!record(base) || !Array.isArray(base.attributes)) throw new InvalidRevealAttributes('Invalid frozen artwork metadata.');
  const attributes = [{ trait_type: 'collection block', value: source['collection block'] }, ...base.attributes, ...source.attributes];
  const metadataJson = JSON.stringify({ ...base, attributes }) + '\n';
  const bytes = new TextEncoder().encode(metadataJson);
  if (bytes.length > MAX_REVEAL_METADATA_BYTES) throw new InvalidRevealAttributes('Enriched metadata exceeds 128 KiB.');
  return { metadataJson, metadataSha256: bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))) };
}
