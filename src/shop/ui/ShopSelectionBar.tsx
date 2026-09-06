import { FaBoxOpen, FaPlane } from 'react-icons/fa6';
import {
  BackgroundLayerPortal
} from '../../components/BackgroundBlurLayer';
import { colorSchemeBackgroundImageStyle } from '../../components/ColorSchemeImage';
import type { ShopInventoryView } from '../inventory/useShopInventoryView';

type ShopSelectionBarProps = Pick<ShopInventoryView,
  'selectedCount'
  | 'selectedPreview'
  | 'selectedOverflow'
  | 'canViewSelected'
  | 'canOpenSelected'
  | 'canShipSelected'
  | 'selectedBox'
> & {
  clearSelection: () => void;
  handleViewSelectedItem: () => void;
  handleOpenSelectedBox: () => void;
  handleOpenShip: () => void;
  startOpenLoading: string | null;
  openActionProgressForDropId: (dropId?: string) => string;
  openActionLabelForDropId: (dropId?: string) => string;
};
export function ShopSelectionBar({
  selectedCount,
  selectedPreview,
  selectedOverflow,
  canViewSelected,
  canOpenSelected,
  canShipSelected,
  selectedBox,
  clearSelection,
  handleViewSelectedItem,
  handleOpenSelectedBox,
  handleOpenShip,
  startOpenLoading,
  openActionProgressForDropId,
  openActionLabelForDropId,
}: ShopSelectionBarProps) {
  return (selectedCount ? (
    <BackgroundLayerPortal>
      <div className="selection-panel">
        <div className="selection-panel__left">
          <div className="selection-panel__preview">
            {selectedPreview.map(({ item, previewImage }, idx) => {
              return previewImage ? (
                <div
                  key={item.id}
                  className="selection-panel__thumb color-scheme-background-image"
                  style={{
                    ...colorSchemeBackgroundImageStyle(item.dropId, previewImage),
                    zIndex: idx + 1,
                  }}
                  aria-hidden="true"
                />
              ) : (
                <div
                  key={item.id}
                  className="selection-panel__thumb selection-panel__thumb--empty"
                  style={{ zIndex: idx + 1 }}
                  aria-hidden="true"
                >
                  <span>#</span>
                </div>
              );
            })}
            {selectedOverflow ? (
              <div
                className="selection-panel__more"
                style={{ zIndex: selectedPreview.length + 2 }}
              >
                +{selectedOverflow}
              </div>
            ) : null}
          </div>
        </div>
        <div className="selection-panel__actions">
          <button
            type="button"
            className="quiet"
            onClick={clearSelection}
          >
            Cancel
          </button>
          {canViewSelected ? (
            <button
              type="button"
              className="selection-panel__view"
              onClick={handleViewSelectedItem}
            >
              <svg
                aria-hidden="true"
                focusable="false"
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
              >
                <rect
                  x="3.25"
                  y="1.75"
                  width="9.5"
                  height="12.5"
                  rx="2.5"
                  stroke="currentColor"
                  strokeWidth="1.75"
                />
              </svg>
              <span>View</span>
            </button>
          ) : null}
          {canOpenSelected ? (
            <button
              type="button"
              className="selection-panel__open"
              onClick={handleOpenSelectedBox}
              disabled={Boolean(startOpenLoading)}
            >
              <FaBoxOpen aria-hidden="true" focusable="false" size={18} />
              <span>{startOpenLoading === selectedBox?.id ? openActionProgressForDropId(selectedBox?.dropId) : openActionLabelForDropId(selectedBox?.dropId)}</span>
            </button>
          ) : null}
          {canShipSelected ? (
            <button
              type="button"
              className="selection-panel__ship"
              onClick={handleOpenShip}
            >
              <FaPlane aria-hidden="true" focusable="false" size={16} />
              <span>Send</span>
            </button>
          ) : null}
        </div>
      </div>
    </BackgroundLayerPortal>
  ) : null);
}
