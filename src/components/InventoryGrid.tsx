import { InventoryItem } from '../types';

interface InventoryGridProps {
  items: InventoryItem[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onOpenBox?: (item: InventoryItem) => void;
  itemClassName?: string;
  className?: string;
  pendingRevealIds?: Set<string>;
  onReveal?: (id: string) => void;
  revealLoadingId?: string | null;
  revealDisabled?: boolean;
}

export function InventoryGrid({
  items,
  selected,
  onToggle,
  onOpenBox,
  itemClassName,
  className,
  pendingRevealIds,
  onReveal,
  revealLoadingId,
  revealDisabled,
}: InventoryGridProps) {
  if (!items.length) {
    return <div className="muted small">No items yet. Mint boxes to start.</div>;
  }

  const gridClassName = ['inventory', className].filter(Boolean).join(' ');

  return (
    <div className={gridClassName}>
      {items.map((item) => {
        const isBox = item.kind === 'box';
        const isReceipt = item.kind === 'certificate';
        const isPendingReveal = pendingRevealIds?.has(item.id) ?? false;
        const canSelect = !isReceipt && !isPendingReveal;
        const isSelected = canSelect ? selected.has(item.id) : false;
        const canOpen = Boolean(isBox && onOpenBox && !isPendingReveal);
        const canReveal = Boolean(isPendingReveal && onReveal);
        const hasFooter = Boolean(item.assignedDudes?.length || canOpen || canReveal);
        const isRevealing = revealLoadingId === item.id;
        return (
          <article
            key={item.id}
            className={[
              'inventory__item',
              canSelect ? 'inventory__item--selectable' : '',
              isSelected ? 'inventory__item--selected' : '',
              hasFooter ? 'inventory__item--hasFooter' : '',
              isPendingReveal ? 'inventory__item--pending' : '',
              isReceipt ? 'inventory__item--receipt' : '',
              itemClassName || '',
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={canSelect ? () => onToggle(item.id) : undefined}
            role={canSelect ? 'button' : undefined}
            tabIndex={canSelect ? 0 : undefined}
            aria-pressed={canSelect ? isSelected : undefined}
            onKeyDown={
              canSelect
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onToggle(item.id);
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
                  <p className="muted">Contains {item.assignedDudes.length} dudes</p>
                ) : null}
                <div className="inventory__actions">
                  {canOpen ? (
                    <button
                      className="inventory__open"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenBox(item);
                      }}
                    >
                      Open
                    </button>
                  ) : null}
                  {canReveal ? (
                    <button
                      className="inventory__open"
                      onClick={(e) => {
                        e.stopPropagation();
                        onReveal(item.id);
                      }}
                      disabled={Boolean(revealDisabled) || isRevealing}
                    >
                      {isRevealing ? 'Revealing…' : 'Reveal dudes'}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
