import type { QueryClient } from '@tanstack/react-query';
import type { Ethereum111kConfig } from '../../shared/ethereum/config';
import type { EthereumMetadata } from '../../shared/ethereum/protocol';

type CatalogScope = { catalogRevision?: number; deploymentId?: string | null };

export class EthereumCatalogChangedError extends Error {
  constructor() { super('The artwork catalog changed. Refreshing your collection.'); }
}

export function validEthereumCatalogScope(value: { catalogRevision?: unknown; deploymentId?: unknown }): boolean {
  return (value.catalogRevision === undefined || Number.isSafeInteger(value.catalogRevision) && Number(value.catalogRevision) >= 0) &&
    (value.deploymentId === undefined || value.deploymentId === null || typeof value.deploymentId === 'string' &&
      /^[a-z0-9][a-z0-9-]{0,63}$/.test(value.deploymentId));
}

export function ethereumCatalogKey(scope: CatalogScope): readonly (string | number | null)[] {
  return scope.deploymentId ? [scope.deploymentId] : [];
}

export function assertEthereumCatalog(expected: CatalogScope, actual: CatalogScope): void {
  if (expected.deploymentId != null && expected.deploymentId !== actual.deploymentId) throw new EthereumCatalogChangedError();
}

export function validEthereumMetadataRevision(value: unknown): boolean {
  return value === undefined || Number.isSafeInteger(value) && Number(value) >= 0;
}

export function retainEthereumMetadata<T extends EthereumMetadata>(current: T | undefined, next: T): T {
  if (!current || (current.metadataRevision ?? 0) <= (next.metadataRevision ?? 0) &&
    !(current.revealStatus === 'revealed' && next.revealStatus !== 'revealed')) return next;
  return { ...next, metadataRevision: current.metadataRevision, name: current.name, description: current.description,
    image: current.image, animation_url: current.animation_url, aspectRatio: current.aspectRatio, category: current.category,
    revealStatus: current.revealStatus, attributes: current.attributes };
}

export function assertSameEthereumCatalog(expected: CatalogScope, actual: CatalogScope): void {
  assertEthereumCatalog(expected, actual);
  if ((expected.deploymentId ?? null) !== (actual.deploymentId ?? null)) throw new EthereumCatalogChangedError();
}

export function retainEthereumCatalogConfig(current: Ethereum111kConfig | undefined, next: Ethereum111kConfig): Ethereum111kConfig {
  if (current && current.chainId === next.chainId && current.contractAddress === next.contractAddress &&
    ((next.catalogRevision ?? 0) < (current.catalogRevision ?? 0) || current.deploymentId != null && next.deploymentId == null)) return current;
  if (current?.deploymentId && next.deploymentId && current.chainId === next.chainId &&
    current.contractAddress === next.contractAddress && current.deploymentId !== next.deploymentId) throw new EthereumCatalogChangedError();
  return next;
}

export async function refreshEthereumCatalog(client: QueryClient, error: unknown): Promise<void> {
  if (error instanceof EthereumCatalogChangedError) await client.invalidateQueries({ queryKey: ['ethereum111k', 'config'] });
}
