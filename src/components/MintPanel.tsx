import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { FaChevronRight } from 'react-icons/fa6';
import { MintStats } from '../types';
import { FRONTEND_DEPLOYMENT } from '../config/deployment';

interface MintPanelProps {
  stats?: MintStats;
  onMint: (quantity: number) => Promise<void>;
  busy: boolean;
  onError?: (message: string) => void;
  secondaryHref?: string;
  discountVisible?: boolean;
  discountLabel?: string;
  onDiscountClick?: () => void;
  discountBusy?: boolean;
}

/**
 * DEV: Override the "remaining" value for MintPanel UI testing.
 * Set to a number (e.g. 42) to force that remaining count.
 * Leave as `null` to use real backend/on-chain stats.
 */
const REMAINING_OVERRIDE: number | null = null;

type BoxPreviewLayout = { width: number; height: number; gapX: number; gapY: number; cols: number };

const BOX_ASPECT_RATIO = 1440 / 1030; // width / height (tight.webp)

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function calcBoxPreviewLayout(count: number, width: number, height: number): BoxPreviewLayout {
  const safeCount = Math.max(1, Math.min(15, Math.floor(count)));
  const safeWidth = Math.max(0, Math.floor(width));
  const safeHeight = Math.max(0, Math.floor(height));
  const gapScaleX = safeCount > 1 ? 1.8 : 1;
  const gapScaleY = safeCount > 1 ? 2 : 1;

  // Reasonable fallback before we know measured dimensions.
  if (!safeWidth || !safeHeight) {
    const fallbackHeight = 120;
    return {
      height: fallbackHeight,
      width: Math.max(1, Math.floor(fallbackHeight * BOX_ASPECT_RATIO)),
      gapX: 12 * gapScaleX,
      gapY: 12 * gapScaleY,
      cols: Math.min(safeCount, 4),
    };
  }

  // Let the preview container height dictate the maximum box size so the image can
  // actually fill the available space (especially for low quantities).
  const maxHeight = safeHeight;
  let best: BoxPreviewLayout = { height: 1, width: Math.max(1, Math.floor(BOX_ASPECT_RATIO)), gapX: 8, gapY: 8, cols: 1 };

  for (let cols = 1; cols <= safeCount; cols += 1) {
    const rows = Math.ceil(safeCount / cols);

    // Start with a conservative gap, then refine once based on the resulting size.
    let gapX = 12 * gapScaleX;
    let gapY = 12 * gapScaleY;
    let boxHeight = Math.min(
      (safeWidth - (cols - 1) * gapX) / (cols * BOX_ASPECT_RATIO),
      (safeHeight - (rows - 1) * gapY) / rows,
    );
    boxHeight = Math.min(boxHeight, maxHeight);
    const baseGap = clampNumber(Math.round(boxHeight * 0.08), 6, 14);
    gapX = baseGap * gapScaleX;
    gapY = baseGap * gapScaleY;
    boxHeight = Math.min(
      (safeWidth - (cols - 1) * gapX) / (cols * BOX_ASPECT_RATIO),
      (safeHeight - (rows - 1) * gapY) / rows,
    );
    boxHeight = Math.min(boxHeight, maxHeight);

    // Safety margin to avoid sub-pixel rounding clipping at some breakpoints.
    boxHeight = Math.floor(boxHeight) - 1;
    gapX = Math.max(0, Math.floor(gapX));
    gapY = Math.max(0, Math.floor(gapY));

    if (boxHeight < 1) continue;

    const boxWidth = Math.max(1, Math.floor(boxHeight * BOX_ASPECT_RATIO));

    if (boxHeight > best.height) {
      best = { width: boxWidth, height: boxHeight, gapX, gapY, cols };
      continue;
    }

    // Tie-breaker: prefer fewer rows (i.e. more columns) when size is the same.
    if (boxHeight === best.height) {
      const bestRows = Math.ceil(safeCount / best.cols);
      if (rows < bestRows) {
        best = { width: boxWidth, height: boxHeight, gapX, gapY, cols };
      }
    }
  }

  return best;
}

export function MintPanel({
  stats,
  onMint,
  busy,
  onError,
  secondaryHref,
  discountVisible,
  discountLabel,
  onDiscountClick,
  discountBusy,
}: MintPanelProps) {
  const minted = stats?.minted ?? 0;
  const total = stats?.total ?? FRONTEND_DEPLOYMENT.maxSupply;
  const computedRemaining = stats?.remaining ?? Math.max(0, total - minted);
  const remaining = REMAINING_OVERRIDE === null ? computedRemaining : Math.max(0, Math.floor(REMAINING_OVERRIDE));
  const remainingReady = REMAINING_OVERRIDE !== null || Boolean(stats);
  const maxPerTx = stats?.maxPerTx ?? FRONTEND_DEPLOYMENT.maxPerTx;
  const [quantity, setQuantity] = useState(1);
  const maxSelectable = Math.min(maxPerTx, remaining);
  const showQuantitySlider = maxSelectable > 1;
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
    try {
      await onMint(quantity);
      setQuantity(1);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to mint';
      if (onError) onError(message);
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
  const showDiscountButton = Boolean(discountVisible) && !soldOut;
  const discountText = discountLabel || 'mint one for 0.55 SOL';

  return (
    <section className="card mint-panel">
      <div className="mint-panel__preview">
        <div
          ref={previewRef}
          className="mint-panel__boxes"
          style={{
            ['--box-width' as never]: `${layout.width}px`,
            ['--box-height' as never]: `${layout.height}px`,
            ['--box-gap-x' as never]: `${layout.gapX}px`,
            ['--box-gap-y' as never]: `${layout.gapY}px`,
            ['--box-cols' as never]: String(layout.cols),
          }}
          aria-label={`Mint preview: ${quantityLabel}`}
        >
          {Array.from({ length: quantity }, (_, idx) => (
            <img
              key={idx}
              className="mint-panel__box"
              src={`${FRONTEND_DEPLOYMENT.paths.base}/box/tight.webp`}
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
            <div
              className={remainingReady ? 'mint-panel__remaining' : 'mint-panel__remaining mint-panel__remaining--hidden'}
              aria-hidden={!remainingReady}
            >
            Minted out
            </div>
          </div>
          {secondaryHref ? (
            <div className="mint-panel__cta">
              <a className="mint-panel__secondary" href={secondaryHref} target="_blank" rel="noreferrer">
                <span className="mint-panel__secondary-text">Secondary</span>
                <FaChevronRight className="mint-panel__secondary-icon" aria-hidden="true" focusable="false" size={14} />
              </a>
            </div>
          ) : null}
        </div>
      ) : (
        <div className={showQuantitySlider ? 'mint-panel__footer' : 'mint-panel__footer mint-panel__footer--no-slider'}>
          <div className="mint-panel__info">
            <div className="mint-panel__price">Little Swag Boxes</div>
            <div
              className={remainingReady ? 'mint-panel__remaining' : 'mint-panel__remaining mint-panel__remaining--hidden'}
              aria-hidden={!remainingReady}
            >
              {remaining} / {total} left
            </div>
          </div>
          <form
            id={formId}
            className={showQuantitySlider ? 'mint-panel__slider' : 'mint-panel__slider mint-panel__slider--hidden'}
            onSubmit={handleMint}
          >
            {showQuantitySlider ? (
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
            ) : null}
          </form>
          <div className="mint-panel__cta">
            <div className="mint-panel__cta-stack">
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
                    <span className="mint-panel__submit-price">{totalPriceLabel} SOL</span>
                  </>
                )}
              </button>
              {showDiscountButton ? (
                <button type="button" className="mint-panel__discount ghost" onClick={onDiscountClick} disabled={discountBusy}>
                  <span className="mint-panel__discount-text">{discountText}</span>
                </button>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
