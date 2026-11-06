import type { Ethereum111kConfig, EthereumInventoryItem, EthereumInventoryResponse } from '../../shared/ethereum/api';
import { ETHEREUM_MAX_INVENTORY_EXPECTED_IDS } from '../../shared/ethereum/protocol';
import { ethereumApi } from './api';

export async function fetchEthereumInventory(
  config: Ethereum111kConfig,
  owner: string,
  signal: AbortSignal,
  expectedTokenIds: string[] = [],
): Promise<EthereumInventoryResponse> {
  const items = new Map<string, EthereumInventoryItem>();
  const cursors = new Set<string>();
  const expected = [...new Set(expectedTokenIds)];
  let cursor: string | null = null;
  let observedBlock = Infinity;
  do {
    signal.throwIfAborted();
    const page = await ethereumApi.inventory(config, owner, cursor, signal, cursor ? [] : expected.slice(0, ETHEREUM_MAX_INVENTORY_EXPECTED_IDS));
    signal.throwIfAborted();
    for (const item of page.items) items.set(item.id, item);
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
    for (const item of page.items) items.set(item.id, item);
    observedBlock = Math.min(observedBlock, page.observedBlock);
  }
  return { items: [...items.values()], nextCursor: null, observedBlock };
}
