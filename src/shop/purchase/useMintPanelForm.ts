import { useEffect, useMemo, useState } from 'react';
import type { MintStats } from '../../types';
import type { MintSelectionConfig } from '../../config/deployment';
import { useAsyncSubmit } from '../../hooks/useAsyncSubmit';
import { deriveMintSelectionAvailabilityFromConfig } from '../../lib/boxMinter';
import { dropAssetCount } from '../../../shared/dropLabels.ts';

export interface MintPanelFormOptions {
  stats?: MintStats;
  onMint: (quantity: number, variantKey?: string) => void | Promise<void>;
  solanaMintVisible?: boolean;
  busy: boolean;
  onError?: (message: string) => void;
  boxNamePrefix?: string;
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
}

const REMAINING_OVERRIDE: number | null = null;

const LAMPORTS_PER_SOL_UI = 1_000_000_000;
const STRIPE_USD_PRICE_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

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

export function useMintPanelForm({
  stats, onMint, solanaMintVisible = true, busy, onError, boxNamePrefix,
  priceSol, discountPriceSol, maxSupply, maxPerTx,
  discountAvailable, discountMaxQuantity, onDiscountMint, discountBusy,
  onStripePaymentClick, stripePaymentVisible, stripePaymentBusy,
  stripePaymentPriceLabel, stripePaymentUnitAmountCents,
  mintSelection, successfulMintToken = 0,
}: MintPanelFormOptions) {
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
  const [sizeBlinkToken, setSizeBlinkToken] = useState(0);
  const [isBlinking, setIsBlinking] = useState(false);
  const mintSubmitOptions = {
    formatError: (error: unknown) => error instanceof Error ? error.message : 'Failed to mint',
    onError,
  };
  const mintSubmit = useAsyncSubmit(mintSubmitOptions);
  const discountSubmit = useAsyncSubmit(mintSubmitOptions);
  const stripeSubmit = useAsyncSubmit({
    formatError: (error) => error instanceof Error ? error.message : 'Failed to start Stripe payment',
    onError,
  });
  const stripePaymentPending = Boolean(stripePaymentBusy) || stripeSubmit.pending;
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
  const submitBusy = busy || discountSubmit.pending || (useDiscountMint && Boolean(discountBusy));
  const controlsBusy = submitBusy || stripePaymentPending;

  const canSubmit = () => {
    if (controlsBusy || mintSubmit.isPending() || discountSubmit.isPending() || stripeSubmit.isPending()) return false;
    if (showSizeSelector && !selectedSize) {
      setSizeBlinkToken((prev) => prev + 1);
      return false;
    }
    return quantity >= 1 && quantity <= maxSelectable;
  };

  const handleMint = async () => {
    if (!showSolanaMintButton || !canSubmit()) return;
    if (useDiscountMint) {
      if (!onDiscountMint) return;
      await discountSubmit.run(() => onDiscountMint(quantity, selectedSize || undefined));
      return;
    }
    await mintSubmit.run(() => onMint(quantity, selectedSize || undefined));
  };

  const handleStripePaymentClick = async () => {
    if (!onStripePaymentClick || !canSubmit()) return;
    await stripeSubmit.run(() => onStripePaymentClick(quantity, selectedSize || undefined));
  };

  const toggleSize = (key: string) => {
    if ((sizeAvailability[key] ?? 0) <= 0) return;
    setSelectedSize((previous) => previous === key ? null : key);
  };

  return {
    total, remaining, remainingReady, soldOut,
    quantity, setQuantity, quantityLabel, maxSelectable,
    sizeOptions, sizeAvailability, selectedSize, toggleSize, sizeBlinkToken, isBlinking,
    showSizeSelector, showQuantitySlider, showFormControls,
    totalPriceLabel, totalDiscountPriceLabel, stripePaymentDisplayPriceLabel,
    showSolanaMintButton, showStripePaymentButton, useDiscountMint,
    submitBusy, stripePaymentPending, controlsBusy,
    actionsDisabled: controlsBusy || quantity < 1 || quantity > maxSelectable,
    handleMint, handleStripePaymentClick,
  };
}
