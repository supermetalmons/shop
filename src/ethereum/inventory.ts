import type { EthereumInventoryItem } from '../../shared/ethereum/api';
import type { EthereumContainerKind } from '../../shared/ethereum/protocol';
import type { InventoryItem } from '../types';
import { ETHEREUM_CONTAINER_MEDIA } from './containerMedia';
import { ethereumInventoryView } from './state';

export type EthereumPendingMint = {
  id: string;
  kind: EthereumContainerKind;
  quantity: number;
  submittedAt: number;
  image?: string;
};

type EthereumInventoryOptions = {
  items: readonly EthereumInventoryItem[];
  pendingMints: readonly EthereumPendingMint[];
  solanaItems: readonly InventoryItem[];
  dropId: string;
};

function inventoryRank(item: EthereumInventoryItem): number {
  return item.kind === 'warehouse' || item.kind === 'relic' ? 0 : item.kind === 'crate' ? 1 : 2;
}

export function buildEthereumInventoryItems({ items, pendingMints, solanaItems, dropId }: EthereumInventoryOptions) {
  const pendingItems: InventoryItem[] = [...pendingMints]
    .sort((left, right) => right.submittedAt - left.submittedAt)
    .flatMap(mint => {
      const media = ETHEREUM_CONTAINER_MEDIA[mint.kind];
      return Array.from({ length: mint.quantity }, (_, index) => ({
        id: `ethereum-pending:${mint.id}:${index}`,
        dropId,
        name: `Pending ${media.label.toLowerCase()}`,
        image: mint.image ?? media.src,
        imageDimensions: { width: media.width, height: media.height },
        kind: 'box' as const,
        status: 'pending' as const,
      }));
    });
  const confirmedItems = [...new Map(items.map(item => [item.id, item])).values()]
    .filter(item => !item.kind.endsWith('_receipt'))
    .sort((left, right) => inventoryRank(left) - inventoryRank(right))
    .map(item => ethereumInventoryView(item, dropId));
  return {
    items: [...pendingItems, ...confirmedItems, ...solanaItems],
    busyItemIds: new Set(pendingItems.map(item => item.id)),
  };
}
