import { InventoryGrid } from '../../components/InventoryGrid';
import {
  InventoryItem
} from '../../types';

type ShopReceiptsSectionProps = {
  onEnterCode: () => void;
  receiptsContentVisible: boolean;
  receiptItems: InventoryItem[];
  selected: Set<string>;
  toggleSelected: (id: string) => void;
  openReceiptImageViewer: (item: InventoryItem, rect: DOMRect) => void;
};
export function ShopReceiptsSection({
  onEnterCode,
  receiptsContentVisible,
  receiptItems,
  selected,
  toggleSelected,
  openReceiptImageViewer,
}: ShopReceiptsSectionProps) {
  return (<section className="app-section receipts-section">
    <div className="app-section__head receipts-section__head">
      <div className="app-section__title">Receipts</div>
      <div className="app-section__actions">
        <button
          type="button"
          className="receipts-section__code-button"
          onClick={onEnterCode}
        >
          Enter code
        </button>
      </div>
    </div>
    {receiptsContentVisible ? (
      <InventoryGrid
        items={receiptItems}
        selected={selected}
        onToggle={toggleSelected}
        onViewItem={openReceiptImageViewer}
        className="inventory--receipts"
        emptyStateContent="No receipts yet."
      />
    ) : null}
  </section>);
}
