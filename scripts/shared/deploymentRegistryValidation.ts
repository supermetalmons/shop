import { PublicKey } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  BOX_MINTER_CONFIG_SEED,
  BOX_MINTER_MAX_DISCOUNT_MINTS_PER_WALLET,
  BOX_MINTER_MAX_ITEMS_PER_BOX,
  BOX_MINTER_MIN_CONFIGURED_ITEMS_PER_BOX,
  BOX_MINTER_MIN_DISCOUNT_MINTS_PER_WALLET,
} from '../../shared/boxMinterProtocol.ts';
import {
  canonicalizeDropAssetUrl,
  metadataBasesForDrop,
  normalizeDiscountMintsPerWallet,
  normalizeDropBase,
  normalizeDropFamily,
  normalizeDropId,
  normalizeDropSalesMode,
  normalizeMetadataBaseAliases,
  normalizeMetadataPathFormat,
  normalizeMintSelectionConfig,
  type DropFamily,
  type MintSelectionConfig,
  type SolanaCluster,
} from '../../shared/deploymentCore.ts';
import {
  clonePaymentRoutingConfig,
  DEPLOYMENT_REGISTRY_DROP_FIELDS,
  normalizeAndValidatePaymentRouting,
  type BoxMinterConfigTombstone,
  type DeploymentRegistryDrop,
  type PaymentRoutingConfig,
  type ReceiptPoolDeployment,
} from '../../shared/deploymentRegistry.ts';
import { resolveDropMaxFigureId } from '../../shared/dropFigureIds.ts';
import { resolveDropInventoryManifest } from '../../shared/dropInventoryManifest.ts';
import {
  defaultBoxMediaConfigForDropFamily,
  defaultFigureMediaConfigForDropFamily,
} from '../../shared/dropMediaDefaults.ts';
import { normalizeMediaMapConfig } from '../../shared/mediaMap.ts';
import {
  assertStripeLivePriceConfigured,
  normalizeStripeUnitAmountCents,
  resolveStripeCheckoutEnabledForDropFamily,
  resolveStripeProductTaxCodeForDropFamily,
  STRIPE_UNIT_AMOUNT_CENTS_MAX,
  STRIPE_UNIT_AMOUNT_CENTS_MIN,
} from '../../shared/stripeCheckoutCore.ts';
import type {
  BoxMediaConfigSerialized,
  DeploymentDropConfigSerialized,
  FigureMediaConfigSerialized,
} from './deploymentRegistryTypes.ts';

const SAFE_DROP_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DROP_METADATA_IPFS_GATEWAY =
  'https://silver-real-rhinoceros-781.mypinata.cloud/ipfs/';
const IPFS_PROTOCOL = 'ipfs://';

export function normalizeAndValidateDropId(
  value: string | null | undefined,
  label = 'dropId',
): string {
  const normalized = normalizeDropId(String(value ?? ''));
  if (
    !SAFE_DROP_ID_PATTERN.test(normalized) ||
    Object.prototype.hasOwnProperty.call(Object.prototype, normalized)
  ) {
    throw new Error(
      `Invalid ${label}: ${String(value ?? '')} (expected 1-64 lowercase letters, numbers, underscores, or hyphens, starting with a letter or number)`,
    );
  }
  return normalized;
}

function asTrimmedString(value: unknown): string {
  return String(value ?? '').trim();
}

function asFiniteNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asSolanaCluster(value: unknown): SolanaCluster {
  if (
    value === 'devnet' ||
    value === 'testnet' ||
    value === 'mainnet-beta'
  ) {
    return value;
  }
  return String(value || '').trim() as SolanaCluster;
}

export function defaultSecondaryMarketHref(dropId: string): string | undefined {
  const normalizedDropId = normalizeDropId(dropId);
  return normalizedDropId
    ? `https://www.tensor.trade/trade/${normalizedDropId}`
    : undefined;
}

export function defaultFrontendFigureMediaForDropFamily(
  dropFamily: DropFamily,
): FigureMediaConfigSerialized | undefined {
  return defaultFigureMediaConfigForDropFamily(dropFamily);
}

export function defaultFrontendBoxMediaForDropFamily(
  dropFamily: DropFamily,
): BoxMediaConfigSerialized | undefined {
  return defaultBoxMediaConfigForDropFamily(dropFamily);
}

export function requireDropFamily(
  value: string,
  label: string,
): DropFamily {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (
    normalized === 'default' ||
    normalized === '111k' ||
    normalized === 'little_swag_boxes' ||
    normalized === 'little_swag_hoodies' ||
    normalized === 'poncho_drifella' ||
    normalized === 'doge_day_2026' ||
    normalized === 'drifella_binder' ||
    normalized === 'card_nft_binder' ||
    normalized === 'drifella_shirt' ||
    normalized === 'card_nft_2' ||
    normalized === 'clear_cards' ||
    normalized === 'mi_note_cards' ||
    normalized === 'tbd'
  ) {
    return normalized;
  }
  throw new Error(
    `Invalid ${label}: ${value} (expected default, 111k, little_swag_boxes, little_swag_hoodies, poncho_drifella, doge_day_2026, drifella_binder, card_nft_binder, drifella_shirt, card_nft_2, clear_cards, mi_note_cards, or tbd)`,
  );
}

export function normalizeAndValidateMetadataBaseInput(base: string): string {
  const trimmed = String(base || '').trim().replace(/\/+$/, '');
  if (!trimmed) {
    throw new Error(
      'metadataBase is required and must be an https://..., ipfs://..., or raw IPFS CID value.',
    );
  }
  if (trimmed.includes('?') || trimmed.includes('#')) {
    throw new Error(
      `Invalid metadataBase: ${trimmed}. Expected the drop root without query strings or fragments.`,
    );
  }
  const normalized = normalizeDropBase(trimmed);
  const supported =
    /^https?:\/\//i.test(normalized) ||
    normalized.toLowerCase().startsWith(IPFS_PROTOCOL);
  if (!supported) {
    throw new Error(
      `Invalid metadataBase: ${trimmed}. Expected https://..., http://..., ipfs://..., or a raw IPFS CID.`,
    );
  }
  const lower = normalized.toLowerCase();
  if (
    lower.endsWith('.json') ||
    lower.includes('/json/boxes') ||
    lower.includes('/json/figures') ||
    lower.includes('/json/receipts')
  ) {
    throw new Error(
      `Invalid metadataBase: ${trimmed}. Expected the drop root, not collection.json or a metadata asset path.`,
    );
  }
  return normalized;
}

export function resolveDropAssetUrl(url: string): string {
  const canonical = canonicalizeDropAssetUrl(url);
  if (!canonical.toLowerCase().startsWith(IPFS_PROTOCOL)) return canonical;
  return `${DROP_METADATA_IPFS_GATEWAY}${canonical
    .slice(IPFS_PROTOCOL.length)
    .replace(/^\/+/, '')}`;
}

type DeploymentDropNormalizationOptions = {
  forceSoldOutFallback?: (dropId: string) => boolean;
};

export function normalizeDeploymentDropForRegistry(
  raw: unknown,
  options: DeploymentDropNormalizationOptions = {},
): DeploymentDropConfigSerialized | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const object = raw as Record<string, unknown>;
  const operationsConfig = object.operationsConfig as DeploymentRegistryDrop['operationsConfig'];
  const inventoryManifest = object.inventoryManifest as DeploymentRegistryDrop['inventoryManifest'];
  const dropId = normalizeDropId(asTrimmedString(object.dropId));
  if (!dropId) return undefined;
  const dropFamily = normalizeDropFamily(object.dropFamily, dropId);
  const solanaCluster = asSolanaCluster(object.solanaCluster);
  const stripeCheckout = resolveStripeCheckoutEnabledForDropFamily(
    object.stripeCheckoutEnabled,
    dropFamily,
  );
  const stripeLiveUnitAmountCents =
    normalizeStripeUnitAmountCents(object.stripeLiveUnitAmountCents) ??
    undefined;
  assertStripeLivePriceConfigured({
    dropId,
    solanaCluster,
    stripeCheckoutEnabled: stripeCheckout.enabled,
    stripeLiveUnitAmountCents,
  });
  const stripeProductTaxCode =
    resolveStripeProductTaxCodeForDropFamily(
      object.stripeProductTaxCode,
      dropFamily,
      stripeCheckout.enabled,
    );
  const mintSelection = normalizeMintSelectionConfig(
    object.mintSelection as MintSelectionConfig | undefined,
  );
  const displayName = asTrimmedString(object.displayName);
  const salesMode = normalizeDropSalesMode(object.salesMode);
  const hasExplicitSalesMode = Object.prototype.hasOwnProperty.call(
    object,
    'salesMode',
  );
  const receiptPoolId = asTrimmedString(object.receiptPoolId).toLowerCase();
  const boxMinterConfigPda = asTrimmedString(object.boxMinterConfigPda);
  const secondaryMarketHref =
    asTrimmedString(object.secondaryMarketHref) ||
    defaultSecondaryMarketHref(dropId);
  const figureMedia =
    normalizeMediaMapConfig(object.figureMedia) ||
    defaultFrontendFigureMediaForDropFamily(dropFamily);
  const boxMedia =
    normalizeMediaMapConfig(object.boxMedia) ||
    defaultFrontendBoxMediaForDropFamily(dropFamily);
  const forceSoldOut =
    object.forceSoldOut === true ||
    options.forceSoldOutFallback?.(dropId) === true;
  const metadataBase = normalizeDropBase(
    asTrimmedString(object.metadataBase) ||
      asTrimmedString(
        (object.paths as Record<string, unknown> | undefined)?.base,
      ),
  );
  const metadataBaseAliases = normalizeMetadataBaseAliases(
    metadataBase,
    Array.isArray(object.metadataBaseAliases)
      ? object.metadataBaseAliases.map(asTrimmedString)
      : undefined,
  );
  const paymentRouting =
    object.paymentRouting == null
      ? undefined
      : normalizeAndValidatePaymentRouting(object.paymentRouting);

  return {
    solanaCluster,
    dropId,
    dropFamily,
    collectionName: asTrimmedString(object.collectionName) || dropId,
    ...(displayName ? { displayName } : {}),
    ...(hasExplicitSalesMode ? { salesMode } : {}),
    ...(receiptPoolId ? { receiptPoolId } : {}),
    metadataBase,
    ...(metadataBaseAliases.length ? { metadataBaseAliases } : {}),
    metadataPathFormat: normalizeMetadataPathFormat(
      object.metadataPathFormat,
    ),
    ...(secondaryMarketHref ? { secondaryMarketHref } : {}),
    ...(figureMedia ? { figureMedia } : {}),
    ...(boxMedia ? { boxMedia } : {}),
    ...(forceSoldOut ? { forceSoldOut: true } : {}),
    ...(mintSelection ? { mintSelection } : {}),
    ...(paymentRouting
      ? { paymentRouting }
      : { treasury: asTrimmedString(object.treasury) }),
    priceSol: asFiniteNumber(object.priceSol),
    discountPriceSol: asFiniteNumber(object.discountPriceSol),
    ...(stripeCheckout.enabled
      ? { stripeCheckoutEnabled: true }
      : stripeCheckout.disabledOverride
        ? { stripeCheckoutEnabled: false }
        : {}),
    ...(stripeLiveUnitAmountCents != null
      ? { stripeLiveUnitAmountCents }
      : {}),
    ...(stripeProductTaxCode ? { stripeProductTaxCode } : {}),
    discountMintsPerWallet: normalizeDiscountMintsPerWallet(
      object.discountMintsPerWallet,
    ),
    discountMerkleRoot: asTrimmedString(object.discountMerkleRoot),
    maxSupply: Math.floor(asFiniteNumber(object.maxSupply)),
    ...(operationsConfig ? { operationsConfig: { ...operationsConfig } } : {}),
    ...(inventoryManifest ? { inventoryManifest: { ...inventoryManifest, cardIds: [...inventoryManifest.cardIds] } } : {}),
    ...(Number.isInteger(object.receiptMaxId)
      ? {
          receiptMaxId: Math.floor(
            asFiniteNumber(object.receiptMaxId),
          ),
        }
      : {}),
    itemsPerBox: Math.floor(asFiniteNumber(object.itemsPerBox)),
    maxPerTx: Math.floor(asFiniteNumber(object.maxPerTx)),
    namePrefix: asTrimmedString(object.namePrefix),
    figureNamePrefix:
      asTrimmedString(object.figureNamePrefix) || 'figure',
    symbol: asTrimmedString(object.symbol),
    boxMinterProgramId: asTrimmedString(object.boxMinterProgramId),
    ...(boxMinterConfigPda ? { boxMinterConfigPda } : {}),
    collectionMint: asTrimmedString(object.collectionMint),
    receiptsMerkleTree: asTrimmedString(object.receiptsMerkleTree),
    ...(Number.isInteger(object.receiptsTreeMaxDepth)
      ? {
          receiptsTreeMaxDepth: Math.floor(
            asFiniteNumber(object.receiptsTreeMaxDepth),
          ),
        }
      : {}),
    ...(Number.isInteger(object.receiptsTreeCanopyDepth)
      ? {
          receiptsTreeCanopyDepth: Math.floor(
            asFiniteNumber(object.receiptsTreeCanopyDepth),
          ),
        }
      : {}),
    deliveryLookupTable: asTrimmedString(object.deliveryLookupTable),
  };
}

const DEPLOYMENT_REGISTRY_DROP_KEYS = new Set(
  Object.keys(DEPLOYMENT_REGISTRY_DROP_FIELDS),
);
const DEPLOYMENT_REGISTRY_REQUIRED_DROP_KEYS = Object.entries(
  DEPLOYMENT_REGISTRY_DROP_FIELDS,
)
  .filter(([, descriptor]) => descriptor.required)
  .map(([field]) => field);

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function normalizeReceiptPoolDeployment(
  raw: Record<string, unknown>,
): ReceiptPoolDeployment {
  return {
    solanaCluster: asSolanaCluster(raw.solanaCluster),
    receiptPoolId: asTrimmedString(raw.receiptPoolId).toLowerCase(),
    collectionMint: asTrimmedString(raw.collectionMint),
    receiptsMerkleTree: asTrimmedString(raw.receiptsMerkleTree),
    authority: asTrimmedString(raw.authority),
    collectionMetadataUri: asTrimmedString(raw.collectionMetadataUri),
    collectionName: asTrimmedString(raw.collectionName),
    collectionSymbol: asTrimmedString(raw.collectionSymbol),
    royaltiesBasisPoints: Math.floor(
      asFiniteNumber(raw.royaltiesBasisPoints),
    ),
    royaltiesRecipient: asTrimmedString(raw.royaltiesRecipient),
    receiptsTreeMaxDepth: Math.floor(
      asFiniteNumber(raw.receiptsTreeMaxDepth),
    ),
    receiptsTreeMaxBufferSize: Math.floor(
      asFiniteNumber(raw.receiptsTreeMaxBufferSize),
    ),
    receiptsTreeCanopyDepth: Math.floor(
      asFiniteNumber(raw.receiptsTreeCanopyDepth),
    ),
  };
}

export function assertValidReceiptPoolDeployment(args: {
  registryKey: string;
  value: unknown;
  filePath: string;
}): asserts args is {
  registryKey: string;
  value: Record<string, unknown>;
  filePath: string;
} {
  function invalid(reason: string): never {
    throw new Error(
      `Invalid receipt pool deployment ${args.registryKey}: ${reason}: ${args.filePath}`,
    );
  }
  if (!isPlainRecord(args.value)) return invalid('expected an object');
  const row = args.value;
  const allowed = new Set([
    'solanaCluster',
    'receiptPoolId',
    'collectionMint',
    'receiptsMerkleTree',
    'authority',
    'collectionMetadataUri',
    'collectionName',
    'collectionSymbol',
    'royaltiesBasisPoints',
    'royaltiesRecipient',
    'receiptsTreeMaxDepth',
    'receiptsTreeMaxBufferSize',
    'receiptsTreeCanopyDepth',
  ]);
  const unknown = Object.keys(row).find((key) => !allowed.has(key));
  if (unknown) invalid(`unknown field ${unknown}`);
  for (const field of allowed) {
    if (!Object.prototype.hasOwnProperty.call(row, field)) {
      invalid(`${field} is required`);
    }
  }
  const requireString = (field: string): string => {
    const value = row[field];
    if (typeof value !== 'string' || !value || value !== value.trim()) {
      return invalid(`${field} must be a non-empty trimmed string`);
    }
    return value;
  };
  const requireInteger = (
    field: string,
    min: number,
    max: number,
  ): number => {
    const value = row[field];
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < min ||
      value > max
    ) {
      return invalid(`${field} has an invalid integer value`);
    }
    return value;
  };
  const cluster = requireString('solanaCluster');
  if (
    cluster !== 'devnet' &&
    cluster !== 'testnet' &&
    cluster !== 'mainnet-beta'
  ) {
    invalid('solanaCluster is unsupported');
  }
  const receiptPoolId = requireString('receiptPoolId');
  if (
    normalizeAndValidateDropId(receiptPoolId, 'receiptPoolId') !==
    receiptPoolId
  ) {
    invalid('receiptPoolId must be normalized');
  }
  if (args.registryKey !== `${cluster}:${receiptPoolId}`) {
    invalid('registry key must equal solanaCluster:receiptPoolId');
  }
  for (const field of [
    'collectionMint',
    'receiptsMerkleTree',
    'authority',
    'collectionMetadataUri',
    'collectionName',
    'collectionSymbol',
    'royaltiesRecipient',
  ]) {
    requireString(field);
  }
  requireInteger('royaltiesBasisPoints', 0, 10_000);
  const maxDepth = requireInteger('receiptsTreeMaxDepth', 1, 30);
  requireInteger('receiptsTreeMaxBufferSize', 1, 2048);
  const canopyDepth = requireInteger(
    'receiptsTreeCanopyDepth',
    0,
    29,
  );
  if (canopyDepth >= maxDepth) {
    invalid('receiptsTreeCanopyDepth must be smaller than max depth');
  }
}

export function assertReceiptPoolDropRelations(args: {
  drops: Record<string, DeploymentDropConfigSerialized>;
  receiptPools: Record<string, ReceiptPoolDeployment>;
}): void {
  const metadataByPool = new Map<string, Map<string, string>>();
  const poolIdsByIdentity = new Map<string, string>();
  Object.entries(args.receiptPools).forEach(([key, pool]) => {
    const identity =
      `${pool.solanaCluster}:${pool.collectionMint}:${pool.receiptsMerkleTree}`;
    const duplicate = poolIdsByIdentity.get(identity);
    if (duplicate) {
      throw new Error(
        `Receipt pools ${duplicate} and ${key} use the same collection and tree`,
      );
    }
    poolIdsByIdentity.set(identity, key);
  });
  Object.values(args.drops).forEach((drop) => {
    const salesMode = normalizeDropSalesMode(drop.salesMode);
    if (!drop.receiptPoolId && salesMode !== 'stripe_receipt_only') {
      return;
    }
    if (!drop.receiptPoolId || salesMode !== 'stripe_receipt_only') {
      throw new Error(
        `Deployment registry drop ${drop.dropId} must pair receiptPoolId with salesMode=stripe_receipt_only`,
      );
    }
    const key = `${drop.solanaCluster}:${drop.receiptPoolId}`;
    const pool = args.receiptPools[key];
    if (!pool) {
      throw new Error(
        `Deployment registry drop ${drop.dropId} references missing receipt pool ${key}`,
      );
    }
    const mismatches = [
      drop.collectionMint === pool.collectionMint ? '' : 'collectionMint',
      drop.collectionName === pool.collectionName ? '' : 'collectionName',
      drop.symbol === pool.collectionSymbol ? '' : 'symbol',
      drop.receiptsMerkleTree === pool.receiptsMerkleTree
        ? ''
        : 'receiptsMerkleTree',
      drop.receiptsTreeMaxDepth === pool.receiptsTreeMaxDepth
        ? ''
        : 'receiptsTreeMaxDepth',
      drop.receiptsTreeCanopyDepth === pool.receiptsTreeCanopyDepth
        ? ''
        : 'receiptsTreeCanopyDepth',
    ].filter(Boolean);
    if (mismatches.length) {
      throw new Error(
        `Deployment registry drop ${drop.dropId} does not match receipt pool ${key}: ${mismatches.join(', ')}`,
      );
    }
    const identity =
      `${pool.solanaCluster}:${pool.collectionMint}:${pool.receiptsMerkleTree}`;
    const seen =
      metadataByPool.get(identity) ?? new Map<string, string>();
    for (const normalizedMetadataBase of metadataBasesForDrop(
      drop.metadataBase,
      drop.metadataBaseAliases,
    )) {
      const duplicateDropId = seen.get(normalizedMetadataBase);
      if (duplicateDropId) {
        throw new Error(
          `Receipt pool ${key} has duplicate metadataBase for ${duplicateDropId} and ${drop.dropId}`,
        );
      }
      seen.set(normalizedMetadataBase, drop.dropId);
    }
    metadataByPool.set(identity, seen);
  });
}

export function assertValidCanonicalRegistryRow(args: {
  registryKey: string;
  value: unknown;
  filePath: string;
}): asserts args is {
  registryKey: string;
  value: Record<string, unknown>;
  filePath: string;
} {
  function invalid(reason: string): never {
    throw new Error(
      `Invalid canonical deployment registry row ${args.registryKey}: ${reason}: ${args.filePath}`,
    );
  }
  if (!isPlainRecord(args.value)) return invalid('expected an object');
  const row = args.value;
  const unknownKey = Object.keys(row).find(
    (key) => !DEPLOYMENT_REGISTRY_DROP_KEYS.has(key),
  );
  if (unknownKey) invalid(`unknown field ${unknownKey}`);
  const missingRequiredKey = DEPLOYMENT_REGISTRY_REQUIRED_DROP_KEYS.find(
    (key) => !Object.prototype.hasOwnProperty.call(row, key),
  );
  if (missingRequiredKey) {
    invalid(`${missingRequiredKey} is required`);
  }

  const requireString = (
    field: string,
    options: { allowEmpty?: boolean } = {},
  ): string => {
    const value = row[field];
    if (
      typeof value !== 'string' ||
      value !== value.trim() ||
      (!options.allowEmpty && !value)
    ) {
      return invalid(`${field} must be a${options.allowEmpty ? '' : ' non-empty'} trimmed string`);
    }
    return value;
  };
  const requireNumber = (
    field: string,
    options: {
      integer?: boolean;
      min?: number;
      max?: number;
    } = {},
  ): number => {
    const value = row[field];
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (options.integer && !Number.isInteger(value)) ||
      (options.min != null && value < options.min) ||
      (options.max != null && value > options.max)
    ) {
      return invalid(`${field} has an invalid numeric value`);
    }
    return value;
  };
  const assertOptionalString = (field: string): void => {
    if (!Object.prototype.hasOwnProperty.call(row, field)) return;
    requireString(field);
  };
  const assertOptionalBoolean = (field: string): void => {
    if (
      Object.prototype.hasOwnProperty.call(row, field) &&
      typeof row[field] !== 'boolean'
    ) {
      invalid(`${field} must be a boolean`);
    }
  };

  const solanaCluster = requireString('solanaCluster');
  if (
    solanaCluster !== 'devnet' &&
    solanaCluster !== 'testnet' &&
    solanaCluster !== 'mainnet-beta'
  ) {
    invalid('solanaCluster is unsupported');
  }
  let normalizedRegistryKey: string;
  try {
    normalizedRegistryKey = normalizeAndValidateDropId(
      args.registryKey,
      'deployment registry key',
    );
  } catch {
    invalid('registry key is not a safe normalized dropId');
  }
  if (normalizedRegistryKey !== args.registryKey) {
    invalid('registry key must be normalized');
  }
  const dropId = requireString('dropId');
  let normalizedDropId: string;
  try {
    normalizedDropId = normalizeAndValidateDropId(dropId);
  } catch {
    invalid('dropId is not a safe deployment slug');
  }
  if (normalizedDropId !== dropId) {
    invalid('dropId must be normalized');
  }
  const dropFamily = requireString('dropFamily');
  if (normalizeDropFamily(dropFamily, dropId) !== dropFamily) {
    invalid('dropFamily is unsupported');
  }
  requireString('collectionName');
  assertOptionalString('displayName');
  assertOptionalString('receiptPoolId');
  if (
    Object.prototype.hasOwnProperty.call(row, 'salesMode') &&
    normalizeDropSalesMode(row['salesMode']) !== row['salesMode']
  ) {
    invalid('salesMode is unsupported or non-canonical');
  }
  if (Object.prototype.hasOwnProperty.call(row, 'receiptPoolId')) {
    const receiptPoolId = requireString('receiptPoolId');
    let normalizedReceiptPoolId: string;
    try {
      normalizedReceiptPoolId = normalizeAndValidateDropId(
        receiptPoolId,
        'receiptPoolId',
      );
    } catch {
      invalid('receiptPoolId is not a safe normalized identifier');
    }
    if (normalizedReceiptPoolId !== receiptPoolId) {
      invalid('receiptPoolId must be normalized');
    }
  }
  const metadataBase = requireString('metadataBase');
  if (normalizeAndValidateMetadataBaseInput(metadataBase) !== metadataBase) {
    invalid('metadataBase must be canonical');
  }
  if (Object.prototype.hasOwnProperty.call(row, 'metadataBaseAliases')) {
    const aliases = row['metadataBaseAliases'];
    if (!Array.isArray(aliases) || aliases.length === 0) {
      return invalid('metadataBaseAliases must be a non-empty array');
    }
    const normalizedAliases = aliases.map((alias) => {
      if (typeof alias !== 'string' || !alias || alias !== alias.trim()) {
        invalid('metadataBaseAliases must contain non-empty trimmed strings');
      }
      try {
        return normalizeAndValidateMetadataBaseInput(alias);
      } catch {
        invalid('metadataBaseAliases contains an invalid metadata base');
      }
    });
    if (!isDeepStrictEqual(normalizedAliases, aliases)) {
      invalid('metadataBaseAliases must be canonical');
    }
    if (normalizeMetadataBaseAliases(metadataBase, normalizedAliases).length !== aliases.length) {
      invalid('metadataBaseAliases must exclude the canonical base and duplicates');
    }
  }
  const metadataPathFormat = requireString('metadataPathFormat');
  if (
    metadataPathFormat !== 'legacy' &&
    metadataPathFormat !== 'compact'
  ) {
    invalid('metadataPathFormat is unsupported');
  }

  const hasTreasury = Object.prototype.hasOwnProperty.call(row, 'treasury');
  const hasPaymentRouting = Object.prototype.hasOwnProperty.call(
    row,
    'paymentRouting',
  );
  if (hasTreasury === hasPaymentRouting) {
    invalid('exactly one of treasury or paymentRouting is required');
  }
  if (hasTreasury) {
    requireString('treasury');
  } else {
    let normalizedPaymentRouting: PaymentRoutingConfig;
    try {
      normalizedPaymentRouting = normalizeAndValidatePaymentRouting(
        row['paymentRouting'],
      );
    } catch (error) {
      invalid(error instanceof Error ? error.message : String(error));
    }
    if (!isDeepStrictEqual(normalizedPaymentRouting, row['paymentRouting'])) {
      invalid('paymentRouting must be canonical');
    }
  }
  requireNumber('priceSol', { min: 0 });
  requireNumber('discountPriceSol', { min: 0 });
  requireNumber('discountMintsPerWallet', {
    integer: true,
    min: BOX_MINTER_MIN_DISCOUNT_MINTS_PER_WALLET,
    max: BOX_MINTER_MAX_DISCOUNT_MINTS_PER_WALLET,
  });
  const discountMerkleRoot = requireString('discountMerkleRoot');
  if (!/^[0-9a-f]{64}$/.test(discountMerkleRoot)) {
    invalid('discountMerkleRoot must be 32 lowercase hexadecimal bytes');
  }
  const maxSupply = requireNumber('maxSupply', {
    integer: true,
    min: 1,
    max: 0xffff_ffff,
  });
  if (Object.prototype.hasOwnProperty.call(row, 'receiptMaxId')) {
    const receiptMaxId = requireNumber('receiptMaxId', {
      integer: true,
      min: 1,
      max: 0xffff_ffff,
    });
    if (receiptMaxId < maxSupply) {
      invalid('receiptMaxId must be greater than or equal to maxSupply');
    }
    if (!Object.prototype.hasOwnProperty.call(row, 'receiptPoolId')) {
      invalid('receiptMaxId requires receiptPoolId');
    }
  }
  const itemsPerBox = requireNumber('itemsPerBox', {
    integer: true,
    min: BOX_MINTER_MIN_CONFIGURED_ITEMS_PER_BOX,
    max: BOX_MINTER_MAX_ITEMS_PER_BOX,
  });
  if (maxSupply * itemsPerBox > 0xffff) {
    invalid('maxSupply and itemsPerBox exceed the supported figure ID range');
  }
  if (Object.prototype.hasOwnProperty.call(row, 'operationsConfig')) {
    const operations = row.operationsConfig;
    if (!isPlainRecord(operations) ||
      Object.keys(operations).sort().join(',') !== 'boxMinterConfigPda,configId,maxSupply' ||
      typeof operations.configId !== 'string' ||
      normalizeAndValidateDropId(operations.configId, 'operations configId') !== operations.configId ||
      operations.configId === dropId || !Number.isSafeInteger(operations.maxSupply) ||
      Number(operations.maxSupply) < maxSupply || itemsPerBox < 1 ||
      row.receiptPoolId !== undefined || row.mintSelection !== undefined) {
      return invalid('operationsConfig must describe a distinct config for an openable dedicated drop');
    }
    const program = new PublicKey(requireString('boxMinterProgramId'));
    for (const [configId, configPda] of [[dropId, row.boxMinterConfigPda], [operations.configId, operations.boxMinterConfigPda]]) {
      if (typeof configId !== 'string' || typeof configPda !== 'string') return invalid('Both config roles require an identity and PDA');
      const expected = PublicKey.findProgramAddressSync([
        Buffer.from(BOX_MINTER_CONFIG_SEED), createHash('sha256').update(configId).digest(),
      ], program)[0].toBase58();
      if (configPda !== expected) invalid(`Config PDA must match its role identity ${configId}`);
    }
  }
  try {
    resolveDropMaxFigureId(row as DeploymentRegistryDrop);
    resolveDropInventoryManifest(row as DeploymentRegistryDrop);
  } catch (error) {
    invalid(error instanceof Error ? error.message : String(error));
  }
  const maxPerTx = requireNumber('maxPerTx', {
    integer: true,
    min: 1,
    max: 0xff,
  });
  requireString('namePrefix');
  requireString('figureNamePrefix');
  requireString('symbol');
  requireString('boxMinterProgramId');
  requireString('collectionMint');
  requireString('receiptsMerkleTree');
  requireString('deliveryLookupTable', { allowEmpty: true });
  if (Object.prototype.hasOwnProperty.call(row, 'receiptsTreeMaxDepth')) {
    requireNumber('receiptsTreeMaxDepth', {
      integer: true,
      min: 1,
      max: 30,
    });
  }
  if (
    Object.prototype.hasOwnProperty.call(row, 'receiptsTreeCanopyDepth')
  ) {
    const canopyDepth = requireNumber('receiptsTreeCanopyDepth', {
      integer: true,
      min: 0,
      max: 29,
    });
    const maxDepth = row['receiptsTreeMaxDepth'];
    if (
      typeof maxDepth !== 'number' ||
      !Number.isInteger(maxDepth) ||
      canopyDepth >= maxDepth
    ) {
      invalid(
        'receiptsTreeCanopyDepth requires receiptsTreeMaxDepth and must be smaller',
      );
    }
  }

  assertOptionalString('secondaryMarketHref');
  assertOptionalString('stripeProductTaxCode');
  assertOptionalString('boxMinterConfigPda');
  assertOptionalBoolean('forceSoldOut');
  assertOptionalBoolean('stripeCheckoutEnabled');
  if (Object.prototype.hasOwnProperty.call(row, 'stripeLiveUnitAmountCents')) {
    requireNumber('stripeLiveUnitAmountCents', {
      integer: true,
      min: STRIPE_UNIT_AMOUNT_CENTS_MIN,
      max: STRIPE_UNIT_AMOUNT_CENTS_MAX,
    });
  }

  for (const field of ['figureMedia', 'boxMedia'] as const) {
    if (!Object.prototype.hasOwnProperty.call(row, field)) continue;
    const normalized = normalizeMediaMapConfig(row[field]);
    if (!normalized || !isDeepStrictEqual(normalized, row[field])) {
      invalid(`${field} is malformed or non-canonical`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(row, 'mintSelection')) {
    const mintSelection = row['mintSelection'];
    const normalized = normalizeMintSelectionConfig(
      mintSelection as MintSelectionConfig | undefined,
    );
    if (!normalized || !isDeepStrictEqual(normalized, mintSelection)) {
      invalid('mintSelection is malformed or non-canonical');
    }
  }
  if (
    normalizeDropSalesMode(row['salesMode']) === 'stripe_receipt_only'
  ) {
    if (!requireString('displayName')) {
      invalid('displayName is required for stripe_receipt_only');
    }
    if (!requireString('receiptPoolId')) {
      invalid('receiptPoolId is required for stripe_receipt_only');
    }
    if (itemsPerBox !== 0) {
      invalid('stripe_receipt_only requires itemsPerBox=0');
    }
    if (
      row['priceSol'] !== 1_000_000 ||
      row['discountPriceSol'] !== 1_000_000
    ) {
      invalid(
        'stripe_receipt_only requires sentinel SOL prices of 1000000',
      );
    }
    if (maxPerTx !== 1) {
      invalid('stripe_receipt_only requires maxPerTx=1');
    }
    if (Object.prototype.hasOwnProperty.call(row, 'mintSelection')) {
      invalid('stripe_receipt_only does not support mintSelection');
    }
    if (
      !resolveStripeCheckoutEnabledForDropFamily(
        row['stripeCheckoutEnabled'],
        dropFamily as DropFamily,
      ).enabled
    ) {
      invalid('stripe_receipt_only requires Stripe checkout');
    }
    if (
      !Object.prototype.hasOwnProperty.call(row, 'receiptsTreeMaxDepth') ||
      !Object.prototype.hasOwnProperty.call(
        row,
        'receiptsTreeCanopyDepth',
      )
    ) {
      invalid(
        'stripe_receipt_only requires receipt tree depth and canopy fields',
      );
    }
  }
}

const BOX_MINTER_CONFIG_TOMBSTONE_FIELDS = new Set([
  'solanaCluster',
  'dropId',
  'dropSeed',
  'boxMinterProgramId',
  'boxMinterConfigPda',
  'collectionMint',
  'accountSize',
  'schema',
  'treasury',
  'paymentRouting',
  'reason',
]);

function normalizeCanonicalPublicKey(value: unknown, label: string): string {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(`${label} must be a non-empty trimmed Solana public key`);
  }
  let normalized: string;
  try {
    normalized = new PublicKey(value).toBase58();
  } catch {
    throw new Error(`${label} must be a valid Solana public key`);
  }
  if (normalized === PublicKey.default.toBase58()) {
    throw new Error(`${label} must not be the default public key`);
  }
  if (normalized !== value) {
    throw new Error(`${label} must be canonical base58`);
  }
  return normalized;
}

export function normalizeBoxMinterConfigTombstone(args: {
  registryKey: string;
  value: unknown;
  filePath: string;
}): BoxMinterConfigTombstone {
  function invalid(reason: string): never {
    throw new Error(
      `Invalid BoxMinter config tombstone ${args.registryKey}: ${reason}: ${args.filePath}`,
    );
  }
  if (!isPlainRecord(args.value)) invalid('expected an object');
  const row = args.value as Record<string, unknown>;
  const unknownField = Object.keys(row).find(
    (field) => !BOX_MINTER_CONFIG_TOMBSTONE_FIELDS.has(field),
  );
  if (unknownField) invalid(`unknown field ${unknownField}`);
  const requireTrimmedString = (field: string): string => {
    const value = row[field];
    if (typeof value !== 'string' || value !== value.trim() || !value) {
      invalid(`${field} must be a non-empty trimmed string`);
    }
    return value as string;
  };

  let dropId: string;
  try {
    dropId = normalizeAndValidateDropId(requireTrimmedString('dropId'));
  } catch (error) {
    invalid(error instanceof Error ? error.message : String(error));
  }
  if (dropId !== args.registryKey) {
    invalid('registry key must equal dropId');
  }
  const solanaClusterValue = requireTrimmedString('solanaCluster');
  if (
    solanaClusterValue !== 'devnet' &&
    solanaClusterValue !== 'testnet' &&
    solanaClusterValue !== 'mainnet-beta'
  ) {
    invalid('solanaCluster is unsupported');
  }
  const solanaCluster = solanaClusterValue as SolanaCluster;
  const dropSeed = requireTrimmedString('dropSeed');
  const expectedDropSeed = createHash('sha256')
    .update(dropId, 'utf8')
    .digest('hex');
  if (dropSeed !== expectedDropSeed) {
    invalid(`dropSeed must equal sha256(dropId), expected ${expectedDropSeed}`);
  }
  let boxMinterProgramId: string;
  let boxMinterConfigPda: string;
  let collectionMint: string;
  try {
    boxMinterProgramId = normalizeCanonicalPublicKey(
      row.boxMinterProgramId,
      'boxMinterProgramId',
    );
    boxMinterConfigPda = normalizeCanonicalPublicKey(
      row.boxMinterConfigPda,
      'boxMinterConfigPda',
    );
    collectionMint = normalizeCanonicalPublicKey(
      row.collectionMint,
      'collectionMint',
    );
  } catch (error) {
    invalid(error instanceof Error ? error.message : String(error));
  }
  const expectedConfigPda = PublicKey.findProgramAddressSync(
    [Buffer.from(BOX_MINTER_CONFIG_SEED), Buffer.from(dropSeed, 'hex')],
    new PublicKey(boxMinterProgramId),
  )[0].toBase58();
  if (boxMinterConfigPda !== expectedConfigPda) {
    invalid(`boxMinterConfigPda must derive to ${expectedConfigPda}`);
  }
  const reasonValue = requireTrimmedString('reason');
  if (reasonValue !== 'historical-orphan' && reasonValue !== 'drop-wiped') {
    invalid('reason is unsupported');
  }
  const reason = reasonValue as BoxMinterConfigTombstone['reason'];
  const hasTreasury = Object.prototype.hasOwnProperty.call(row, 'treasury');
  const hasPaymentRouting = Object.prototype.hasOwnProperty.call(
    row,
    'paymentRouting',
  );
  if (hasTreasury === hasPaymentRouting) {
    invalid('exactly one of treasury or paymentRouting is required');
  }
  if (hasTreasury) {
    if (row.accountSize !== 376 || row.schema !== 'legacy') {
      invalid('legacy tombstones require accountSize=376 and schema=legacy');
    }
    let treasury: string;
    try {
      treasury = normalizeCanonicalPublicKey(row.treasury, 'treasury');
    } catch (error) {
      invalid(error instanceof Error ? error.message : String(error));
    }
    return {
      solanaCluster,
      dropId,
      dropSeed,
      boxMinterProgramId,
      boxMinterConfigPda,
      collectionMint,
      accountSize: 376,
      schema: 'legacy',
      treasury,
      reason,
    };
  }
  if (row.accountSize !== 488 || row.schema !== 'split-payments-v1') {
    invalid(
      'split-payment tombstones require accountSize=488 and schema=split-payments-v1',
    );
  }
  let paymentRouting: PaymentRoutingConfig;
  try {
    paymentRouting = clonePaymentRoutingConfig(
      row.paymentRouting,
      'paymentRouting',
    );
  } catch (error) {
    invalid(error instanceof Error ? error.message : String(error));
  }
  if (!isDeepStrictEqual(paymentRouting, row.paymentRouting)) {
    invalid('paymentRouting must be canonical');
  }
  return {
    solanaCluster,
    dropId,
    dropSeed,
    boxMinterProgramId,
    boxMinterConfigPda,
    collectionMint,
    accountSize: 488,
    schema: 'split-payments-v1',
    paymentRouting,
    reason,
  };
}

export function assertNoBoxMinterConfigRegistryCollisions(args: {
  drops: Record<string, DeploymentDropConfigSerialized>;
  tombstones: Record<string, BoxMinterConfigTombstone>;
  filePath: string;
}): void {
  const configOwners = new Map<string, string>();
  const identities = new Map<string, string>();
  const claimIdentity = (identity: string, owner: string) => {
    const previous = identities.get(identity);
    if (previous) throw new Error(`Deployment config identity collision between ${previous} and ${owner}: ${identity}`);
    identities.set(identity, owner);
  };
  Object.entries(args.drops).forEach(([dropId, drop]) => {
    claimIdentity(dropId, `active drop ${dropId}`);
    if (drop.operationsConfig) claimIdentity(drop.operationsConfig.configId, `operations for ${dropId}`);
    if (Object.prototype.hasOwnProperty.call(args.tombstones, dropId)) {
      throw new Error(
        `Deployment registry drop ${dropId} cannot also be a BoxMinter config tombstone: ${args.filePath}`,
      );
    }
    for (const configPda of [drop.boxMinterConfigPda, drop.operationsConfig?.boxMinterConfigPda]) {
      if (!configPda) continue;
      const key = `${drop.solanaCluster}:${configPda}`;
      const duplicate = configOwners.get(key);
      if (duplicate) {
        throw new Error(
          `Deployment registry config PDA collision between ${duplicate} and ${dropId}: ${args.filePath}`,
        );
      }
      configOwners.set(key, `active drop ${dropId}`);
    }
  });
  Object.entries(args.tombstones).forEach(([dropId, tombstone]) => {
    claimIdentity(dropId, `tombstone ${dropId}`);
    const key = `${tombstone.solanaCluster}:${tombstone.boxMinterConfigPda}`;
    const duplicate = configOwners.get(key);
    if (duplicate) {
      throw new Error(
        `Deployment registry config PDA collision between ${duplicate} and tombstone ${dropId}: ${args.filePath}`,
      );
    }
    configOwners.set(key, `tombstone ${dropId}`);
  });
}
