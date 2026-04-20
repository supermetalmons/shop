import { FormEvent, Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { FaChevronRight, FaCircleQuestion } from 'react-icons/fa6';
import { MintStats } from '../types';
import { dropAssetCount } from '../lib/dropLabels';
import { hideImageShowFallback, showImageHideFallback } from '../lib/imageFallback';
import type { MintSelectionConfig } from '../config/deployment';
import { deriveMintSelectionAvailabilityFromConfig } from '../lib/boxMinter';

interface MintPanelProps {
  stats?: MintStats;
  onMint: (quantity: number, variantKey?: string) => Promise<void>;
  busy: boolean;
  onError?: (message: string) => void;
  title?: string;
  boxImageSrc?: string;
  boxAspectRatio?: number;
  boxNamePrefix?: string;
  priceSol: number;
  discountPriceSol: number;
  maxSupply: number;
  maxPerTx: number;
  secondaryHref?: string;
  discountVisible?: boolean;
  discountLabel?: string;
  discountMaxQuantity?: number;
  onDiscountClick?: (quantity: number, variantKey?: string) => void | Promise<void>;
  discountBusy?: boolean;
  mintSelection?: MintSelectionConfig;
  showSizeInfo?: boolean;
}

/**
 * DEV: Override the "remaining" value for MintPanel UI testing.
 * Set to a number (e.g. 42) to force that remaining count.
 * Leave as `null` to use real backend/on-chain stats.
 */
const REMAINING_OVERRIDE: number | null = null;

type BoxPreviewLayout = { width: number; height: number; gapX: number; gapY: number; cols: number };

const BOX_ASPECT_RATIO = 1440 / 1030; // width / height (tight.webp)
const LAMPORTS_PER_SOL_UI = 1_000_000_000;

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeSolAmount(value: number | undefined, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return numeric;
}

function solAmountToLamports(value: number | undefined, fallback: number): number {
  return Math.round(normalizeSolAmount(value, fallback) * LAMPORTS_PER_SOL_UI);
}

function formatSolAmount(value: number): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return '0';
  return numeric.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 9,
    useGrouping: false,
  });
}

function calcBoxPreviewLayout(count: number, width: number, height: number, boxAspectRatio: number): BoxPreviewLayout {
  const safeCount = Math.max(1, Math.min(15, Math.floor(count)));
  const safeWidth = Math.max(0, Math.floor(width));
  const safeHeight = Math.max(0, Math.floor(height));
  const aspectRatio = clampNumber(boxAspectRatio || BOX_ASPECT_RATIO, 0.25, 4);
  const gapScaleX = safeCount > 1 ? 1.8 : 1;
  const gapScaleY = safeCount > 1 ? 2 : 1;

  // Reasonable fallback before we know measured dimensions.
  if (!safeWidth || !safeHeight) {
    const fallbackHeight = 120;
    return {
      height: fallbackHeight,
      width: Math.max(1, Math.floor(fallbackHeight * aspectRatio)),
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
      (safeWidth - (cols - 1) * gapX) / (cols * aspectRatio),
      (safeHeight - (rows - 1) * gapY) / rows,
    );
    boxHeight = Math.min(boxHeight, maxHeight);
    const baseGap = clampNumber(Math.round(boxHeight * 0.08), 6, 14);
    gapX = baseGap * gapScaleX;
    gapY = baseGap * gapScaleY;
    boxHeight = Math.min(
      (safeWidth - (cols - 1) * gapX) / (cols * aspectRatio),
      (safeHeight - (rows - 1) * gapY) / rows,
    );
    boxHeight = Math.min(boxHeight, maxHeight);

    // Safety margin to avoid sub-pixel rounding clipping at some breakpoints.
    boxHeight = Math.floor(boxHeight) - 1;
    gapX = Math.max(0, Math.floor(gapX));
    gapY = Math.max(0, Math.floor(gapY));

    if (boxHeight < 1) continue;

    const boxWidth = Math.max(1, Math.floor(boxHeight * aspectRatio));

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
  title,
  boxImageSrc,
  boxAspectRatio,
  boxNamePrefix,
  priceSol,
  discountPriceSol,
  maxSupply,
  maxPerTx,
  secondaryHref,
  discountVisible,
  discountLabel,
  discountMaxQuantity,
  onDiscountClick,
  discountBusy,
  mintSelection,
  showSizeInfo,
}: MintPanelProps) {
  const minted = stats?.minted ?? 0;
  const total = stats?.total ?? maxSupply;
  const computedRemaining = stats?.remaining ?? Math.max(0, total - minted);
  const remaining = REMAINING_OVERRIDE === null ? computedRemaining : Math.max(0, Math.floor(REMAINING_OVERRIDE));
  const remainingReady = REMAINING_OVERRIDE !== null || Boolean(stats);
  const maxSelectablePerTx = stats?.maxPerTx ?? maxPerTx;
  const sizeSelection = mintSelection?.kind === 'size' ? mintSelection : undefined;
  const sizeOptions = sizeSelection?.options ?? [];
  const sizeAvailability = useMemo(
    () => stats?.mintSelectionAvailability ?? deriveMintSelectionAvailabilityFromConfig(sizeSelection) ?? {},
    [stats?.mintSelectionAvailability, sizeSelection],
  );
  const [quantity, setQuantity] = useState(1);
  const maxSelectable = Math.min(maxSelectablePerTx, remaining);
  const showSizeSelector = Boolean(sizeSelection);
  const showQuantitySlider = !showSizeSelector && maxSelectable > 1;
  const showFormControls = showQuantitySlider || showSizeSelector;
  const [selectedSize, setSelectedSize] = useState<string | null>(null);
  // Bumping this token forces the size buttons to re-mount so the blink
  // animation restarts even when the user clicks Mint repeatedly.
  const [sizeBlinkToken, setSizeBlinkToken] = useState(0);
  // The blink class must only be applied for the duration of the animation —
  // otherwise selecting a different size later flips the previously selected
  // button back into the blink selector and re-triggers the animation.
  const [isBlinking, setIsBlinking] = useState(false);
  const [sizeInfoOpen, setSizeInfoOpen] = useState(false);
  const sizeInfoRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const [previewBounds, setPreviewBounds] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  useEffect(() => {
    if (showSizeSelector) setQuantity(1);
  }, [showSizeSelector]);

  useEffect(() => {
    if (!showSizeSelector) setSelectedSize(null);
  }, [showSizeSelector]);

  useEffect(() => {
    if (sizeBlinkToken === 0) return;
    setIsBlinking(true);
    // Matches the CSS animation duration (2 iterations × 0.18s) with a small buffer
    // so the class is removed only after the final pulse settles.
    const handle = window.setTimeout(() => setIsBlinking(false), 460);
    return () => window.clearTimeout(handle);
  }, [sizeBlinkToken]);

  // Picking a size should immediately silence the attention blink — otherwise the
  // remaining unselected pill keeps pulsing for the rest of the animation window.
  useEffect(() => {
    if (selectedSize) setIsBlinking(false);
  }, [selectedSize]);

  useEffect(() => {
    if (!selectedSize) return;
    if ((sizeAvailability[selectedSize] ?? 0) > 0) return;
    setSelectedSize(null);
  }, [selectedSize, sizeAvailability]);

  useEffect(() => {
    if (maxSelectable < 1) return;
    setQuantity((prev) => (prev > maxSelectable ? maxSelectable : prev));
  }, [maxSelectable]);

  useEffect(() => {
    if (!showSizeSelector && sizeInfoOpen) setSizeInfoOpen(false);
  }, [showSizeSelector, sizeInfoOpen]);

  useEffect(() => {
    if (!sizeInfoOpen) return;
    const onPointerDown = (evt: MouseEvent) => {
      const root = sizeInfoRef.current;
      if (!root) return;
      if (!root.contains(evt.target as Node)) {
        setSizeInfoOpen(false);
      }
    };
    const onKeyDown = (evt: KeyboardEvent) => {
      if (evt.key === 'Escape') setSizeInfoOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [sizeInfoOpen]);

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
    if (showSizeSelector && !selectedSize) {
      setSizeBlinkToken((prev) => prev + 1);
      return;
    }
    if (quantity < 1 || quantity > maxSelectablePerTx) return;
    try {
      await onMint(quantity, selectedSize || undefined);
      setSelectedSize(null);
      setQuantity(1);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to mint';
      if (onError) onError(message);
    }
  };

  const soldOut = remaining <= 0;
  const layout = useMemo(
    () => calcBoxPreviewLayout(quantity, previewBounds.width, previewBounds.height, boxAspectRatio || BOX_ASPECT_RATIO),
    [boxAspectRatio, quantity, previewBounds.height, previewBounds.width],
  );
  const quantityLabel = dropAssetCount({ namePrefix: boxNamePrefix, figureNamePrefix: undefined }, 'box', quantity);
  const unitPriceLamports = solAmountToLamports(priceSol, priceSol);
  const unitDiscountPriceLamports = solAmountToLamports(discountPriceSol, discountPriceSol);
  const totalPriceLabel = formatSolAmount((unitPriceLamports * quantity) / LAMPORTS_PER_SOL_UI);
  const formId = 'mint-form';
  const normalizedDiscountMaxQuantity =
    Number.isFinite(Number(discountMaxQuantity)) && Number(discountMaxQuantity) > 0
      ? Math.floor(Number(discountMaxQuantity))
      : undefined;
  const exceedsDiscountAllowance = normalizedDiscountMaxQuantity !== undefined && quantity > normalizedDiscountMaxQuantity;
  const showDiscountButton = Boolean(discountVisible) && !soldOut && !exceedsDiscountAllowance;
  const discountText =
    discountLabel || `Mint ${quantityLabel} for ${formatSolAmount((unitDiscountPriceLamports * quantity) / LAMPORTS_PER_SOL_UI)} SOL`;
  const mintTitle = title || 'Little Swag Boxes';
  const mintBoxImageSrc = boxImageSrc;

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
            mintBoxImageSrc ? (
              <Fragment key={idx}>
                <img
                  className="mint-panel__box"
                  src={mintBoxImageSrc}
                  alt=""
                  aria-hidden="true"
                  draggable={false}
                  onDragStart={(evt) => evt.preventDefault()}
                  onLoad={(evt) => showImageHideFallback(evt.currentTarget)}
                  onError={(evt) => hideImageShowFallback(evt.currentTarget)}
                />
                <div
                  className="mint-panel__box mint-panel__box--placeholder"
                  aria-hidden="true"
                  hidden
                />
              </Fragment>
            ) : (
              <div key={idx} className="mint-panel__box mint-panel__box--placeholder" aria-hidden="true" />
            )
          ))}
        </div>
      </div>
      {soldOut ? (
        <div className="mint-panel__footer mint-panel__footer--soldout">
          <div className="mint-panel__info">
          <div className="mint-panel__price">{mintTitle}</div>
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
        <div className={showFormControls ? 'mint-panel__footer' : 'mint-panel__footer mint-panel__footer--no-slider'}>
          <div className="mint-panel__info">
            <div className="mint-panel__price">{mintTitle}</div>
            <div
              className={remainingReady ? 'mint-panel__remaining' : 'mint-panel__remaining mint-panel__remaining--hidden'}
              aria-hidden={!remainingReady}
            >
              {remaining} / {total} left
            </div>
          </div>
          <form
            id={formId}
            className={showFormControls ? 'mint-panel__slider' : 'mint-panel__slider mint-panel__slider--hidden'}
            onSubmit={handleMint}
          >
            {showSizeSelector ? (
              <div className="mint-panel__sizes-row">
                <div
                  key={sizeBlinkToken}
                  className={
                    isBlinking
                      ? 'mint-panel__sizes mint-panel__sizes--blink'
                      : 'mint-panel__sizes'
                  }
                  role="radiogroup"
                  aria-label="Hoodie size"
                >
                  {sizeOptions.map((size) => {
                    const selected = selectedSize === size.key;
                    const unavailable = (sizeAvailability[size.key] ?? 0) <= 0;
                    const classes = ['mint-panel__size'];
                    if (selected) classes.push('mint-panel__size--selected');
                    if (unavailable) classes.push('mint-panel__size--unavailable');
                    return (
                      <button
                        key={size.key}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        aria-disabled={unavailable || undefined}
                        title={unavailable ? 'Currently unavailable' : `${sizeAvailability[size.key] ?? 0} left`}
                        className={classes.join(' ')}
                        onClick={() => {
                          if (unavailable) return;
                          setSelectedSize((prev) => (prev === size.key ? null : size.key));
                        }}
                        disabled={busy || unavailable}
                      >
                        {size.label}
                      </button>
                    );
                  })}
                </div>
                {showSizeInfo ? (
                  <div className="mint-panel__size-info-wrap" ref={sizeInfoRef}>
                    <button
                      type="button"
                      className="mint-panel__size-info"
                      aria-label="Size info"
                      aria-expanded={sizeInfoOpen}
                      aria-haspopup="dialog"
                      onClick={() => setSizeInfoOpen((prev) => !prev)}
                    >
                      <FaCircleQuestion aria-hidden="true" focusable="false" size={16} />
                    </button>
                    {sizeInfoOpen ? (
                      <div
                        className="mint-panel__size-popover"
                        role="dialog"
                        aria-label="Hoodie sizing"
                      >
                        <table className="mint-panel__size-table">
                          <thead>
                            <tr>
                              <th scope="col" aria-label="Size" />
                              <th scope="col">Body Length</th>
                              <th scope="col">Chest Width</th>
                              <th scope="col">Sleeve Length</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr>
                              <th scope="row">L</th>
                              <td>28 1/2</td>
                              <td>25 1/2</td>
                              <td>24 3/4</td>
                            </tr>
                            <tr>
                              <th scope="row">XL</th>
                              <td>29 1/2</td>
                              <td>27 1/2</td>
                              <td>25 1/4</td>
                            </tr>
                            <tr>
                              <th scope="row">2XL</th>
                              <td>30 1/2</td>
                              <td>29 1/2</td>
                              <td>26</td>
                            </tr>
                          </tbody>
                        </table>
                        <p className="mint-panel__size-quote">
                          No returns; please choose your size carefully.
                        </p>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : showQuantitySlider ? (
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
                <button
                  type="button"
                  className="mint-panel__discount ghost"
                  onClick={() => {
                    if (showSizeSelector && !selectedSize) {
                      setSizeBlinkToken((prev) => prev + 1);
                      return;
                    }
                    if (!onDiscountClick) return;
                    void onDiscountClick(quantity, selectedSize || undefined);
                  }}
                  disabled={discountBusy || quantity < 1 || quantity > maxSelectable || exceedsDiscountAllowance}
                >
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
