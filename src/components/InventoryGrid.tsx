import { InventoryItem } from '../types';

interface InventoryGridProps {
  items: InventoryItem[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onOpenBox?: (item: InventoryItem) => void;
}

export function InventoryGrid({ items, selected, onToggle, onOpenBox }: InventoryGridProps) {
  if (!items.length) {
    return <div className="card subtle">No items yet. Mint boxes to start.</div>;
  }

  return (
    <div className="inventory">
      {items.map((item) => {
        const isBox = item.kind === 'box';
        const canSelect = item.kind !== 'certificate';
        const isSelected = canSelect ? selected.has(item.id) : false;
        const hasFooter = Boolean(item.assignedDudes?.length || (isBox && onOpenBox));
        return (
          <article
            key={item.id}
            className={[
              'inventory__item',
              canSelect ? 'inventory__item--selectable' : '',
              isSelected ? 'inventory__item--selected' : '',
              hasFooter ? 'inventory__item--hasFooter' : '',
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
                <div className="inventory__image" style={{ backgroundImage: `url(${item.image})` }} role="img" aria-label={item.name} />
              ) : (
                <div className="placeholder" aria-hidden>
                  <span>#</span>
                </div>
              )}
            </div>
            {hasFooter ? (
              <div className="inventory__body">
                {item.assignedDudes?.length ? (
                  <p className="muted">Contains {item.assignedDudes.length} dudes</p>
                ) : null}
                <div className="inventory__actions">
                  {isBox && onOpenBox ? (
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
                </div>
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
