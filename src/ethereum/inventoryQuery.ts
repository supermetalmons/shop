import type { Ethereum111kConfig, EthereumInventoryItem, EthereumInventoryResponse } from '../../shared/ethereum/api';
import { ETHEREUM_MAX_INVENTORY_EXPECTED_IDS } from '../../shared/ethereum/protocol';
import { ethereumApi } from './api';
import { assertEthereumCatalog, assertSameEthereumCatalog, retainEthereumMetadata } from './catalogRevision';

export async function fetchEthereumInventory(
  config: Ethereum111kConfig,
  owner: string,
  signal: AbortSignal,
  expectedTokenIds: string[] = [],
): Promise<EthereumInventoryResponse> {
  let previousItems = new Map<string, EthereumInventoryItem>();
  for (let attempt = 0; ; attempt++) {
    const items = new Map<string, EthereumInventoryItem>();
    const cursors = new Set<string>();
    const revisions = new Set<number>();
    const expected = [...new Set(expectedTokenIds)];
    let cursor: string | null = null;
    let observedBlock = Infinity;
    let catalog: Pick<EthereumInventoryResponse, 'catalogRevision' | 'deploymentId'> | undefined;
    const checkCatalog = (page: EthereumInventoryResponse) => {
      assertEthereumCatalog(config, page);
      if (catalog) assertSameEthereumCatalog(catalog, page);
      revisions.add(page.catalogRevision ?? 0);
      catalog = { ...(page.catalogRevision !== undefined || catalog?.catalogRevision !== undefined
        ? { catalogRevision: Math.max(page.catalogRevision ?? 0, catalog?.catalogRevision ?? 0) } : {}),
        ...(page.deploymentId !== undefined && { deploymentId: page.deploymentId }) };
    };
    const remember = (item: EthereumInventoryItem) => items.set(item.id,
      retainEthereumMetadata(items.get(item.id) ?? previousItems.get(item.id), item));
    do {
      signal.throwIfAborted();
      const page = await ethereumApi.inventory(config, owner, cursor, signal, cursor ? [] : expected.slice(0, ETHEREUM_MAX_INVENTORY_EXPECTED_IDS));
      signal.throwIfAborted();
      checkCatalog(page);
      for (const item of page.items) remember(item);
      observedBlock = Math.min(observedBlock, page.observedBlock);
      cursor = page.nextCursor;
      if (cursor !== null) {
        if (!cursor || cursors.has(cursor)) throw new Error('Couldn’t load your collection. Please try again.');
        cursors.add(cursor);
      }
    } while (cursor !== null);
    for (let offset = ETHEREUM_MAX_INVENTORY_EXPECTED_IDS; offset < expected.length; offset += ETHEREUM_MAX_INVENTORY_EXPECTED_IDS) {
      signal.throwIfAborted();
      const page = await ethereumApi.inventory(config, owner, null, signal, expected.slice(offset, offset + ETHEREUM_MAX_INVENTORY_EXPECTED_IDS));
      signal.throwIfAborted();
      checkCatalog(page);
      for (const item of page.items) remember(item);
      observedBlock = Math.min(observedBlock, page.observedBlock);
    }
    if (attempt === 0 && revisions.size > 1) { previousItems = items; continue; }
    return { ...catalog, items: [...items.values()], nextCursor: null, observedBlock };
  }
}
