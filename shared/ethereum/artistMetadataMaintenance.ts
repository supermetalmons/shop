import type { EthereumArtworkCategory } from './reveal.ts';
import { isRevealArtworkTokenId } from './revealMaintenance.ts';
import { normalizeEthereumAddress } from './protocol.ts';
import { ETHEREUM_REVEAL_CATALOG_VERSION_PATTERN, type EthereumRevealDeployment } from './revealDeployment.ts';

export const ARTIST_METADATA_MAX_PAGE_SIZE = 256;
export const ARTIST_METADATA_PLAN_PAGE_SIZE = 1024;

export type ArtistMetadataScope = {
  deploymentId: 'mainnet-v1'; chainId: 1; contractAddress: string; metadataBaseUri: 'https://cdn.mons.shop/111k/';
  deploymentBlock: number; expectedRevision: number; catalogRevision: number; catalogVersion: string; catalogSha256: string;
  mappingSha256: string; operationId: string; frozenThroughMs: number;
};
export type ArtistMetadataRequest = {
  scope: ArtistMetadataScope; action: 'inspect' | 'start' | 'plan' | 'apply' | 'verify';
  after?: string | null; limit?: number; retryTokenIds?: string[]; frozenThroughMs?: number;
};
export type ArtistMetadataEvidence = {
  tokenId: string; category: EthereumArtworkCategory; assetId: number; assignmentRevision: number; metadataRevision: number;
  metadataSha256: string; frozenMetadataSha256: string; nonAttributeSha256: string; nonArtistSha256: string;
  collectionBlock: string | null; artists: string[];
};
export type ArtistMetadataPage = {
  scope: ArtistMetadataScope; action: ArtistMetadataRequest['action']; started: boolean; frozenThroughMs: number;
  next: string | null; scanned: number; eggs: number; credited: number; published: number;
  deferred: string[]; conflicts: string[]; records: ArtistMetadataEvidence[];
  plannedTokenIds?: string[];
};

const digest = /^[a-f0-9]{64}$/;
const operationPattern = /^artist-[a-f0-9]{32}$/;
const scopeKeys = ['deploymentId', 'chainId', 'contractAddress', 'metadataBaseUri', 'deploymentBlock', 'expectedRevision', 'catalogRevision',
  'catalogVersion', 'catalogSha256', 'mappingSha256', 'operationId', 'frozenThroughMs'];

function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

export function parseArtistMetadataRequest(value: unknown, now = Date.now()): ArtistMetadataRequest {
  const invalid = () => new Error('Invalid 111k mainnet artist maintenance scope or page.');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const r = value as Record<string, unknown>;
  if (!r.scope || typeof r.scope !== 'object' || Array.isArray(r.scope) ||
    Object.keys(r).some(key => !['scope', 'action', 'after', 'limit', 'retryTokenIds', 'frozenThroughMs'].includes(key))) throw invalid();
  const s = r.scope as Record<string, unknown>;
  if (Object.keys(s).length !== scopeKeys.length || scopeKeys.some(key => !Object.hasOwn(s, key)) ||
    s.deploymentId !== 'mainnet-v1' || s.chainId !== 1 || typeof s.contractAddress !== 'string' || normalizeEthereumAddress(s.contractAddress) !== s.contractAddress ||
    s.metadataBaseUri !== 'https://cdn.mons.shop/111k/' || !integer(s.deploymentBlock, 1) || !integer(s.expectedRevision, 1) ||
    !integer(s.catalogRevision, 0) || typeof s.catalogVersion !== 'string' || !ETHEREUM_REVEAL_CATALOG_VERSION_PATTERN.test(s.catalogVersion) ||
    typeof s.catalogSha256 !== 'string' || !digest.test(s.catalogSha256) || typeof s.mappingSha256 !== 'string' || !digest.test(s.mappingSha256) ||
    typeof s.operationId !== 'string' || !operationPattern.test(s.operationId) || !integer(s.frozenThroughMs, 1, now)) throw invalid();
  if (r.action === 'start' || r.action === 'inspect') {
    if (Object.keys(r).length !== 2) throw invalid();
  } else if (r.action === 'apply' || r.action === 'verify' || r.action === 'plan') {
    const maximum = r.action === 'plan' ? ARTIST_METADATA_PLAN_PAGE_SIZE : ARTIST_METADATA_MAX_PAGE_SIZE;
    if (!integer(r.limit, 1, maximum) || r.after !== null && !isRevealArtworkTokenId(r.after)) throw invalid();
    if ('retryTokenIds' in r && (r.action === 'plan' || r.after !== null || !Array.isArray(r.retryTokenIds) ||
      !r.retryTokenIds.length || r.retryTokenIds.length > r.limit || new Set(r.retryTokenIds).size !== r.retryTokenIds.length ||
      !r.retryTokenIds.every(isRevealArtworkTokenId))) throw invalid();
    if ('frozenThroughMs' in r && (r.action === 'apply' || !integer(r.frozenThroughMs, Number(s.frozenThroughMs), now))) throw invalid();
  } else throw invalid();
  return r as ArtistMetadataRequest;
}

export function requireArtistMetadataScope(deployment: EthereumRevealDeployment | null | undefined, s: ArtistMetadataScope): asserts deployment is EthereumRevealDeployment {
  if (!deployment || deployment.deploymentId !== s.deploymentId || deployment.chainId !== s.chainId || deployment.dropId !== '111k' ||
    deployment.contractAddress !== s.contractAddress || deployment.metadataBaseUri !== s.metadataBaseUri || deployment.deploymentBlock !== s.deploymentBlock ||
    deployment.revision !== s.expectedRevision || deployment.catalogRevision !== s.catalogRevision ||
    deployment.effectiveCatalogVersion !== s.catalogVersion || deployment.effectiveCatalogSha256 !== s.catalogSha256 ||
    deployment.state !== 'active' || deployment.retiredAtMs != null || deployment.catalogUpdateId != null || deployment.provisionedAtMs == null) {
    throw new Error('Artist maintenance requires the pinned active 111k mainnet registry.');
  }
}
