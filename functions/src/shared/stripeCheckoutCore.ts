import type {
  DropFamily,
  SolanaCluster,
} from './deploymentCore.js';

export type StripeCheckoutMode = 'test' | 'live';
export type StripeCheckoutKind = 'size_variant' | 'standard_pack';

export type StripeCheckoutModeDropSource = {
  stripeCheckoutEnabled?: unknown;
  solanaCluster?: unknown;
};

export type StripeCheckoutKindSource = {
  itemsPerBox?: unknown;
  mintSelection?: {
    kind?: unknown;
  } | null;
};

export type StripeCheckoutUnitAmountResolution = {
  mode: StripeCheckoutMode | null;
  testConfiguredUnitAmountCents: unknown;
  testFallbackUnitAmountCents: unknown;
  liveConfiguredUnitAmountCents: unknown;
};

export const STRIPE_TEST_UNIT_AMOUNT_CENTS_DEFAULT = 100;
export const STRIPE_UNIT_AMOUNT_CENTS_MIN = 50;
export const STRIPE_UNIT_AMOUNT_CENTS_MAX = 99_999_999;
export const CARD_NFT_2_STRIPE_PRODUCT_TAX_CODE = 'txcd_99999999';

export type StripeCheckoutEnabledResolution = {
  enabled: boolean;
  disabledOverride: boolean;
};

export function defaultStripeCheckoutEnabledForDropFamily(
  dropFamily: DropFamily,
): boolean {
  return dropFamily === 'card_nft_2';
}

export function defaultStripeProductTaxCodeForDropFamily(
  dropFamily: DropFamily,
): string | undefined {
  return dropFamily === 'card_nft_2'
    ? CARD_NFT_2_STRIPE_PRODUCT_TAX_CODE
    : undefined;
}

export function resolveStripeCheckoutEnabledForDropFamily(
  value: unknown,
  dropFamily: DropFamily,
): StripeCheckoutEnabledResolution {
  if (value === true) return { enabled: true, disabledOverride: false };
  if (value === false) {
    return {
      enabled: false,
      disabledOverride:
        defaultStripeCheckoutEnabledForDropFamily(dropFamily),
    };
  }
  return {
    enabled: defaultStripeCheckoutEnabledForDropFamily(dropFamily),
    disabledOverride: false,
  };
}

export function resolveStripeProductTaxCodeForDropFamily(
  value: unknown,
  dropFamily: DropFamily,
  stripeCheckoutEnabled: boolean,
): string | undefined {
  const explicit = String(value ?? '').trim();
  if (explicit) return explicit;
  return stripeCheckoutEnabled
    ? defaultStripeProductTaxCodeForDropFamily(dropFamily)
    : undefined;
}

export function assertStripeLivePriceConfigured(args: {
  dropId: string;
  solanaCluster: SolanaCluster;
  stripeCheckoutEnabled: boolean;
  stripeLiveUnitAmountCents: number | null | undefined;
}): void {
  if (
    args.stripeCheckoutEnabled &&
    args.solanaCluster === 'mainnet-beta' &&
    args.stripeLiveUnitAmountCents == null
  ) {
    throw new Error(
      `stripeLiveUnitAmountCents is required for Stripe-enabled mainnet drop ${args.dropId}`,
    );
  }
}

export function stripeCheckoutModeForCluster(cluster: unknown): StripeCheckoutMode | null {
  if (cluster === 'devnet') return 'test';
  if (cluster === 'mainnet-beta') return 'live';
  return null;
}

export function stripeCheckoutModeForDrop(
  drop: StripeCheckoutModeDropSource | null | undefined,
): StripeCheckoutMode | null {
  if (!drop?.stripeCheckoutEnabled) return null;
  return stripeCheckoutModeForCluster(drop.solanaCluster);
}

export function classifyStripeCheckoutKind(
  source: StripeCheckoutKindSource | null | undefined,
): StripeCheckoutKind | null {
  if (!source) return null;
  const itemsPerBox = Math.floor(Number(source.itemsPerBox));
  if (itemsPerBox === 0 && source.mintSelection?.kind === 'size') return 'size_variant';
  if (itemsPerBox > 0 && !source.mintSelection) return 'standard_pack';
  return null;
}

export function normalizeStripeUnitAmountCents(value: unknown): number | null {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return null;
  if (parsed < STRIPE_UNIT_AMOUNT_CENTS_MIN || parsed > STRIPE_UNIT_AMOUNT_CENTS_MAX) return null;
  return parsed;
}

export function resolveStripeCheckoutUnitAmountCents(
  resolution: StripeCheckoutUnitAmountResolution,
): number | null {
  if (!resolution.mode) return null;
  if (resolution.mode === 'live') {
    return normalizeStripeUnitAmountCents(resolution.liveConfiguredUnitAmountCents);
  }
  return (
    normalizeStripeUnitAmountCents(resolution.testConfiguredUnitAmountCents) ||
    normalizeStripeUnitAmountCents(resolution.testFallbackUnitAmountCents)
  );
}
