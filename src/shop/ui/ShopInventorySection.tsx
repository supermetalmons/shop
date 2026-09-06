import { InventoryGrid } from '../../components/InventoryGrid';
import {
  InventoryItem
} from '../../types';

type ShopInventorySectionProps = {
  inventoryItems: InventoryItem[];
  selected: Set<string>;
  toggleSelected: (id: string) => void;
  pendingRevealIds: Set<string>;
  canOpenBoxesForDropId: (dropId?: string) => boolean;
  onReveal: (id: string, rect: DOMRect) => void;
  revealLoading: string | null;
  revealDisabled: boolean;
  inventoryEmptyStateVisibility: 'visible' | 'hidden';
};
export function ShopInventorySection({
  inventoryItems,
  selected,
  toggleSelected,
  pendingRevealIds,
  canOpenBoxesForDropId,
  onReveal,
  revealLoading,
  revealDisabled,
  inventoryEmptyStateVisibility,
}: ShopInventorySectionProps) {
  return (<section className="app-section inventory-section">
    <div className="app-section__head">
      <div className="app-section__title">Inventory</div>
    </div>
    <InventoryGrid
      items={inventoryItems}
      selected={selected}
      onToggle={toggleSelected}
      pendingRevealIds={pendingRevealIds}
      canRevealItem={(item) => canOpenBoxesForDropId(item.dropId)}
      onReveal={onReveal}
      revealLoadingId={revealLoading}
      revealDisabled={revealDisabled}
      emptyStateVisibility={inventoryEmptyStateVisibility}
    />
  </section>);
}
