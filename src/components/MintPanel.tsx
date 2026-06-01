import {
  CSSProperties,
  DependencyList,
  FormEvent,
  Fragment,
  RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { FaCircleQuestion } from 'react-icons/fa6';
import { MintStats } from '../types';
import { dropAssetCount } from '../lib/dropLabels';
import { hideImageShowFallback, showImageHideFallback } from '../lib/imageFallback';
import { secondaryMarketplaceLinksForDropId, type MintSelectionConfig } from '../config/deployment';
import { deriveMintSelectionAvailabilityFromConfig } from '../lib/boxMinter';

type MintPanelTerminalButton = {
  key?: string;
  buttonText: string;
  href?: string;
  onClick?: () => void;
};

type MintPanelTerminalAction = {
  statusText: string;
  buttonText?: string;
  href?: string;
  onClick?: () => void;
  buttons?: MintPanelTerminalButton[];
};

interface MintPanelProps {
  stats?: MintStats;
  onMint: (quantity: number, variantKey?: string) => void | Promise<void>;
  busy: boolean;
  onError?: (message: string) => void;
  title?: string;
  boxImageSrc?: string;
  boxAspectRatio?: number;
  boxNamePrefix?: string;
  dropId?: string;
  priceSol: number;
  discountPriceSol: number;
  maxSupply: number;
  maxPerTx: number;
  discountAvailable?: boolean;
  discountMaxQuantity?: number;
  onDiscountMint?: (quantity: number, variantKey?: string) => void | Promise<void>;
  discountBusy?: boolean;
  onStripePaymentClick?: (variantKey?: string) => void | Promise<void>;
  stripePaymentVisible?: boolean;
  stripePaymentBusy?: boolean;
  stripePaymentPriceLabel?: string;
  mintSelection?: MintSelectionConfig;
  showSizeInfo?: boolean;
  successfulMintToken?: number;
  terminalAction?: MintPanelTerminalAction;
}

/**
 * DEV: Override the "remaining" value for MintPanel UI testing.
 * Set to a number (e.g. 42) to force that remaining count.
 * Leave as `null` to use real backend/on-chain stats.
 */
const REMAINING_OVERRIDE: number | null = null;

type BoxPreviewLayout = { width: number; height: number; gapX: number; gapY: number; cols: number };

const BOX_ASPECT_RATIO = 1440 / 1030; // width / height (tight.webp)
const BOX_MAX_RELATIVE_HEIGHT = 0.777;
const LAMPORTS_PER_SOL_UI = 1_000_000_000;
const STRIPE_CHECKOUT_QUANTITY = 1;
const ACTION_TEXT_FIT_MIN_SCALE = 0.62;
const ACTION_TEXT_FIT_SAFETY_PX = 8;
const ACTION_TEXT_FIT_TOLERANCE = 0.004;

const ACTION_TEXT_FIT_DEFAULT = {
  scale: 1,
  labelFontSizePx: 0,
  priceFontSizePx: 0,
  labelLetterSpacingPx: 0,
};

const ACTION_TEXT_FIT_STYLE_PROPS = [
  '--mint-panel-action-fit-label-font-size',
  '--mint-panel-action-fit-price-font-size',
  '--mint-panel-action-fit-letter-spacing',
] as const;

type ActionTextFit = typeof ACTION_TEXT_FIT_DEFAULT;

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseCssPixelValue(value: string): number {
  const numeric = parseFloat(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function roundCssPixelValue(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function actionFitElementWidth(el: HTMLElement): number {
  const rect = el.getBoundingClientRect();
  return Math.max(rect.width, el.scrollWidth);
}

function clearInlineActionTextFitStyles(el: HTMLElement): Map<(typeof ACTION_TEXT_FIT_STYLE_PROPS)[number], string> {
  const previousValues = new Map<(typeof ACTION_TEXT_FIT_STYLE_PROPS)[number], string>();
  for (const prop of ACTION_TEXT_FIT_STYLE_PROPS) {
    previousValues.set(prop, el.style.getPropertyValue(prop));
    el.style.removeProperty(prop);
  }
  return previousValues;
}

function restoreInlineActionTextFitStyles(
  el: HTMLElement,
  previousValues: Map<(typeof ACTION_TEXT_FIT_STYLE_PROPS)[number], string>,
) {
  for (const prop of ACTION_TEXT_FIT_STYLE_PROPS) {
    const value = previousValues.get(prop) || '';
    if (value) {
      el.style.setProperty(prop, value);
    } else {
      el.style.removeProperty(prop);
    }
  }
}

function calcActionTextFit(el: HTMLElement): ActionTextFit {
  const previousValues = clearInlineActionTextFitStyles(el);

  try {
    const fitElements = Array.from(el.querySelectorAll<HTMLElement>('[data-mint-action-fit]')).filter((node) => {
      const rect = node.getBoundingClientRect();
      return actionFitElementWidth(node) > 0 && rect.height > 0;
    });
    if (!fitElements.length) return ACTION_TEXT_FIT_DEFAULT;

    const buttonStyle = window.getComputedStyle(el);
    const paddingX = parseCssPixelValue(buttonStyle.paddingLeft) + parseCssPixelValue(buttonStyle.paddingRight);
    const columnGap = fitElements.length > 1 ? parseCssPixelValue(buttonStyle.columnGap) * (fitElements.length - 1) : 0;
    const availableWidth = Math.max(0, el.clientWidth - paddingX - columnGap - ACTION_TEXT_FIT_SAFETY_PX);
    const naturalWidth = fitElements.reduce((total, node) => total + actionFitElementWidth(node), 0);

    if (!availableWidth || !naturalWidth || naturalWidth <= availableWidth) return ACTION_TEXT_FIT_DEFAULT;

    const scale = clampNumber(availableWidth / naturalWidth, ACTION_TEXT_FIT_MIN_SCALE, 1);
    const labelEl = fitElements.find((node) => node.dataset.mintActionFit === 'label') || fitElements[0];
    const priceEl = fitElements.find((node) => node.dataset.mintActionFit === 'price');
    const labelStyle = window.getComputedStyle(labelEl);
    const priceStyle = priceEl ? window.getComputedStyle(priceEl) : null;
    const labelFontSizePx = parseCssPixelValue(labelStyle.fontSize);
    const priceFontSizePx = priceStyle ? parseCssPixelValue(priceStyle.fontSize) : 0;
    const labelLetterSpacingPx = parseCssPixelValue(labelStyle.letterSpacing);

    return {
      scale,
      labelFontSizePx: roundCssPixelValue(labelFontSizePx * scale),
      priceFontSizePx: roundCssPixelValue(priceFontSizePx * scale),
      labelLetterSpacingPx: roundCssPixelValue(labelLetterSpacingPx * scale),
    };
  } finally {
    restoreInlineActionTextFitStyles(el, previousValues);
  }
}

function actionTextFitsMatch(a: ActionTextFit, b: ActionTextFit): boolean {
  return (
    Math.abs(a.scale - b.scale) < ACTION_TEXT_FIT_TOLERANCE &&
    Math.abs(a.labelFontSizePx - b.labelFontSizePx) < ACTION_TEXT_FIT_TOLERANCE &&
    Math.abs(a.priceFontSizePx - b.priceFontSizePx) < ACTION_TEXT_FIT_TOLERANCE &&
    Math.abs(a.labelLetterSpacingPx - b.labelLetterSpacingPx) < ACTION_TEXT_FIT_TOLERANCE
  );
}

function useActionTextFit<T extends HTMLElement>(ref: RefObject<T | null>, deps: DependencyList): ActionTextFit {
  const [fit, setFit] = useState<ActionTextFit>(ACTION_TEXT_FIT_DEFAULT);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      setFit((prev) => (actionTextFitsMatch(prev, ACTION_TEXT_FIT_DEFAULT) ? prev : ACTION_TEXT_FIT_DEFAULT));
      return undefined;
    }

    let frame = 0;
    let cancelled = false;
    const update = () => {
      frame = 0;
      if (cancelled) return;
      const next = calcActionTextFit(el);
      setFit((prev) => (actionTextFitsMatch(prev, next) ? prev : next));
    };
    const schedule = () => {
      if (cancelled || frame) return;
      frame = window.requestAnimationFrame(update);
    };

    update();

    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    ro?.observe(el);
    el.querySelectorAll<HTMLElement>('[data-mint-action-fit]').forEach((node) => ro?.observe(node));
    window.addEventListener('resize', schedule);
    void document.fonts?.ready.then(schedule);

    return () => {
      cancelled = true;
      if (frame) window.cancelAnimationFrame(frame);
      ro?.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, deps);

  return fit;
}

function actionTextFitStyle(fit: ActionTextFit): CSSProperties | undefined {
  if (fit.scale >= 1 - ACTION_TEXT_FIT_TOLERANCE) return undefined;

  return {
    ['--mint-panel-action-fit-label-font-size' as never]: `${fit.labelFontSizePx}px`,
    ['--mint-panel-action-fit-price-font-size' as never]: `${fit.priceFontSizePx}px`,
    ['--mint-panel-action-fit-letter-spacing' as never]: `${fit.labelLetterSpacingPx}px`,
  };
}

function tighterActionTextFit(a: ActionTextFit, b: ActionTextFit): ActionTextFit {
  return a.scale <= b.scale ? a : b;
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
  const maxHeight = Math.max(1, Math.floor(safeHeight * BOX_MAX_RELATIVE_HEIGHT));
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
  dropId,
  priceSol,
  discountPriceSol,
  maxSupply,
  maxPerTx,
  discountAvailable,
  discountMaxQuantity,
  onDiscountMint,
  discountBusy,
  onStripePaymentClick,
  stripePaymentVisible,
  stripePaymentBusy,
  stripePaymentPriceLabel,
  mintSelection,
  showSizeInfo,
  successfulMintToken = 0,
  terminalAction,
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
  const [discountSubmitPending, setDiscountSubmitPending] = useState(false);
  const [stripePaymentSubmitPending, setStripePaymentSubmitPending] = useState(false);
  const [sizeInfoOpen, setSizeInfoOpen] = useState(false);
  const sizeInfoRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const stripePaymentButtonRef = useRef<HTMLButtonElement | null>(null);
  const submitButtonRef = useRef<HTMLButtonElement | null>(null);
  const [previewBounds, setPreviewBounds] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const stripePaymentPending = Boolean(stripePaymentBusy) || stripePaymentSubmitPending;

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
    if (successfulMintToken === 0) return;
    // Success is signaled explicitly from the parent so local controls can
    // reset without depending on how long the post-mint refresh takes.
    setSelectedSize(null);
    setQuantity(1);
  }, [successfulMintToken]);

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
      // Measure the stable preview slot, not the grid whose item size we write back.
      // This avoids a ResizeObserver feedback loop where the preview shrinks itself.
      const style = window.getComputedStyle(el);
      const paddingX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const paddingY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const width = Math.max(0, Math.floor(el.clientWidth - paddingX));
      const height = Math.max(0, Math.floor(el.clientHeight - paddingY));
      setPreviewBounds((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    };

    update();
    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const soldOut = remaining <= 0;
  const layout = useMemo(
    () => calcBoxPreviewLayout(quantity, previewBounds.width, previewBounds.height, boxAspectRatio || BOX_ASPECT_RATIO),
    [boxAspectRatio, quantity, previewBounds.height, previewBounds.width],
  );
  const quantityLabel = dropAssetCount({ namePrefix: boxNamePrefix, figureNamePrefix: undefined }, 'box', quantity);
  const unitPriceLamports = solAmountToLamports(priceSol, priceSol);
  const unitDiscountPriceLamports = solAmountToLamports(discountPriceSol, discountPriceSol);
  const totalPriceLabel = formatSolAmount((unitPriceLamports * quantity) / LAMPORTS_PER_SOL_UI);
  const totalDiscountPriceLabel = formatSolAmount((unitDiscountPriceLamports * quantity) / LAMPORTS_PER_SOL_UI);
  const stripePaymentDisplayPriceLabel = stripePaymentPriceLabel?.trim();
  const formId = 'mint-form';
  const normalizedDiscountMaxQuantity =
    Number.isFinite(Number(discountMaxQuantity)) && Number(discountMaxQuantity) >= 0
      ? Math.max(0, Math.floor(Number(discountMaxQuantity)))
      : undefined;
  const exceedsDiscountAllowance = normalizedDiscountMaxQuantity !== undefined && quantity > normalizedDiscountMaxQuantity;
  const hasDiscountAllowance = normalizedDiscountMaxQuantity === undefined || normalizedDiscountMaxQuantity > 0;
  const useDiscountMint =
    Boolean(discountAvailable && onDiscountMint) && !soldOut && hasDiscountAllowance && !exceedsDiscountAllowance;
  const showStripePaymentButton = Boolean(stripePaymentVisible && onStripePaymentClick && stripePaymentDisplayPriceLabel) && !soldOut;
  const stripePaymentQuantitySupported = quantity === STRIPE_CHECKOUT_QUANTITY;
  const submitBusy = busy || discountSubmitPending || (useDiscountMint && Boolean(discountBusy));
  const controlsBusy = submitBusy || stripePaymentPending;
  const submitClassName = submitBusy
    ? 'mint-panel__submit mint-panel__submit--busy'
    : useDiscountMint
      ? 'mint-panel__submit mint-panel__submit--discounted'
      : 'mint-panel__submit';
  const submitAriaLabel = useDiscountMint
    ? `Mint with discount for ${totalDiscountPriceLabel} SOL. Regular price ${totalPriceLabel} SOL.`
    : undefined;
  const ctaStackClassName = showStripePaymentButton
    ? 'mint-panel__cta-stack mint-panel__cta-stack--with-payment'
    : 'mint-panel__cta-stack';
  const stripeActionTextFit = useActionTextFit(stripePaymentButtonRef, [
    showStripePaymentButton,
    stripePaymentPending,
    stripePaymentDisplayPriceLabel,
  ]);
  const submitActionTextFit = useActionTextFit(submitButtonRef, [
    showStripePaymentButton,
    submitBusy,
    useDiscountMint,
    totalPriceLabel,
    totalDiscountPriceLabel,
  ]);
  const pairedActionTextFit = showStripePaymentButton
    ? tighterActionTextFit(stripeActionTextFit, submitActionTextFit)
    : submitActionTextFit;
  const stripeActionTextFitStyle = actionTextFitStyle(pairedActionTextFit);
  const submitActionTextFitStyle = actionTextFitStyle(pairedActionTextFit);
  const mintTitle = title || 'Little Swag Boxes';
  const mintBoxImageSrc = boxImageSrc;
  const soldOutButtons = useMemo<MintPanelTerminalButton[]>(() => {
    return secondaryMarketplaceLinksForDropId(dropId || '').map((link) => ({
      key: link.key,
      buttonText: link.label,
      href: link.href,
    }));
  }, [dropId]);
  const isDefaultSoldOutState = soldOut && !terminalAction;
  const terminalState =
    terminalAction ||
    (soldOut
      ? {
          statusText: 'Minted out',
          buttons: soldOutButtons,
        }
      : null);
  const terminalButtons = (
    terminalState
      ? terminalState.buttons ||
        (terminalState.buttonText && (terminalState.href || terminalState.onClick)
          ? [
              {
                key: 'primary',
                buttonText: terminalState.buttonText,
                href: terminalState.href,
                onClick: terminalState.onClick,
              },
            ]
          : [])
      : []
  ).filter((button) => button.href || button.onClick);
  const terminalFooterClassName = isDefaultSoldOutState
    ? 'mint-panel__footer mint-panel__footer--soldout mint-panel__footer--marketplaces'
    : 'mint-panel__footer mint-panel__footer--soldout';
  const splitTerminalButtons = terminalButtons.length > 1;

  const handleMint = async (evt: FormEvent) => {
    evt.preventDefault();
    if (controlsBusy) return;
    if (showSizeSelector && !selectedSize) {
      setSizeBlinkToken((prev) => prev + 1);
      return;
    }
    if (quantity < 1 || quantity > maxSelectable) return;

    if (useDiscountMint) {
      if (!onDiscountMint) return;
      setDiscountSubmitPending(true);
      try {
        await onDiscountMint(quantity, selectedSize || undefined);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to mint';
        if (onError) onError(message);
      } finally {
        setDiscountSubmitPending(false);
      }
      return;
    }

    try {
      await onMint(quantity, selectedSize || undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to mint';
      if (onError) onError(message);
    }
  };

  const handleStripePaymentClick = async () => {
    if (!onStripePaymentClick || stripePaymentPending) return;
    if (showSizeSelector && !selectedSize) {
      setSizeBlinkToken((prev) => prev + 1);
      return;
    }
    if (quantity < 1 || quantity > maxSelectable || !stripePaymentQuantitySupported) return;
    setStripePaymentSubmitPending(true);
    try {
      await onStripePaymentClick(selectedSize || undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start Stripe payment';
      if (onError) onError(message);
    } finally {
      setStripePaymentSubmitPending(false);
    }
  };

  return (
    <section className="mint-panel">
      <div ref={previewRef} className="mint-panel__preview">
        <div
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
      {terminalState ? (
        <div className={terminalFooterClassName}>
          <div className="mint-panel__info">
            <div className="mint-panel__price">{mintTitle}</div>
            <div className="mint-panel__remaining">{terminalState.statusText}</div>
          </div>
          {terminalButtons.length ? (
            <div className="mint-panel__cta">
              <div
                className={
                  splitTerminalButtons
                    ? 'mint-panel__terminal-buttons mint-panel__terminal-buttons--split'
                    : 'mint-panel__terminal-buttons'
                }
              >
                {terminalButtons.map((button, index) => {
                  const key = button.key || `${button.buttonText}-${index}`;
                  if (button.href) {
                    return (
                      <a key={key} className="mint-panel__secondary" href={button.href} target="_blank" rel="noreferrer">
                        <span className="mint-panel__secondary-text">{button.buttonText}</span>
                      </a>
                    );
                  }
                  if (!button.onClick) return null;
                  return (
                    <button key={key} type="button" className="mint-panel__secondary" onClick={button.onClick}>
                      <span className="mint-panel__secondary-text">{button.buttonText}</span>
                    </button>
                  );
                })}
              </div>
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
                        disabled={controlsBusy || unavailable}
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
                  disabled={controlsBusy}
                />
              </label>
            ) : null}
          </form>
          <div className="mint-panel__cta">
            <div className={ctaStackClassName}>
              {showStripePaymentButton ? (
                <button
                  ref={stripePaymentButtonRef}
                  type="button"
                  className={stripePaymentPending ? 'mint-panel__stripe mint-panel__stripe--busy' : 'mint-panel__stripe'}
                  style={stripeActionTextFitStyle}
                  onClick={() => {
                    void handleStripePaymentClick();
                  }}
                  disabled={controlsBusy || quantity < 1 || quantity > maxSelectable || !stripePaymentQuantitySupported}
                  title={stripePaymentQuantitySupported ? undefined : 'Stripe checkout supports one item at a time'}
                >
                  {stripePaymentPending ? (
                    <>
                      <span className="mint-panel__stripe-text mint-panel__stripe-text--busy">
                        <span className="mint-panel__stripe-text-anchor" aria-hidden="true">
                          Pay with card
                        </span>
                        <span className="mint-panel__stripe-text-busy" data-mint-action-fit="label">Opening Stripe…</span>
                      </span>
                      <span
                        className="mint-panel__stripe-price mint-panel__stripe-price--placeholder"
                        data-mint-action-fit="price"
                        aria-hidden="true"
                      >
                        {stripePaymentDisplayPriceLabel}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="mint-panel__stripe-text" data-mint-action-fit="label">
                        <span>Pay with card</span>
                      </span>
                      <span className="mint-panel__stripe-price" data-mint-action-fit="price">
                        {stripePaymentDisplayPriceLabel}
                      </span>
                    </>
                  )}
                </button>
              ) : null}
              <button
                ref={submitButtonRef}
                type="submit"
                form={formId}
                className={submitClassName}
                style={submitActionTextFitStyle}
                disabled={controlsBusy || quantity < 1 || quantity > maxSelectable}
                aria-label={submitAriaLabel}
              >
                {submitBusy ? (
                  <span className="mint-panel__submit-text" data-mint-action-fit="label">Minting…</span>
                ) : (
                  <>
                    <span className="mint-panel__submit-text" data-mint-action-fit="label">Mint</span>
                    {useDiscountMint ? (
                      <span
                        className="mint-panel__submit-price mint-panel__submit-price--discounted"
                        data-mint-action-fit="price"
                        aria-hidden="true"
                      >
                        <span className="mint-panel__submit-price-old">{totalPriceLabel}</span>
                        <span className="mint-panel__submit-price-new">{totalDiscountPriceLabel}</span>
                        <span className="mint-panel__submit-price-currency">SOL</span>
                      </span>
                    ) : (
                      <span className="mint-panel__submit-price" data-mint-action-fit="price">{totalPriceLabel} SOL</span>
                    )}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
