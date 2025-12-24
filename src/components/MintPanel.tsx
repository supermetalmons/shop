import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { MintStats } from '../types';
import { FRONTEND_DEPLOYMENT } from '../config/deployment';

interface MintPanelProps {
  stats?: MintStats;
  onMint: (quantity: number) => Promise<void>;
  busy: boolean;
}

type BoxPreviewLayout = { size: number; gap: number; cols: number };

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function calcBoxPreviewLayout(count: number, width: number, height: number): BoxPreviewLayout {
  const safeCount = Math.max(1, Math.min(15, Math.floor(count)));
  const safeWidth = Math.max(0, Math.floor(width));
  const safeHeight = Math.max(0, Math.floor(height));

  // Reasonable fallback before we know measured dimensions.
  if (!safeWidth || !safeHeight) {
    return { size: 120, gap: 12, cols: Math.min(safeCount, 4) };
  }

  const maxSize = Math.min(260, safeHeight);
  let best: BoxPreviewLayout = { size: 1, gap: 8, cols: 1 };

  for (let cols = 1; cols <= safeCount; cols += 1) {
    const rows = Math.ceil(safeCount / cols);

    // Start with a conservative gap, then refine once based on the resulting size.
    let gap = 12;
    let size = Math.min(
      (safeWidth - (cols - 1) * gap) / cols,
      (safeHeight - (rows - 1) * gap) / rows,
    );
    size = Math.min(size, maxSize);
    gap = clampNumber(Math.round(size * 0.08), 6, 14);
    size = Math.min(
      (safeWidth - (cols - 1) * gap) / cols,
      (safeHeight - (rows - 1) * gap) / rows,
    );
    size = Math.min(size, maxSize);

    // Safety margin to avoid sub-pixel rounding clipping at some breakpoints.
    size = Math.floor(size) - 1;
    gap = Math.max(0, Math.floor(gap));

    if (size < 1) continue;

    if (size > best.size) {
      best = { size, gap, cols };
      continue;
    }

    // Tie-breaker: prefer fewer rows (i.e. more columns) when size is the same.
    if (size === best.size) {
      const bestRows = Math.ceil(safeCount / best.cols);
      if (rows < bestRows) {
        best = { size, gap, cols };
      }
    }
  }

  return best;
}

export function MintPanel({ stats, onMint, busy }: MintPanelProps) {
  const minted = stats?.minted ?? 0;
  const total = stats?.total ?? FRONTEND_DEPLOYMENT.maxSupply;
  const remaining = stats?.remaining ?? Math.max(0, total - minted);
  const maxPerTx = stats?.maxPerTx ?? FRONTEND_DEPLOYMENT.maxPerTx;
  const [quantity, setQuantity] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const maxSelectable = Math.min(maxPerTx, remaining);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const [previewBounds, setPreviewBounds] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  useEffect(() => {
    if (maxSelectable < 1) return;
    setQuantity((prev) => (prev > maxSelectable ? maxSelectable : prev));
  }, [maxSelectable]);

  useEffect(() => {
    const el = previewRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;

    const update = () => {
      // Use client size to avoid sub-pixel rounding surprises.
      const width = el.clientWidth;
      const height = el.clientHeight;
      setPreviewBounds((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    };

    update();
    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleMint = async (evt: FormEvent) => {
    evt.preventDefault();
    if (quantity < 1 || quantity > maxPerTx) return;
    setError(null);
    try {
      await onMint(quantity);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mint');
    }
  };

  const soldOut = remaining <= 0;
  const layout = useMemo(
    () => calcBoxPreviewLayout(quantity, previewBounds.width, previewBounds.height),
    [quantity, previewBounds.height, previewBounds.width],
  );
  const quantityLabel = `${quantity} box${quantity === 1 ? '' : 'es'}`;
  const totalPriceLabel = String(quantity);
  const formId = 'mint-form';

  return (
    <section className="card mint-panel">
      <div className="mint-panel__preview">
        <div
          ref={previewRef}
          className="mint-panel__boxes"
          style={{
            ['--box-size' as never]: `${layout.size}px`,
            ['--box-gap' as never]: `${layout.gap}px`,
            ['--box-cols' as never]: String(layout.cols),
          }}
          aria-label={`Mint preview: ${quantityLabel}`}
        >
          {Array.from({ length: quantity }, (_, idx) => (
            <img
              key={idx}
              className="mint-panel__box"
              src={`${FRONTEND_DEPLOYMENT.paths.base}/box/default.webp`}
              alt=""
              aria-hidden="true"
            />
          ))}
        </div>
      </div>
      {soldOut ? (
        <div className="mint-panel__footer mint-panel__footer--soldout">
          <div className="mint-panel__info">
          <div className="mint-panel__price">Little Swag Boxes</div>
            <div className="mint-panel__remaining">
            {remaining} / {total} left
            </div>
          </div>
          <div className="mint-panel__soldout">Sold out. Jump to secondary or standby for next drop.</div>
        </div>
      ) : (
        <div className="mint-panel__footer">
          <div className="mint-panel__info">
            <div className="mint-panel__price">Little Swag Boxes</div>
            <div className="mint-panel__remaining">
              {remaining} / {total} left
            </div>
          </div>
          <form id={formId} className="mint-panel__slider" onSubmit={handleMint}>
            <label className="mint-panel__label">
              <span className="mint-panel__label-text muted small">{quantityLabel}</span>
              <input
                type="range"
                min={1}
                max={maxSelectable}
                value={quantity}
                onChange={(evt) => setQuantity(parseInt(evt.target.value, 10))}
                disabled={busy}
              />
            </label>
            {error ? <div className="error">{error}</div> : null}
          </form>
          <div className="mint-panel__cta">
            <button
              type="submit"
              form={formId}
              className={busy ? 'mint-panel__submit mint-panel__submit--busy' : 'mint-panel__submit'}
              disabled={busy || quantity < 1 || quantity > maxSelectable}
            >
              {busy ? (
                <span className="mint-panel__submit-text">Minting…</span>
              ) : (
                <>
                  <span className="mint-panel__submit-text">Mint</span>
                  <span className="mint-panel__submit-price">{totalPriceLabel} sol</span>
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
