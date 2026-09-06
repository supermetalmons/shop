import {
  type LocalMintedBox
} from '../../lib/localMintedBoxes';
import {
  InventoryItem,
  PendingOpenBox
} from '../../types';
import {
  type LocalPendingReveal
} from '../persistedState';

export const MAX_SHIPMENT_ITEMS = 24;

export const EMPTY_INVENTORY: InventoryItem[] = [];

export const EMPTY_PENDING_OPEN: PendingOpenBox[] = [];

export const LOCAL_PENDING_GRACE_MS = 2 * 60 * 1000;

export const RECENT_REVEALS_LIMIT = 10;

export const FIGURE_METADATA_RETRY_MS = 3000;

export const EMPTY_LOCAL_MINTED_BOXES: readonly LocalMintedBox[] = [];

export function pendingRevealListEqual(left: LocalPendingReveal[], right: LocalPendingReveal[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0;i < left.length;i += 1) {
    const a = left[i];
    const b = right[i];
    if (!a || !b) return false;
    if (a.id !== b.id) return false;
    if (a.createdAt !== b.createdAt) return false;
    if ((a.dropId || '') !== (b.dropId || '')) return false;
    if ((a.name || '') !== (b.name || '')) return false;
    if ((a.image || '') !== (b.image || '')) return false;
    if ((a.boxId || '') !== (b.boxId || '')) return false;
  }
  return true;
}
