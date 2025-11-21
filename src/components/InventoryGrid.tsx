import { InventoryItem } from '../types';

interface InventoryGridProps {
  items: InventoryItem[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onOpenBox?: (item: InventoryItem) => void;
}

const typeCopy: Record<InventoryItem['kind'], string> = {
  box: 'Blind box',
  dude: 'Dude',
  certificate: 'Certificate',
};

export function InventoryGrid({ items, selected, onToggle, onOpenBox }: InventoryGridProps) {
  if (!items.length) {
    return <div className="card subtle">No items yet. Mint boxes to start.</div>;
  }

  return (
    <div className="inventory">
      {items.map((item) => {
        const isBox = item.kind === 'box';
        const checked = selected.has(item.id);
        return (
          <article key={item.id} className="inventory__item">
            <header>
              <div className="pill">{typeCopy[item.kind]}</div>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggle(item.id)}
                  aria-label={`Select ${item.name}`}
                />
                <span />
              </label>
            </header>
            <div className="inventory__media">
              {item.image ? (
                <img src={item.image} alt={item.name} loading="lazy" />
              ) : (
                <div className="placeholder" aria-hidden>
                  <span>#</span>
                </div>
              )}
            </div>
            <div className="inventory__body">
              <h3>{item.name}</h3>
              {item.assignedDudes?.length ? (
                <p className="muted">Contains {item.assignedDudes.length} dudes</p>
              ) : null}
              <div className="inventory__actions">
                {isBox && onOpenBox ? (
                  <button className="ghost" onClick={() => onOpenBox(item)}>
                    Open box
                  </button>
                ) : null}
                <span className="muted small">{item.id.slice(0, 4)}…{item.id.slice(-4)}</span>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
