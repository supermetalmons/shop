import { useEffect, useState, type DragEvent, type MouseEvent } from 'react';
import { InventoryItem } from '../types';
import { getFrontendDrop } from '../config/deployment';
import { dropAssetCount, dropMintSelectionLabel } from '../lib/dropLabels';
import { hideImageShowFallback, showImageHideFallback } from '../lib/imageFallback';
import { getInventoryRevealRect } from '../lib/inventoryMediaRect';

interface InventoryGridProps {
  items: InventoryItem[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  itemClassName?: string;
  className?: string;
  pendingRevealIds?: Set<string>;
  onReveal?: (id: string, rect: DOMRect) => void;
  canRevealItem?: (item: InventoryItem) => boolean;
  revealLoadingId?: string | null;
  revealDisabled?: boolean;
  emptyStateVisibility?: 'visible' | 'hidden' | 'none';
}

function InventoryMedia({ item }: { item: InventoryItem }) {
  const isReceipt = item.kind === 'certificate';
  const isFigure = item.kind === 'dude';
  const [figureImageFailed, setFigureImageFailed] = useState(false);

  useEffect(() => {
    setFigureImageFailed(false);
  }, [item.image]);

  if (!item.image) {
    return (
      <div className="placeholder" aria-hidden>
        <span> </span>
      </div>
    );
  }

  if (isFigure) {
    return (
      <>
        <img
          src={item.image}
          alt=""
          aria-hidden="true"
          hidden
          loading="lazy"
          draggable={false}
          onDragStart={(evt) => evt.preventDefault()}
          onError={() => setFigureImageFailed(true)}
        />
        {figureImageFailed ? (
          <div className="placeholder" aria-hidden>
            <span> </span>
          </div>
        ) : (
          <div
            className="inventory__image"
            style={{ backgroundImage: `url(${item.image})` }}
            role="img"
            aria-label={item.name}
          />
        )}
      </>
    );
  }

  return (
    <>
      <img
        className="inventory__image"
        src={item.image}
        alt={item.name}
        loading="lazy"
        draggable={false}
        onDragStart={(evt) => evt.preventDefault()}
        onLoad={(evt) => showImageHideFallback(evt.currentTarget)}
        onError={(evt) => hideImageShowFallback(evt.currentTarget)}
      />
      <div className="placeholder" aria-hidden hidden>
        <span> </span>
      </div>
    </>
  );
}

export function InventoryGrid({
  items,
  selected,
  onToggle,
  itemClassName,
  className,
  pendingRevealIds,
  onReveal,
  canRevealItem,
  revealLoadingId,
  revealDisabled,
  emptyStateVisibility = 'visible',
}: InventoryGridProps) {
  const getRevealRect = (target: HTMLElement) => getInventoryRevealRect(target);

  if (!items.length) {
    if (emptyStateVisibility === 'none') return null;
    const isHidden = emptyStateVisibility === 'hidden';
    return (
      <div className={`muted small${isHidden ? ' empty-state--hidden' : ''}`} aria-hidden={isHidden}>
        No items yet.
      </div>
    );
  }

  const gridClassName = ['inventory', className].filter(Boolean).join(' ');

  return (
    <div className={gridClassName}>
      {items.map((item) => {
        const isReceipt = item.kind === 'certificate';
        const isPendingReveal = pendingRevealIds?.has(item.id) ?? false;
        const isPendingLocal = item.status === 'pending';
        const canSelect = !isReceipt && !isPendingReveal && !isPendingLocal;
        const isSelected = canSelect ? selected.has(item.id) : false;
        const canReveal = Boolean(isPendingReveal && onReveal && (canRevealItem ? canRevealItem(item) : true));
        const isRevealing = revealLoadingId === item.id;
        const revealEnabled = canReveal && selected.size === 0 && !revealDisabled && !isRevealing;
        const hasFooter = Boolean(item.assignedDudes?.length);
        const canInteract = canSelect || revealEnabled;
        const sizeLabel = dropMintSelectionLabel(getFrontendDrop(item.dropId), item.boxId ?? item.dudeId);
        const handleClick = canSelect
          ? () => onToggle(item.id)
          : revealEnabled
            ? (evt: MouseEvent<HTMLElement>) => {
                onReveal?.(item.id, getRevealRect(evt.currentTarget));
              }
            : undefined;
        return (
          <article
            key={item.id}
            data-inventory-id={item.id}
            className={[
              'inventory__item',
              item.kind === 'box' ? 'inventory__item--box' : '',
              canSelect ? 'inventory__item--selectable' : '',
              revealEnabled ? 'inventory__item--revealable' : '',
              isSelected ? 'inventory__item--selected' : '',
              hasFooter ? 'inventory__item--hasFooter' : '',
              isPendingReveal ? 'inventory__item--pending' : '',
              isReceipt ? 'inventory__item--receipt' : '',
              itemClassName || '',
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={handleClick}
            role={canInteract ? 'button' : undefined}
            tabIndex={canInteract ? 0 : undefined}
            draggable={false}
            onDragStart={(evt) => evt.preventDefault()}
            aria-pressed={canSelect ? isSelected : undefined}
            onKeyDown={
              canSelect || revealEnabled
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      if (canSelect) {
                        onToggle(item.id);
                      } else if (revealEnabled && onReveal) {
                        onReveal(item.id, getRevealRect(e.currentTarget as HTMLElement));
                      }
                    }
                  }
                : undefined
            }
          >
            <div className="inventory__media">
              <InventoryMedia item={item} />
            </div>
            {sizeLabel && isSelected ? (
              <span className="inventory__size-badge" aria-label={`Size ${sizeLabel}`}>
                {sizeLabel}
              </span>
            ) : null}
            {hasFooter ? (
              <div className="inventory__body">
                {!isPendingReveal && item.assignedDudes?.length ? (
                  <p className="muted">
                    Contains {dropAssetCount(getFrontendDrop(item.dropId), 'figure', item.assignedDudes.length)}
                  </p>
                ) : null}
                <div className="inventory__actions" />
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
