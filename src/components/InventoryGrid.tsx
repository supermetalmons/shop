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
        const canSelect = item.kind !== 'certificate';
        const checked = canSelect ? selected.has(item.id) : false;
        return (
          <article key={item.id} className="inventory__item">
            <header>
              <div className="pill">{typeCopy[item.kind]}</div>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!canSelect}
                  onChange={canSelect ? () => onToggle(item.id) : undefined}
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
                    Start opening
                  </button>
                ) : null}
                <span className="muted small">{item.id.slice(0, 4)}…{item.id.slice(-4)}</span>
              </div>
              {!canSelect ? <p className="muted small">Certificates are already delivery outputs.</p> : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}
