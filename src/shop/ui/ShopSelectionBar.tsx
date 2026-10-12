import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { FaBoxOpen, FaPlane } from 'react-icons/fa6';
import {
  BackgroundLayerPortal
} from '../../components/BackgroundBlurLayer';
import { colorSchemeBackgroundImageStyle } from '../../components/ColorSchemeImage';
import type { ShopInventorySelection } from '../inventory/useShopInventorySelection';

type ShopSelectionBarProps = Pick<ShopInventorySelection,
  'selectedCount'
  | 'selectedPreview'
  | 'selectedOverflow'
  | 'canViewSelected'
  | 'canOpenSelected'
  | 'canShipSelected'
  | 'hasPreorderSelected'
  | 'selectedBox'
> & {
  clearSelection: () => void;
  handleViewSelectedItem: () => void;
  handleOpenSelectedBox: () => void;
  handleOpenShip: () => void;
  startOpenLoading: string | null;
  walletActionBusy?: boolean;
  shippingSignInPending?: boolean;
  openActionProgressForDropId: (dropId?: string) => string;
  openActionLabelForDropId: (dropId?: string) => string;
};

type SelectionPanelProps = Pick<ShopSelectionBarProps, 'selectedCount' | 'selectedPreview' | 'selectedOverflow' | 'clearSelection'>;

function FittedSelectionPanel({ children }: { children: ReactNode }) {
  const panelRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    let frame = 0;
    let cancelled = false;

    const fits = () => {
      const style = window.getComputedStyle(panel);
      const contentWidth = Array.from(panel.children).reduce((width, child) => width + child.getBoundingClientRect().width, 0);
      const availableWidth = panel.getBoundingClientRect().width - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
      return contentWidth + parseFloat(style.columnGap) + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) <= availableWidth + 0.01;
    };
    const update = () => {
      frame = 0;
      delete panel.dataset.density;
      if (fits()) return;
      panel.dataset.density = 'tight';
      if (fits()) return;
      panel.dataset.density = 'compact';
    };
    const schedule = () => {
      if (!cancelled && !frame) frame = window.requestAnimationFrame(update);
    };

    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(panel);
    panel.querySelectorAll('.selection-panel__preview, .selection-panel__actions, button').forEach((element) => observer?.observe(element));
    window.addEventListener('resize', schedule);
    void document.fonts?.ready.then(schedule);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', schedule);
    };
  });

  return <div ref={panelRef} className="selection-panel selection-panel--inventory">{children}</div>;
}

function SelectionPanel({ selectedCount, selectedPreview, selectedOverflow, clearSelection, children }: SelectionPanelProps & { children: ReactNode }) {
  return selectedCount ? (
    <BackgroundLayerPortal>
      <FittedSelectionPanel>
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
          <button type="button" className="quiet" onClick={clearSelection}>Cancel</button>
          {children}
        </div>
      </FittedSelectionPanel>
    </BackgroundLayerPortal>
  ) : null;
}

function ViewButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="selection-panel__view"
      onClick={onClick}
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
  );
}

export function PreorderSelectionBar({ canViewSelected, handleViewSelectedItem, ...panel }: SelectionPanelProps & Pick<ShopSelectionBarProps, 'canViewSelected' | 'handleViewSelectedItem'>) {
  return (
    <SelectionPanel {...panel}>
      {canViewSelected && <ViewButton onClick={handleViewSelectedItem} />}
      <button type="button" className="selection-panel__ship" disabled>
        <FaPlane aria-hidden="true" focusable="false" size={16} />
        <span>Soon</span>
      </button>
    </SelectionPanel>
  );
}

export function ShopSelectionBar({
  selectedCount,
  selectedPreview,
  selectedOverflow,
  canViewSelected,
  canOpenSelected,
  canShipSelected,
  hasPreorderSelected,
  selectedBox,
  clearSelection,
  handleViewSelectedItem,
  handleOpenSelectedBox,
  handleOpenShip,
  startOpenLoading,
  walletActionBusy = false,
  shippingSignInPending = false,
  openActionProgressForDropId,
  openActionLabelForDropId,
}: ShopSelectionBarProps) {
  const panel = { selectedCount, selectedPreview, selectedOverflow, clearSelection };
  if (hasPreorderSelected) return <PreorderSelectionBar {...panel} canViewSelected={canViewSelected} handleViewSelectedItem={handleViewSelectedItem} />;
  return (
    <SelectionPanel {...panel}>
      {canViewSelected && <ViewButton onClick={handleViewSelectedItem} />}
      {canOpenSelected ? (
        <button
          type="button"
          className="selection-panel__open"
          onClick={handleOpenSelectedBox}
          disabled={walletActionBusy || Boolean(startOpenLoading)}
        >
          <FaBoxOpen aria-hidden="true" focusable="false" size={18} />
          <span>{startOpenLoading === selectedBox?.id ? openActionProgressForDropId(selectedBox?.dropId) : openActionLabelForDropId(selectedBox?.dropId)}</span>
        </button>
      ) : null}
      {canShipSelected && (
        <button type="button" className="selection-panel__ship" onClick={handleOpenShip} disabled={walletActionBusy}>
          <FaPlane aria-hidden="true" focusable="false" size={16} />
          <span>{shippingSignInPending ? 'Signing in…' : 'Send'}</span>
        </button>
      )}
    </SelectionPanel>
  );
}
