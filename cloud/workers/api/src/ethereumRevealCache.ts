import type { EthereumRevealTokensResponse } from '../../../../shared/ethereum/reveal.js';
import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import { createTimedAbortScope, raceWithSignal } from './boundedRequest.js';
import { cancelResponseBody, readBoundedResponseJson } from './boundedResponse.js';
import type { DeferredWork } from './deferredWork.js';
import { parseMetadataJson } from './ethereumMetadataJson.js';
import { sha256Hex } from './sessionSecrets.js';

type RevealCache = Pick<Cache, 'match' | 'put'>;
const MAX_BYTES = 2 * 1024 * 1024;
const EXPIRY_HEADER = 'X-Reveal-Cache-Expires-At';

function scope(deployment: EthereumRevealDeployment): string {
  return JSON.stringify([deployment.chainId, deployment.contractAddress, deployment.deploymentId, deployment.dropId,
    deployment.revision, deployment.catalogRevision ?? 0, deployment.catalogUpdateId ?? null,
    deployment.effectiveCatalogVersion ?? deployment.catalogVersion, deployment.effectiveCatalogSha256 ?? null,
    deployment.metadataBaseUri, deployment.deploymentBlock, deployment.templateSha256, deployment.state,
    deployment.provisionedAtMs, deployment.retiredAtMs ?? null]);
}

export function sameEthereumRevealCacheScope(before: EthereumRevealDeployment, after: EthereumRevealDeployment): boolean {
  return after.catalogUpdateId == null && after.retiredAtMs == null && scope(before) === scope(after);
}

export async function createEthereumRevealCacheRequest(request: Request, deployment: EthereumRevealDeployment,
  tokenIds: string[]): Promise<Request | null> {
  if (![1, 11155111].includes(deployment.chainId) || deployment.catalogUpdateId != null ||
    deployment.retiredAtMs != null || deployment.provisionedAtMs == null) return null;
  const key = await sha256Hex(JSON.stringify([scope(deployment), [...tokenIds].sort((a, b) => Number(a) - Number(b))]));
  return new Request(new URL(`/_internal/ethereum-reveal-cache/v1/${key}`, request.url));
}

function complete(value: unknown, deployment: EthereumRevealDeployment, ids: string[]): value is EthereumRevealTokensResponse {
  if (!value || typeof value !== 'object') return false;
  const body = value as Partial<EthereumRevealTokensResponse>;
  if (body.deploymentId !== deployment.deploymentId || body.dropId !== deployment.dropId ||
    body.chainId !== deployment.chainId || body.contractAddress !== deployment.contractAddress ||
    body.catalogRevision !== (deployment.catalogRevision ?? 0) || body.retryAfterMs !== 0 ||
    !Array.isArray(body.unresolved) || body.unresolved.length || !Array.isArray(body.artworks) ||
    body.artworks.length !== ids.length) return false;
  const remaining = new Set(ids);
  for (const artwork of body.artworks) {
    if (!artwork || typeof artwork !== 'object' || !remaining.delete(artwork.tokenId) ||
      typeof artwork.name !== 'string' || typeof artwork.image !== 'string' || !artwork.observation ||
      typeof artwork.observation.transactionHash !== 'string' || typeof artwork.observation.blockHash !== 'string' ||
      !Number.isSafeInteger(artwork.observation.blockNumber)) return false;
  }
  return remaining.size === 0;
}

function ttl(value: EthereumRevealTokensResponse): number {
  return value.artworks.every(artwork => artwork.category === 'egg' ||
    Number.isSafeInteger(artwork.metadataRevision) && (artwork.metadataRevision ?? 0) % 2 === 1) ? 5_000 : 2_000;
}

export async function readCachedEthereumReveal(cache: RevealCache, key: Request, deployment: EthereumRevealDeployment,
  tokenIds: string[], signal: AbortSignal): Promise<{ value: EthereumRevealTokensResponse; expiresAtMs: number } | null> {
  const timeout = createTimedAbortScope(signal, { timeoutMs: 100, timeoutMessage: 'Reveal cache lookup timed out.' });
  let response: Response | undefined;
  try {
    response = await raceWithSignal(cache.match(key).then(value => {
      if (timeout.signal.aborted) { if (value) void cancelResponseBody(value); return undefined; }
      return value;
    }), timeout.signal);
    if (!response) return null;
    const expiresAt = Number(response.headers.get(EXPIRY_HEADER));
    if (response.status !== 200 || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 5_000) return null;
    const value = await readBoundedResponseJson(response, { maxBytes: MAX_BYTES, contentType: 'require-json',
      parseJson: parseMetadataJson, signal: timeout.signal, createError: () => new Error('Invalid reveal cache response.') });
    if (!complete(value, deployment, tokenIds) || expiresAt <= Date.now() || expiresAt > Date.now() + ttl(value)) return null;
    const artworks = new Map(value.artworks.map(artwork => [artwork.tokenId, artwork]));
    return { value: { ...value, artworks: tokenIds.map(id => artworks.get(id)!) }, expiresAtMs: expiresAt };
  } catch {
    signal.throwIfAborted();
    return null;
  } finally {
    timeout.dispose();
    if (response) void cancelResponseBody(response);
  }
}

export function cacheEthereumReveal(cache: RevealCache, key: Request, deployment: EthereumRevealDeployment,
  tokenIds: string[], value: EthereumRevealTokensResponse, defer: DeferredWork): void {
  if (!complete(value, deployment, tokenIds)) return;
  try {
    const duration = ttl(value);
    const body = JSON.stringify(value);
    if (body.length > MAX_BYTES || new TextEncoder().encode(body).byteLength > MAX_BYTES) return;
    const response = new Response(body, { headers: { 'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${duration / 1000}`, [EXPIRY_HEADER]: String(Date.now() + duration) } });
    defer(Promise.resolve().then(() => cache.put(key, response)).catch(() => undefined));
  } catch {}
}
