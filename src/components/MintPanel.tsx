import {
  CSSProperties,
  DependencyList,
  FormEvent,
  RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { FaCircleQuestion } from 'react-icons/fa6';
import { LuInfo } from 'react-icons/lu';
import { MintStats, type PackStatusBreakdown, type PackStatusDisplayLabels, type PreviewVideoSource } from '../types';
import { dropAssetCount } from '../lib/dropLabels';
import { resolveDropSizeGuide } from '../lib/dropSizeGuide';
import { isDropFamily, secondaryMarketplaceLinksForDropId, type MintSelectionConfig } from '../config/deployment';
import { deriveMintSelectionAvailabilityFromConfig } from '../lib/boxMinter';
import {
  playMutedAutoplayVideo as playAutoplayVideo,
  prepareMutedAutoplayVideo as prepareAutoplayVideo,
} from '../lib/autoplayVideo';

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

type MintPanelVideoSource = PreviewVideoSource;

export type MintPanelBoxMedia = {
  imageSrc?: string;
  videoSources?: readonly MintPanelVideoSource[];
  videoPosterSrc?: string;
  mediaScale?: number;
  compactMediaScale?: number;
  aspectRatio?: number;
};

interface MintPanelProps {
  stats?: MintStats;
  onMint: (quantity: number, variantKey?: string) => void | Promise<void>;
  busy: boolean;
  onError?: (message: string) => void;
  title?: string;
  boxMedia?: MintPanelBoxMedia;
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
  onStripePaymentClick?: (quantity: number, variantKey?: string) => void | Promise<void>;
  stripePaymentVisible?: boolean;
  stripePaymentBusy?: boolean;
  stripePaymentPriceLabel?: string;
  stripePaymentUnitAmountCents?: number;
  mintSelection?: MintSelectionConfig;
  successfulMintToken?: number;
  terminalAction?: MintPanelTerminalAction;
  showPackStatusInfo?: boolean;
  packStatusBreakdown?: PackStatusBreakdown;
  packStatusDisplayLabels?: PackStatusDisplayLabels;
}

/**
 * DEV: Override the "remaining" value for MintPanel UI testing.
 * Set to a number (e.g. 42) to force that remaining count.
 * Leave as `null` to use real backend/on-chain stats.
 */
const REMAINING_OVERRIDE: number | null = null;

type BoxPreviewLayout = { width: number; height: number; gapX: number; gapY: number; cols: number };
type BoxPreviewBounds = { width: number; height: number; viewportWidth: number; centerX: number };

const BOX_ASPECT_RATIO = 1440 / 1030; // width / height (tight.webp)
const BOX_MAX_RELATIVE_HEIGHT = 0.777;
const BOX_MEDIA_SCALE_MAX = 1.5;
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
      if (evt.key === 'Escape') setOpen(false);
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

function fallbackElementsAfter(element: HTMLElement): HTMLElement[] {
  const elements: HTMLElement[] = [];
  let fallback = element.nextElementSibling;
  while (fallback instanceof HTMLElement && fallback.dataset.mintMediaFallback === 'true') {
    elements.push(fallback);
    fallback = fallback.nextElementSibling;
  }

  return elements;
}

function hideFallbackElementsAfter(element: HTMLElement) {
  fallbackElementsAfter(element).forEach((fallback) => {
    fallback.hidden = true;
  });
}

function mediaFallbackFailed(fallback: HTMLElement): boolean {
  return fallback instanceof HTMLImageElement && fallback.complete && fallback.naturalWidth === 0;
}

function mediaFallbackReady(fallback: HTMLElement): boolean {
  return !(fallback instanceof HTMLImageElement) || (fallback.complete && fallback.naturalWidth > 0);
}

function showFirstAvailableFallbackAfter(element: HTMLElement) {
  let selectedFallback: HTMLElement | null = null;

  fallbackElementsAfter(element).forEach((fallback) => {
    if (mediaFallbackFailed(fallback)) {
      fallback.hidden = true;
      return;
    }

    if (!selectedFallback) {
      selectedFallback = fallback;
      fallback.hidden = false;
      return;
    }

    // Keep the next fallback eligible while a preferred fallback image is still
    // loading, so failed media can settle to the blank slot without a flash.
    fallback.hidden = mediaFallbackReady(selectedFallback) || fallback instanceof HTMLImageElement;
  });
}

function showPrimaryMediaFallback(media: HTMLElement) {
  showFirstAvailableFallbackAfter(media);
}

function hideMediaShowFallback(media: HTMLElement) {
  media.hidden = true;
  showPrimaryMediaFallback(media);
}

function videoHasCurrentData(video: HTMLVideoElement): boolean {
  return !video.error && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
}

function hideLoadedImageFallbacks(image: HTMLImageElement) {
  if (image.hidden) return;
  hideFallbackElementsAfter(image);
}

function hideImageShowFallback(image: HTMLImageElement) {
  image.hidden = true;
  showFirstAvailableFallbackAfter(image);
}

function uniqueMediaSrcs(...sources: Array<string | undefined>): string[] {
  const uniqueSources = new Set<string>();
  sources.forEach((source) => {
    const trimmedSource = source?.trim();
    if (trimmedSource) uniqueSources.add(trimmedSource);
  });

  return Array.from(uniqueSources);
}

type RestartAutoplayVideoOptions = {
  reload?: boolean;
  reloadIfStale?: boolean;
};

function autoplayVideoNeedsReload(video: HTMLVideoElement): boolean {
  return Boolean(video.error) || video.readyState === 0;
}

function resetAutoplayVideoTime(video: HTMLVideoElement) {
  try {
    video.currentTime = 0;
  } catch {
    // Some browsers reject seeking before metadata is available.
  }
}

function stopAutoplayVideo(video: HTMLVideoElement) {
  video.pause();
  resetAutoplayVideoTime(video);
}

function restartAutoplayVideo(video: HTMLVideoElement, options: RestartAutoplayVideoOptions = {}) {
  const shouldReload = Boolean(options.reload || (options.reloadIfStale && autoplayVideoNeedsReload(video)));
  stopAutoplayVideo(video);
  if (shouldReload) {
    video.load();
  }
  playAutoplayVideo(video);
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

function normalizeBoxMediaScale(requestedScale: number | undefined): number {
  return clampNumber(Number(requestedScale) || 1, 1, BOX_MEDIA_SCALE_MAX);
}

function constrainBoxMediaScale(scale: number, layout: BoxPreviewLayout, bounds: BoxPreviewBounds): number {
  if (layout.width <= 0 || bounds.viewportWidth <= 0) return scale;

  const availableWidthAroundCenter = Math.max(
    0,
    2 * Math.min(bounds.centerX, bounds.viewportWidth - bounds.centerX),
  );
  if (availableWidthAroundCenter <= 0) return scale;

  return Math.min(scale, Math.max(1, availableWidthAroundCenter / layout.width));
}

type MintPanelBoxVideoProps = {
  playIfActive: (video: HTMLVideoElement) => void;
  registerVideo: (video: HTMLVideoElement, options?: Pick<RestartAutoplayVideoOptions, 'reload'>) => () => void;
  sources: readonly MintPanelVideoSource[];
};

function MintPanelBoxVideo({
  playIfActive,
  registerVideo,
  sources,
}: MintPanelBoxVideoProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoReadyRef = useRef(false);
  const registeredSourceKeyRef = useRef<string | null>(null);
  const [videoReady, setVideoReady] = useState(false);
  const sourceKey = sources.map((source) => source.src).join('|');
  const videoClassName = videoReady
    ? 'mint-panel__box mint-panel__box--video'
    : 'mint-panel__box mint-panel__box--video mint-panel__box--video-loading';

  const handleVideoReady = useCallback(
    (video: HTMLVideoElement) => {
      if (videoReadyRef.current) return;
      videoReadyRef.current = true;
      video.hidden = false;
      video.classList.remove('mint-panel__box--video-loading');
      setVideoReady(true);
      playIfActive(video);
      hideFallbackElementsAfter(video);
    },
    [playIfActive],
  );

  const handleVideoLoading = useCallback((video: HTMLVideoElement) => {
    videoReadyRef.current = false;
    video.classList.add('mint-panel__box--video-loading');
    setVideoReady(false);
    showPrimaryMediaFallback(video);
  }, []);

  const handleVideoError = useCallback((video: HTMLVideoElement) => {
    videoReadyRef.current = false;
    video.classList.add('mint-panel__box--video-loading');
    setVideoReady(false);
    hideMediaShowFallback(video);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    handleVideoLoading(video);
    const registeredSourceKey = registeredSourceKeyRef.current;
    registeredSourceKeyRef.current = sourceKey;
    const unregisterVideo = registerVideo(video, { reload: registeredSourceKey !== null && registeredSourceKey !== sourceKey });
    if (videoHasCurrentData(video)) {
      handleVideoReady(video);
    }
    return unregisterVideo;
  }, [handleVideoLoading, handleVideoReady, registerVideo, sourceKey]);

  return (
    <video
      ref={videoRef}
      className={videoClassName}
      autoPlay
      loop
      muted
      playsInline
      preload="auto"
      aria-hidden="true"
      onLoadStart={(evt) => {
        handleVideoLoading(evt.currentTarget);
      }}
      onEmptied={(evt) => {
        handleVideoLoading(evt.currentTarget);
      }}
      onLoadedData={(evt) => {
        handleVideoReady(evt.currentTarget);
      }}
      onCanPlay={(evt) => {
        handleVideoReady(evt.currentTarget);
      }}
      onError={(evt) => {
        handleVideoError(evt.currentTarget);
      }}
    >
      {sources.map((source) => (
        <source key={source.src} src={source.src} type={source.type} />
      ))}
    </video>
  );
}

export function MintPanel({
  stats,
  onMint,
  busy,
  onError,
  title,
  boxMedia,
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
  stripePaymentUnitAmountCents,
  mintSelection,
  successfulMintToken = 0,
  terminalAction,
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
  const [packStatusInfoOpen, setPackStatusInfoOpen] = useState(false);
  const sizeInfoRef = useRef<HTMLDivElement | null>(null);
  const packStatusInfoRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const mintBoxVideosRef = useRef<Set<HTMLVideoElement>>(new Set());
  const mintBoxVideoPlaybackActiveRef = useRef(false);
  const stripePaymentButtonRef = useRef<HTMLButtonElement | null>(null);
  const submitButtonRef = useRef<HTMLButtonElement | null>(null);
  const [previewBounds, setPreviewBounds] = useState<BoxPreviewBounds>({
    width: 0,
    height: 0,
    viewportWidth: 0,
    centerX: 0,
  });
  const stripePaymentPending = Boolean(stripePaymentBusy) || stripePaymentSubmitPending;
  const mintBoxImageSrc = boxMedia?.imageSrc;
  const mintBoxVideoSources = (boxMedia?.videoSources || []).filter((source) => source.src);
  const hasMintBoxVideoSources = mintBoxVideoSources.length > 0;
  const previewQuantity = hasMintBoxVideoSources && isDropFamily(dropId, 'card_nft_2') ? 1 : quantity;
  const mintBoxVideoPosterSrc = boxMedia?.videoPosterSrc || mintBoxImageSrc;
  const mintBoxVideoFallbackImageSrcs = uniqueMediaSrcs(mintBoxVideoPosterSrc, mintBoxImageSrc);

  const pruneMintBoxVideos = useCallback(() => {
    mintBoxVideosRef.current.forEach((video) => {
      if (video.isConnected) return;
      stopAutoplayVideo(video);
      mintBoxVideosRef.current.delete(video);
    });
  }, []);

  const setMintBoxVideoPlaybackActive = useCallback(
    (active: boolean, options: { reload?: boolean } = {}) => {
      pruneMintBoxVideos();
      const wasActive = mintBoxVideoPlaybackActiveRef.current;
      const reload = Boolean(options.reload);
      if (active === wasActive) {
        if (active && reload) {
          mintBoxVideosRef.current.forEach((video) => restartAutoplayVideo(video, { reload: true }));
        }
        return;
      }

      mintBoxVideoPlaybackActiveRef.current = active;

      mintBoxVideosRef.current.forEach((video) => {
        if (active) {
          restartAutoplayVideo(video, { reload, reloadIfStale: true });
        } else {
          stopAutoplayVideo(video);
        }
      });
    },
    [pruneMintBoxVideos],
  );

  const playMintBoxVideoIfActive = useCallback((video: HTMLVideoElement) => {
    if (mintBoxVideoPlaybackActiveRef.current) {
      playAutoplayVideo(video);
    }
  }, []);

  const registerMintBoxVideo = useCallback(
    (video: HTMLVideoElement, options: Pick<RestartAutoplayVideoOptions, 'reload'> = {}) => {
      pruneMintBoxVideos();
      prepareAutoplayVideo(video);
      mintBoxVideosRef.current.add(video);
      if (mintBoxVideoPlaybackActiveRef.current) {
        restartAutoplayVideo(video, { reload: options.reload });
      }

      return () => {
        stopAutoplayVideo(video);
        mintBoxVideosRef.current.delete(video);
      };
    },
    [pruneMintBoxVideos],
  );

  useEffect(() => {
    if (showSizeSelector) setQuantity(1);
  }, [showSizeSelector]);

  useEffect(() => {
    if (!hasMintBoxVideoSources) return undefined;

    const isDocumentVisible = () => document.visibilityState !== 'hidden';

    const suspendPlayback = () => {
      setMintBoxVideoPlaybackActive(false);
    };

    const resumePlayback = (options: { reload?: boolean } = {}) => {
      if (!isDocumentVisible()) {
        suspendPlayback();
        return;
      }
      setMintBoxVideoPlaybackActive(true, options);
    };

    const handleVisibilityChange = () => {
      if (isDocumentVisible()) {
        resumePlayback();
      } else {
        suspendPlayback();
      }
    };
    const handleFocus = () => resumePlayback();
    const handlePageShow = (evt: PageTransitionEvent) => resumePlayback({ reload: evt.persisted });

    resumePlayback();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('blur', suspendPlayback);
    window.addEventListener('focus', handleFocus);
    window.addEventListener('pagehide', suspendPlayback);
    window.addEventListener('pageshow', handlePageShow);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('blur', suspendPlayback);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('pagehide', suspendPlayback);
      window.removeEventListener('pageshow', handlePageShow);
      mintBoxVideoPlaybackActiveRef.current = false;
      mintBoxVideosRef.current.forEach((video) => stopAutoplayVideo(video));
      mintBoxVideosRef.current.clear();
    };
  }, [hasMintBoxVideoSources, setMintBoxVideoPlaybackActive]);

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
    if (!showPackStatusControl && packStatusInfoOpen) setPackStatusInfoOpen(false);
  }, [showPackStatusControl, packStatusInfoOpen]);

  useDismissiblePopover(sizeInfoOpen, sizeInfoRef, setSizeInfoOpen);
  useDismissiblePopover(packStatusInfoOpen, packStatusInfoRef, setPackStatusInfoOpen);

  useLayoutEffect(() => {
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
      const rect = el.getBoundingClientRect();
      const viewportWidth = Math.max(0, document.documentElement.clientWidth || window.innerWidth || 0);
      const centerX = rect.left + rect.width / 2;
      setPreviewBounds((prev) => (
        prev.width === width &&
        prev.height === height &&
        prev.viewportWidth === viewportWidth &&
        Math.abs(prev.centerX - centerX) < 0.5
          ? prev
          : { width, height, viewportWidth, centerX }
      ));
    };

    update();
    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  const soldOut = remaining <= 0;
  const layout = useMemo(
    () => calcBoxPreviewLayout(previewQuantity, previewBounds.width, previewBounds.height, boxMedia?.aspectRatio || BOX_ASPECT_RATIO),
    [boxMedia?.aspectRatio, previewBounds.height, previewBounds.width, previewQuantity],
  );
  const effectiveBoxMediaScale = constrainBoxMediaScale(normalizeBoxMediaScale(boxMedia?.mediaScale), layout, previewBounds);
  const effectiveBoxCompactMediaScale = constrainBoxMediaScale(
    normalizeBoxMediaScale(boxMedia?.compactMediaScale ?? boxMedia?.mediaScale),
    layout,
    previewBounds,
  );
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
  const useDiscountMint =
    Boolean(discountAvailable && onDiscountMint) && !soldOut && hasDiscountAllowance && !exceedsDiscountAllowance;
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
      <div ref={previewRef} className="mint-panel__preview">
        <div
          className="mint-panel__boxes"
          style={{
            ['--box-width' as never]: `${layout.width}px`,
            ['--box-height' as never]: `${layout.height}px`,
            ['--box-gap-x' as never]: `${layout.gapX}px`,
            ['--box-gap-y' as never]: `${layout.gapY}px`,
            ['--box-cols' as never]: String(layout.cols),
            ['--box-media-scale' as never]: String(effectiveBoxMediaScale),
            ['--box-compact-media-scale' as never]: String(effectiveBoxCompactMediaScale),
          }}
          aria-label={`Mint preview: ${quantityLabel}`}
        >
          {Array.from({ length: previewQuantity }, (_, idx) => (
            hasMintBoxVideoSources ? (
              <div key={idx} className="mint-panel__box mint-panel__box--media mint-panel__box-stack">
                <MintPanelBoxVideo
                  playIfActive={playMintBoxVideoIfActive}
                  registerVideo={registerMintBoxVideo}
                  sources={mintBoxVideoSources}
                />
                {mintBoxVideoFallbackImageSrcs.map((src, fallbackIdx) => (
                  <img
                    key={src}
                    className="mint-panel__box"
                    src={src}
                    alt=""
                    aria-hidden="true"
                    draggable={false}
                    hidden={fallbackIdx > 0}
                    loading="eager"
                    data-mint-media-fallback="true"
                    onDragStart={(evt) => evt.preventDefault()}
                    onLoad={(evt) => hideLoadedImageFallbacks(evt.currentTarget)}
                    onError={(evt) => hideImageShowFallback(evt.currentTarget)}
                  />
                ))}
                <div
                  className="mint-panel__box mint-panel__box--fallback"
                  aria-hidden="true"
                  data-mint-media-fallback="true"
                />
              </div>
            ) : mintBoxImageSrc ? (
              <div key={idx} className="mint-panel__box mint-panel__box-stack">
                <img
                  className="mint-panel__box"
                  src={mintBoxImageSrc}
                  alt=""
                  aria-hidden="true"
                  draggable={false}
                  onDragStart={(evt) => evt.preventDefault()}
                  onLoad={(evt) => hideLoadedImageFallbacks(evt.currentTarget)}
                  onError={(evt) => hideImageShowFallback(evt.currentTarget)}
                />
                <div
                  className="mint-panel__box mint-panel__box--fallback"
                  aria-hidden="true"
                  data-mint-media-fallback="true"
                />
              </div>
            ) : (
              <div key={idx} className="mint-panel__box mint-panel__box--fallback" aria-hidden="true" />
            )
          ))}
        </div>
      </div>
      {terminalState ? (
        <div className={terminalFooterClassName}>
          <div className="mint-panel__info">
            <div className="mint-panel__price">{mintTitle}</div>
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
