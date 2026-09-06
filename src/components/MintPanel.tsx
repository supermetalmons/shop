import {
  CSSProperties,
  DependencyList,
  FormEvent,
  RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { FaCircleQuestion } from 'react-icons/fa6';
import { LuInfo } from 'react-icons/lu';
import { MintStats, type PackStatusBreakdown, type PackStatusDisplayLabels } from '../types';
import { dropAssetCount } from '../lib/dropLabels';
import { resolveDropSizeGuide } from '../lib/dropSizeGuide';
import { resolveDropXProfile } from '../lib/dropSocialLinks';
import { secondaryMarketplaceLinksForDropId, type MintSelectionConfig } from '../config/deployment';
import { deriveMintSelectionAvailabilityFromConfig } from '../lib/boxMinter';
import { MintPreview, type MintPanelBoxMedia } from './MintPreview';

export type { MintPanelBoxMedia } from './MintPreview';

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
  solanaMintVisible?: boolean;
  busy: boolean;
  onError?: (message: string) => void;
  title?: string;
  boxMedia?: MintPanelBoxMedia;
  boxNamePrefix?: string;
  dropId?: string;
  receiptPoolId?: string;
  priceSol: number;
  discountPriceSol: number;
  maxSupply: number;
  maxPerTx: number;
  discountAvailable?: boolean;
  discountMaxQuantity?: number;
  onDiscountMint?: (quantity: number, variantKey?: string) => void | Promise<void>;
  discountBusy?: boolean;
  onStripePaymentClick?: (quantity: number, variantKey?: string) => void | Promise<void>;
  stripePaymentVisible?: boolean;
  stripePaymentBusy?: boolean;
  stripePaymentPriceLabel?: string;
  stripePaymentUnitAmountCents?: number;
  mintSelection?: MintSelectionConfig;
  successfulMintToken?: number;
  terminalAction?: MintPanelTerminalAction;
  onNotifyNextDrops?: () => void;
  showPackStatusInfo?: boolean;
  packStatusBreakdown?: PackStatusBreakdown;
  packStatusDisplayLabels?: PackStatusDisplayLabels;
}

const REMAINING_OVERRIDE: number | null = null;
const MONS_SHOP_RECEIPTS_POOL_ID = 'mons_shop_receipts';

const LAMPORTS_PER_SOL_UI = 1_000_000_000;
const ACTION_TEXT_FIT_MIN_SCALE = 0.62;
const ACTION_TEXT_FIT_SAFETY_PX = 8;
const ACTION_TEXT_FIT_TOLERANCE = 0.004;

const ACTION_TEXT_FIT_DEFAULT = {
  scale: 1,
  labelFontSizePx: 0,
  priceFontSizePx: 0,
  labelLetterSpacingPx: 0,
};
const STRIPE_USD_PRICE_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const PACK_STATUS_NUMBER_FORMATTER = new Intl.NumberFormat('en-US', { useGrouping: false });

const ACTION_TEXT_FIT_STYLE_PROPS = [
  '--mint-panel-action-fit-label-font-size',
  '--mint-panel-action-fit-price-font-size',
  '--mint-panel-action-fit-letter-spacing',
] as const;

function XProfileLogo() {
  return (
    <svg viewBox="26.8 48 460.2 416" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M389.2 48h70.6L305.6 224.2 487 464H345L233.7 318.6 106.5 464H35.8L200.7 275.5 26.8 48H172.4L272.9 180.9 389.2 48zM364.4 421.8h39.1L151.1 88h-42L364.4 421.8z"
      />
    </svg>
  );
}

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

function useDismissiblePopover<T extends HTMLElement>(
  open: boolean,
  rootRef: RefObject<T | null>,
  setOpen: (open: boolean) => void,
): void {
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (evt: MouseEvent) => {
      const root = rootRef.current;
      if (root && !root.contains(evt.target as Node)) setOpen(false);
    };
    const onKeyDown = (evt: KeyboardEvent) => {
      if (evt.key !== 'Escape' || evt.defaultPrevented) return;
      evt.preventDefault();
      setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, rootRef, setOpen]);
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

function normalizeStripePaymentUnitAmountCents(value: number | undefined): number | null {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function formatStripeUsdAmountCents(value: number): string {
  return STRIPE_USD_PRICE_FORMATTER.format(value / 100);
}

function formatPackStatusAmount(amount: number): string {
  return PACK_STATUS_NUMBER_FORMATTER.format(Math.max(0, Math.floor(Number(amount) || 0)));
}

const DEFAULT_PACK_STATUS_DISPLAY_LABELS: PackStatusDisplayLabels = {
  itemColumnLabel: 'Cards',
  ariaLabel: 'Card status',
};

function MintPanelPackStatusPopover({
  breakdown,
  displayLabels = DEFAULT_PACK_STATUS_DISPLAY_LABELS,
}: {
  breakdown?: PackStatusBreakdown;
  displayLabels?: PackStatusDisplayLabels;
}) {
  return (
    <div className="mint-panel__pack-status-popover" role="dialog" aria-label={displayLabels.ariaLabel} aria-busy={!breakdown}>
      {breakdown ? (
        <table className="mint-panel__pack-status-table">
          <thead>
            <tr>
              <th scope="col" aria-label="Status" />
              <th scope="col">{displayLabels.itemColumnLabel}</th>
            </tr>
          </thead>
          <tbody>
            {breakdown.items.map((item) => (
              <tr key={item.key} className={item.key === 'total' ? 'mint-panel__pack-status-row--total' : undefined}>
                <th scope="row">{item.label}</th>
                <td>{formatPackStatusAmount(item.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="mint-panel__pack-status-loading">LOADING</div>
      )}
    </div>
  );
}

export function MintPanel({
  stats,
  onMint,
  solanaMintVisible = true,
  busy,
  onError,
  title,
  boxMedia,
  boxNamePrefix,
  dropId,
  receiptPoolId,
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
  stripePaymentUnitAmountCents,
  mintSelection,
  successfulMintToken = 0,
  terminalAction,
  onNotifyNextDrops,
  showPackStatusInfo,
  packStatusBreakdown,
  packStatusDisplayLabels = DEFAULT_PACK_STATUS_DISPLAY_LABELS,
}: MintPanelProps) {
  const minted = stats?.minted ?? 0;
  const total = stats?.total ?? maxSupply;
  const computedRemaining = stats?.remaining ?? Math.max(0, total - minted);
  const remaining = REMAINING_OVERRIDE === null ? computedRemaining : Math.max(0, Math.floor(REMAINING_OVERRIDE));
  const remainingReady = REMAINING_OVERRIDE !== null || Boolean(stats);
  const maxSelectablePerTx = stats?.maxPerTx ?? maxPerTx;
  const sizeSelection = mintSelection?.kind === 'size' ? mintSelection : undefined;
  const sizeOptions = sizeSelection?.options ?? [];
  const sizeGuide = sizeSelection ? resolveDropSizeGuide(dropId) : null;
  const sizeAvailability = useMemo(
    () => stats?.mintSelectionAvailability ?? deriveMintSelectionAvailabilityFromConfig(sizeSelection) ?? {},
    [stats?.mintSelectionAvailability, sizeSelection],
  );
  const [quantity, setQuantity] = useState(1);
  const maxSelectable = Math.min(maxSelectablePerTx, remaining);
  const showSizeSelector = Boolean(sizeSelection);
  const showQuantitySlider = !showSizeSelector && maxSelectable > 1;
  const showFormControls = showQuantitySlider || showSizeSelector;
  const showPackStatusControl = Boolean(showPackStatusInfo || packStatusBreakdown);
  const [selectedSize, setSelectedSize] = useState<string | null>(null);

  const [sizeBlinkToken, setSizeBlinkToken] = useState(0);

  const [isBlinking, setIsBlinking] = useState(false);
  const [discountSubmitPending, setDiscountSubmitPending] = useState(false);
  const [stripePaymentSubmitPending, setStripePaymentSubmitPending] = useState(false);
  const [sizeInfoOpen, setSizeInfoOpen] = useState(false);
  const [packStatusInfoOpen, setPackStatusInfoOpen] = useState(false);
  const sizeInfoRef = useRef<HTMLDivElement | null>(null);
  const packStatusInfoRef = useRef<HTMLDivElement | null>(null);
  const stripePaymentButtonRef = useRef<HTMLButtonElement | null>(null);
  const submitButtonRef = useRef<HTMLButtonElement | null>(null);
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

    const handle = window.setTimeout(() => setIsBlinking(false), 460);
    return () => window.clearTimeout(handle);
  }, [sizeBlinkToken]);

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
    if (!showPackStatusControl && packStatusInfoOpen) setPackStatusInfoOpen(false);
  }, [showPackStatusControl, packStatusInfoOpen]);

  useDismissiblePopover(sizeInfoOpen, sizeInfoRef, setSizeInfoOpen);
  useDismissiblePopover(packStatusInfoOpen, packStatusInfoRef, setPackStatusInfoOpen);

  const soldOut = remaining <= 0;
  const quantityLabel = dropAssetCount({ namePrefix: boxNamePrefix, figureNamePrefix: undefined }, 'box', quantity);
  const unitPriceLamports = solAmountToLamports(priceSol, priceSol);
  const unitDiscountPriceLamports = solAmountToLamports(discountPriceSol, discountPriceSol);
  const totalPriceLabel = formatSolAmount((unitPriceLamports * quantity) / LAMPORTS_PER_SOL_UI);
  const totalDiscountPriceLabel = formatSolAmount((unitDiscountPriceLamports * quantity) / LAMPORTS_PER_SOL_UI);
  const stripePaymentUnitPriceLabel = stripePaymentPriceLabel?.trim();
  const normalizedStripePaymentUnitAmountCents = normalizeStripePaymentUnitAmountCents(stripePaymentUnitAmountCents);
  const stripePaymentTotalPriceLabel =
    normalizedStripePaymentUnitAmountCents == null
      ? undefined
      : formatStripeUsdAmountCents(normalizedStripePaymentUnitAmountCents * quantity);
  const stripePaymentFallbackPriceLabel =
    stripePaymentUnitPriceLabel && quantity > 1
      ? `${stripePaymentUnitPriceLabel} x ${quantity}`
      : stripePaymentUnitPriceLabel;
  const stripePaymentDisplayPriceLabel = stripePaymentTotalPriceLabel || stripePaymentFallbackPriceLabel;
  const formId = 'mint-form';
  const normalizedDiscountMaxQuantity =
    Number.isFinite(Number(discountMaxQuantity)) && Number(discountMaxQuantity) >= 0
      ? Math.max(0, Math.floor(Number(discountMaxQuantity)))
      : undefined;
  const exceedsDiscountAllowance = normalizedDiscountMaxQuantity !== undefined && quantity > normalizedDiscountMaxQuantity;
  const hasDiscountAllowance = normalizedDiscountMaxQuantity === undefined || normalizedDiscountMaxQuantity > 0;
  const showSolanaMintButton = solanaMintVisible;
  const useDiscountMint =
    showSolanaMintButton &&
    Boolean(discountAvailable && onDiscountMint) &&
    !soldOut &&
    hasDiscountAllowance &&
    !exceedsDiscountAllowance;
  const showStripePaymentButton = Boolean(stripePaymentVisible && onStripePaymentClick && stripePaymentDisplayPriceLabel) && !soldOut;
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
  const ctaStackClassName = showStripePaymentButton && showSolanaMintButton
    ? 'mint-panel__cta-stack mint-panel__cta-stack--with-payment'
    : 'mint-panel__cta-stack';
  const stripeActionTextFit = useActionTextFit(stripePaymentButtonRef, [
    showStripePaymentButton,
    showSolanaMintButton,
    stripePaymentPending,
    stripePaymentDisplayPriceLabel,
  ]);
  const submitActionTextFit = useActionTextFit(submitButtonRef, [
    showStripePaymentButton,
    showSolanaMintButton,
    submitBusy,
    useDiscountMint,
    quantityLabel,
    totalPriceLabel,
    totalDiscountPriceLabel,
  ]);
  const pairedActionTextFit = showStripePaymentButton && showSolanaMintButton
    ? tighterActionTextFit(stripeActionTextFit, submitActionTextFit)
    : showStripePaymentButton
      ? stripeActionTextFit
      : submitActionTextFit;
  const stripeActionTextFitStyle = actionTextFitStyle(pairedActionTextFit);
  const submitActionTextFitStyle = actionTextFitStyle(pairedActionTextFit);
  const mintTitle = title || 'Little Swag Boxes';
  const dropXProfile = resolveDropXProfile(dropId);
  const dropXProfileLink = dropXProfile ? (
    <a
      className="mint-panel__social-link"
      href={dropXProfile.href}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open ${dropXProfile.handle} on X`}
    >
      <XProfileLogo />
    </a>
  ) : null;
  const dropTitle = (
    <div className="mint-panel__price">
      <span className="mint-panel__drop-name">{mintTitle}</span>
      {dropXProfileLink}
    </div>
  );
  const soldOutButtons = useMemo<MintPanelTerminalButton[]>(() => {
    return secondaryMarketplaceLinksForDropId(dropId || '').map((link) => ({
      key: link.key,
      buttonText: link.label,
      href: link.href,
    }));
  }, [dropId]);
  const isSharedReceiptPoolSoldOut = soldOut && receiptPoolId === MONS_SHOP_RECEIPTS_POOL_ID;
  const isDefaultSoldOutState = soldOut && !terminalAction && !isSharedReceiptPoolSoldOut;
  const terminalState =
    terminalAction ||
    (soldOut
      ? isSharedReceiptPoolSoldOut
        ? {
            statusText: 'Sold Out',
            buttonText: 'Notify me',
            onClick: onNotifyNextDrops,
          }
        : {
            statusText: 'Minted Out',
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
  const terminalButtonsClassName = splitTerminalButtons
    ? terminalButtons.length > 2
      ? 'mint-panel__terminal-buttons mint-panel__terminal-buttons--split mint-panel__terminal-buttons--triple'
      : 'mint-panel__terminal-buttons mint-panel__terminal-buttons--split'
    : 'mint-panel__terminal-buttons';

  const handleMint = async (evt: FormEvent) => {
    evt.preventDefault();
    if (!showSolanaMintButton) return;
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
    if (quantity < 1 || quantity > maxSelectable) return;
    setStripePaymentSubmitPending(true);
    try {
      await onStripePaymentClick(quantity, selectedSize || undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start Stripe payment';
      if (onError) onError(message);
    } finally {
      setStripePaymentSubmitPending(false);
    }
  };

  return (
    <section className="mint-panel">
      <MintPreview boxMedia={boxMedia} dropId={dropId} quantity={quantity} quantityLabel={quantityLabel} />
      {terminalState ? (
        <div className={terminalFooterClassName}>
          <div className="mint-panel__info">
            {dropTitle}
            <div className="mint-panel__remaining mint-panel__remaining--with-info">
              <span>{terminalState.statusText}</span>
              {showPackStatusControl ? (
                <span className="mint-panel__pack-status-info-wrap" ref={packStatusInfoRef}>
                  <button
                    type="button"
                    className="mint-panel__pack-status-info"
                    aria-label={packStatusDisplayLabels.ariaLabel}
                    aria-expanded={packStatusInfoOpen}
                    aria-haspopup="dialog"
                    onClick={() => setPackStatusInfoOpen((prev) => !prev)}
                  >
                    <LuInfo aria-hidden="true" focusable="false" size={16} strokeWidth={2} />
                  </button>
                  {packStatusInfoOpen ? (
                    <MintPanelPackStatusPopover breakdown={packStatusBreakdown} displayLabels={packStatusDisplayLabels} />
                  ) : null}
                </span>
              ) : null}
            </div>
          </div>
          {terminalButtons.length ? (
            <div className="mint-panel__cta">
              <div
                className={terminalButtonsClassName}
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
            {dropTitle}
            <div
              className={remainingReady ? 'mint-panel__remaining' : 'mint-panel__remaining mint-panel__remaining--hidden'}
              aria-hidden={!remainingReady}
            >
              <span>{remaining} / {total} left</span>
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
                  aria-label={sizeGuide?.selectionAriaLabel ?? 'Size'}
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
                {sizeGuide ? (
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
                        aria-label={sizeGuide.dialogAriaLabel}
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
                            {sizeGuide.rows.map((row) => (
                              <tr key={row.size}>
                                <th scope="row">{row.size}</th>
                                <td>{row.bodyLength}</td>
                                <td>{row.chestWidth}</td>
                                <td>{row.sleeveLength}</td>
                              </tr>
                            ))}
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
                  aria-label="Mint quantity"
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
                  disabled={controlsBusy || quantity < 1 || quantity > maxSelectable}
                >
                  {stripePaymentPending ? (
                    <>
                      <span className="mint-panel__stripe-text mint-panel__stripe-text--busy">
                        <span className="mint-panel__stripe-text-anchor" aria-hidden="true">
                          Checkout
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
                        <span>Checkout</span>
                      </span>
                      <span className="mint-panel__stripe-price" data-mint-action-fit="price">
                        {stripePaymentDisplayPriceLabel}
                      </span>
                    </>
                  )}
                </button>
              ) : null}
              {showSolanaMintButton ? (
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
                      <span className="mint-panel__submit-text" data-mint-action-fit="label">
                        Mint
                        {showQuantitySlider ? (
                          <span className="mint-panel__submit-quantity"> {quantityLabel}</span>
                        ) : null}
                      </span>
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
              ) : null}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
