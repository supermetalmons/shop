import {
  type CSSProperties,
  type DependencyList,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

interface MintPanelActionsProps {
  formId: string;
  showStripePaymentButton: boolean;
  showSolanaMintButton: boolean;
  stripePaymentPending: boolean;
  submitBusy: boolean;
  disabled: boolean;
  useDiscountMint: boolean;
  showQuantitySlider: boolean;
  quantityLabel: string;
  stripePaymentDisplayPriceLabel: string | undefined;
  totalPriceLabel: string;
  totalDiscountPriceLabel: string;
  onStripePayment: () => Promise<void>;
}

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

export function MintPanelActions({
  formId, showStripePaymentButton, showSolanaMintButton, stripePaymentPending,
  submitBusy, disabled, useDiscountMint, showQuantitySlider, quantityLabel,
  stripePaymentDisplayPriceLabel, totalPriceLabel, totalDiscountPriceLabel, onStripePayment,
}: MintPanelActionsProps) {
  const stripePaymentButtonRef = useRef<HTMLButtonElement | null>(null);
  const submitButtonRef = useRef<HTMLButtonElement | null>(null);
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

  return (
    <div className="mint-panel__cta">
      <div className={ctaStackClassName}>
        {showStripePaymentButton ? (
          <button
            ref={stripePaymentButtonRef}
            type="button"
            className={stripePaymentPending ? 'mint-panel__stripe mint-panel__stripe--busy' : 'mint-panel__stripe'}
            style={stripeActionTextFitStyle}
            onClick={() => {
              void onStripePayment();
            }}
            disabled={disabled}
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
            disabled={disabled}
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
  );
}
