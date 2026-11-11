import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { ethereumMetadataBaseUri } from './config.ts';
import { normalizeEthereumAddress } from './protocol.ts';
import { ETHEREUM_REVEAL_DEPLOYMENT_ID } from './revealDeployment.ts';
import relicTemplate from '../../scripts/ethereum-metadata/templates/relic.json';

export type RelicImagesScope = {
  deploymentId: string;
  chainId: number;
  contractAddress: string;
  metadataBaseUri: string;
  expectedRevision: number;
};
export type RelicImagePatch = {
  tokenId: string;
  beforeJson: string;
  afterJson: string;
  beforeSha256: string;
  afterSha256: string;
  etag: string;
};
export type RelicImagesRequest = { scope: RelicImagesScope; field?: 'name' } & ({ action: 'inspect' } | { action: 'apply'; patch: RelicImagePatch });
export type RelicImagesResult = { action: 'inspect'; objects: RelicImagePatch[] } |
  { action: 'apply'; tokenId: string; status: 'updated' | 'unchanged' };
export const RELIC_IMAGE_TOKEN_IDS: readonly string[] = Object.freeze(Array.from({ length: 18 }, (_, index) => String(117172 + index)));
export const MAX_RELIC_METADATA_BYTES = 128 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function invalid(reason: string): never { throw new Error(`Invalid relic images request: ${reason}.`); }

export function parseRelicImagesScope(value: unknown): RelicImagesScope {
  if (!record(value) || !keys(value, ['deploymentId', 'chainId', 'contractAddress', 'metadataBaseUri', 'expectedRevision']) ||
    typeof value.deploymentId !== 'string' || !ETHEREUM_REVEAL_DEPLOYMENT_ID.test(value.deploymentId) ||
    ![1, 11155111].includes(Number(value.chainId)) || typeof value.chainId !== 'number' ||
    typeof value.contractAddress !== 'string' || normalizeEthereumAddress(value.contractAddress) !== value.contractAddress ||
    /^0x0{40}$/.test(value.contractAddress) || typeof value.metadataBaseUri !== 'string' ||
    typeof value.expectedRevision !== 'number' || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1) invalid('scope');
  ethereumMetadataBaseUri(value.metadataBaseUri, value.chainId);
  return { deploymentId: value.deploymentId, chainId: value.chainId, contractAddress: value.contractAddress,
    metadataBaseUri: value.metadataBaseUri, expectedRevision: value.expectedRevision };
}

export function relicImageSha256(json: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(json)));
}

function stringEnd(json: string, start: number): number {
  for (let index = start + 1; index < json.length; index++) {
    if (json[index] === '\\') index++;
    else if (json[index] === '"') return index + 1;
  }
  return invalid('unterminated JSON string');
}

function valueEnd(json: string, start: number): number {
  if (json[start] === '"') return stringEnd(json, start);
  let depth = 0;
  for (let index = start; index < json.length; index++) {
    const character = json[index];
    if (character === '"') index = stringEnd(json, index) - 1;
    else if (character === '[' || character === '{') depth++;
    else if (character === ']' || character === '}') {
      if (!depth) return index;
      if (--depth === 0) return index + 1;
    } else if (character === ',' && !depth) return index;
  }
  return invalid('unterminated JSON value');
}

function relicMetadataJson(tokenId: string, json: string, field: 'image' | 'name'): string {
  if (!RELIC_IMAGE_TOKEN_IDS.includes(tokenId) || typeof json !== 'string' ||
    json.length > MAX_RELIC_METADATA_BYTES || new TextEncoder().encode(json).byteLength > MAX_RELIC_METADATA_BYTES) invalid('metadata');
  const metadata: unknown = JSON.parse(json);
  if (!record(metadata) || typeof metadata.name !== 'string' || typeof metadata.description !== 'string' ||
    !Array.isArray(metadata.attributes)) invalid('metadata object');
  const displayId = Number(tokenId) - 117171;
  const base = `https://cdn.lil.org/nft/111k/relics/${displayId}`;
  if (metadata.image !== `${base}.webp` && metadata.image !== `${base}.png`) invalid('noncanonical relic image');
  const target = field === 'name' ? relicTemplate.displayNames[displayId - 1] : `${base}.png`;
  if (typeof target !== 'string' || !target) invalid('relic display name');
  if (field === 'name' && metadata.name !== `Relic #${displayId}` && metadata.name !== target) invalid('noncanonical relic name');
  const skipWhitespace = (index: number) => { while (/\s/.test(json[index] ?? '') && index < json.length) index++; return index; };
  let cursor = skipWhitespace(0) + 1;
  let literal: { start: number; end: number } | undefined;
  const names = new Set<string>();
  while (json[skipWhitespace(cursor)] !== '}') {
    cursor = skipWhitespace(cursor);
    const end = stringEnd(json, cursor);
    const name: string = JSON.parse(json.slice(cursor, end));
    if (names.has(name)) invalid('duplicate metadata property');
    names.add(name);
    const start = skipWhitespace(skipWhitespace(end) + 1);
    const next = valueEnd(json, start);
    if (name === field) literal = { start, end: next };
    cursor = skipWhitespace(next);
    if (json[cursor] === ',') cursor++;
  }
  if (!literal || json.slice(literal.start, literal.end) !== JSON.stringify(metadata[field])) invalid(`noncanonical ${field} literal`);
  const result = json.slice(0, literal.start) + JSON.stringify(target) + json.slice(literal.end);
  if (result.length > MAX_RELIC_METADATA_BYTES || new TextEncoder().encode(result).byteLength > MAX_RELIC_METADATA_BYTES) invalid('metadata');
  return result;
}

export function relicImagePngJson(tokenId: string, json: string): string {
  return relicMetadataJson(tokenId, json, 'image');
}

export function prepareRelicImagePatch(tokenId: string, beforeJson: string, etag: string, field?: 'name'): RelicImagePatch {
  if (typeof etag !== 'string' || !etag || etag.length > 256 || /[\s"\x00-\x1f\x7f]/.test(etag)) invalid('ETag');
  const afterJson = relicMetadataJson(tokenId, beforeJson, field ?? 'image');
  return { tokenId, beforeJson, afterJson, beforeSha256: relicImageSha256(beforeJson), afterSha256: relicImageSha256(afterJson), etag };
}

export function parseRelicImagePatch(value: unknown, field?: 'name'): RelicImagePatch {
  if (!record(value) || !keys(value, ['tokenId', 'beforeJson', 'afterJson', 'beforeSha256', 'afterSha256', 'etag']) ||
    typeof value.tokenId !== 'string' || typeof value.beforeJson !== 'string' || typeof value.etag !== 'string') invalid('patch');
  const patch = prepareRelicImagePatch(value.tokenId, value.beforeJson, value.etag, field);
  if (value.afterJson !== patch.afterJson || value.beforeSha256 !== patch.beforeSha256 || value.afterSha256 !== patch.afterSha256) invalid('patch content or checksum');
  return patch;
}

export function parseRelicImagesRequest(value: unknown): RelicImagesRequest {
  if (!record(value) || !['inspect', 'apply'].includes(String(value.action)) ||
    (Object.hasOwn(value, 'field') && value.field !== 'name') ||
    !keys(value, [...(value.action === 'inspect' ? ['scope', 'action'] : ['scope', 'action', 'patch']),
      ...(Object.hasOwn(value, 'field') ? ['field'] : [])])) invalid('action');
  const scope = parseRelicImagesScope(value.scope);
  const selected = value.field === 'name' ? { field: 'name' as const } : {};
  return value.action === 'inspect' ? { scope, action: 'inspect', ...selected }
    : { scope, action: 'apply', ...selected, patch: parseRelicImagePatch(value.patch, selected.field) };
}
