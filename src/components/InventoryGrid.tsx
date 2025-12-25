import { InventoryItem } from '../types';

interface InventoryGridProps {
  items: InventoryItem[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  itemClassName?: string;
  className?: string;
  pendingRevealIds?: Set<string>;
  onReveal?: (id: string) => void;
  revealLoadingId?: string | null;
  revealDisabled?: boolean;
  emptyStateVisibility?: 'visible' | 'hidden' | 'none';
}

export function InventoryGrid({
  items,
  selected,
  onToggle,
  itemClassName,
  className,
  pendingRevealIds,
  onReveal,
  revealLoadingId,
  revealDisabled,
  emptyStateVisibility = 'visible',
}: InventoryGridProps) {
  if (!items.length) {
    if (emptyStateVisibility === 'none') return null;
    const isHidden = emptyStateVisibility === 'hidden';
    return (
      <div className={`muted small${isHidden ? ' empty-state--hidden' : ''}`} aria-hidden={isHidden}>
        No items yet. Mint boxes to start.
      </div>
    );
  }

  const gridClassName = ['inventory', className].filter(Boolean).join(' ');

  return (
    <div className={gridClassName}>
      {items.map((item) => {
        const isReceipt = item.kind === 'certificate';
        const isPendingReveal = pendingRevealIds?.has(item.id) ?? false;
        const canSelect = !isReceipt && !isPendingReveal;
        const isSelected = canSelect ? selected.has(item.id) : false;
        const canReveal = Boolean(isPendingReveal && onReveal);
        const isRevealing = revealLoadingId === item.id;
        const revealEnabled = canReveal && selected.size === 0 && !revealDisabled && !isRevealing;
        const hasFooter = Boolean(item.assignedDudes?.length);
        const canInteract = canSelect || revealEnabled;
        const handleClick = canSelect ? () => onToggle(item.id) : revealEnabled ? () => onReveal?.(item.id) : undefined;
        return (
          <article
            key={item.id}
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
            aria-pressed={canSelect ? isSelected : undefined}
            onKeyDown={
              canSelect || revealEnabled
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      if (canSelect) {
                        onToggle(item.id);
                      } else if (revealEnabled && onReveal) {
                        onReveal(item.id);
                      }
                    }
                  }
                : undefined
            }
          >
            <div className="inventory__media">
              {item.image ? (
                isReceipt ? (
                  <img className="inventory__image" src={item.image} alt={item.name} loading="lazy" />
                ) : (
                  <div className="inventory__image" style={{ backgroundImage: `url(${item.image})` }} role="img" aria-label={item.name} />
                )
              ) : (
                <div className="placeholder" aria-hidden>
                  <span>#</span>
                </div>
              )}
            </div>
            {hasFooter ? (
              <div className="inventory__body">
                {!isPendingReveal && item.assignedDudes?.length ? (
                  <p className="muted">Contains {item.assignedDudes.length} figures</p>
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
