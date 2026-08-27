import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { PublicKey } from '@solana/web3.js';
import ts from 'typescript';
import {
  defaultBoxMediaConfigForDropFamily,
  defaultFigureMediaConfigForDropFamily,
} from '../../shared/dropMediaDefaults.ts';
import {
  BOX_MINTER_CONFIG_TOMBSTONES,
  DEPLOYMENT_REGISTRY_DROP_FIELDS,
  clonePaymentRoutingConfig,
  deploymentTreasuryAlias,
  normalizeAndValidatePaymentRouting,
  type BoxMinterConfigTombstone,
  type DeploymentMediaMapConfig,
  type DeploymentRegistryDrop,
  type PaymentRoutingConfig,
  type ReceiptPoolDeployment,
} from '../../shared/deploymentRegistry.ts';
import {
  normalizeMediaMapConfig,
} from '../../shared/mediaMap.ts';
import {
  assertStripeLivePriceConfigured,
  CARD_NFT_2_STRIPE_PRODUCT_TAX_CODE,
  defaultStripeCheckoutEnabledForDropFamily,
  defaultStripeProductTaxCodeForDropFamily,
  normalizeStripeUnitAmountCents,
  resolveStripeCheckoutEnabledForDropFamily,
  resolveStripeProductTaxCodeForDropFamily,
  STRIPE_UNIT_AMOUNT_CENTS_MAX,
  STRIPE_UNIT_AMOUNT_CENTS_MIN,
} from '../../shared/stripeCheckoutCore.ts';
import {
  BOX_MINTER_CONFIG_SEED,
  BOX_MINTER_MAX_DISCOUNT_MINTS_PER_WALLET,
  BOX_MINTER_MAX_ITEMS_PER_BOX,
  BOX_MINTER_MIN_CONFIGURED_ITEMS_PER_BOX,
  BOX_MINTER_MIN_DISCOUNT_MINTS_PER_WALLET,
} from '../../shared/boxMinterProtocol.ts';
import {
  canonicalizeDropAssetUrl,
  defaultDropFamilyForDropId,
  dropPathsFromBase,
  metadataBasesForDrop,
  normalizeDiscountMintsPerWallet,
  normalizeDropBase,
  normalizeDropFamily,
  normalizeDropId,
  normalizeDropSalesMode,
  normalizeMetadataPathFormat,
  normalizeMetadataBaseAliases,
  normalizeMintSelectionConfig,
  type DropFamily,
  type DropSalesMode,
  type MetadataPathFormat,
  type MintSelectionConfig,
  type SolanaCluster,
} from '../../shared/deploymentCore.ts';
import {
  isOptimisticTextFilePostCommitVerificationError,
  writeOptimisticTextFile,
  type OptimisticTextFileWriteIo,
} from './optimisticTextFile.ts';

export {
  CARD_NFT_2_STRIPE_PRODUCT_TAX_CODE,
  canonicalizeDropAssetUrl,
  defaultDropFamilyForDropId,
  dropPathsFromBase,
  normalizeDropBase,
  normalizeDropId,
  normalizeDropSalesMode,
  clonePaymentRoutingConfig,
  normalizeAndValidatePaymentRouting,
  resolveStripeCheckoutEnabledForDropFamily,
  resolveStripeProductTaxCodeForDropFamily,
};
export type {
  DropFamily,
  DropSalesMode,
  MetadataPathFormat,
  MintSelectionConfig,
  BoxMinterConfigTombstone,
  PaymentRoutingConfig,
  ReceiptPoolDeployment,
};

export type MediaMapConfigSerialized = DeploymentMediaMapConfig;

export type FigureMediaConfigSerialized = MediaMapConfigSerialized;
export type BoxMediaConfigSerialized = MediaMapConfigSerialized;
export type MintSelectionConfigSerialized = MintSelectionConfig;

export type DeploymentDropConfigSerialized = DeploymentRegistryDrop;

export type DeploymentDropRegistry = {
  drops: Record<string, DeploymentDropConfigSerialized>;
  tombstones: Record<string, BoxMinterConfigTombstone>;
  receiptPools: Record<string, ReceiptPoolDeployment>;
  sourceContent: string;
};

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

export function acquireDeploymentRegistryMutationLock(args: {
  root: string;
  operation: string;
}): () => boolean {
  const lockPath = join(
    args.root,
    '.cache',
    'deployment-registry-mutation.lock',
  );
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const payload = `${JSON.stringify(
    {
      operation: args.operation,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      token,
    },
    null,
    2,
  )}\n`;
  mkdirSync(dirname(lockPath), { recursive: true });
  try {
    writeFileSync(lockPath, payload, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
    let owner = 'owner details unavailable';
    try {
      const existing = JSON.parse(readFileSync(lockPath, 'utf8')) as {
        operation?: unknown;
        pid?: unknown;
        startedAt?: unknown;
      };
      owner =
        `operation=${String(existing.operation ?? 'unknown')}, ` +
        `pid=${String(existing.pid ?? 'unknown')}, ` +
        `startedAt=${String(existing.startedAt ?? 'unknown')}`;
    } catch {}
    throw new Error(
      `Another deployment-registry operation may still be running (${owner}).\n` +
        `Lock: ${lockPath}\n` +
        `Concurrent deploy/wipe operations are blocked so proof and registry files cannot race.\n` +
        `If no matching process is running, remove this stale lock file and rerun.`,
    );
  }

  let released = false;
  return () => {
    if (released) return true;
    try {
      if (!existsSync(lockPath)) {
        released = true;
        return true;
      }
      const current = JSON.parse(readFileSync(lockPath, 'utf8')) as {
        token?: unknown;
      };
      if (current.token !== token) {
        released = true;
        try {
          console.warn(
            `⚠️  Preserved deployment-registry lock because its owner changed: ${lockPath}`,
          );
        } catch {}
        return true;
      }
      unlinkSync(lockPath);
      released = true;
      return true;
    } catch (err) {
      try {
        console.warn(
          `⚠️  Failed to remove deployment-registry lock ${lockPath}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      } catch {}
      return false;
    }
  };
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

function defaultSecondaryMarketHref(dropId: string): string | undefined {
  const normalizedDropId = normalizeDropId(dropId);
  return normalizedDropId
    ? `https://www.tensor.trade/trade/${normalizedDropId}`
    : undefined;
}

function defaultFrontendFigureMediaForDropFamily(
  dropFamily: DropFamily,
): FigureMediaConfigSerialized | undefined {
  return defaultFigureMediaConfigForDropFamily(dropFamily);
}

function defaultFrontendBoxMediaForDropFamily(
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
    normalized === 'little_swag_boxes' ||
    normalized === 'little_swag_hoodies' ||
    normalized === 'poncho_drifella' ||
    normalized === 'drifella_binder' ||
    normalized === 'card_nft_binder' ||
    normalized === 'drifella_shirt' ||
    normalized === 'card_nft_2' ||
    normalized === 'clear_cards' ||
    normalized === 'tbd'
  ) {
    return normalized;
  }
  throw new Error(
    `Invalid ${label}: ${value} (expected default, little_swag_boxes, little_swag_hoodies, poncho_drifella, drifella_binder, card_nft_binder, drifella_shirt, card_nft_2, clear_cards, or tbd)`,
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

function normalizeDeploymentDropForRegistry(
  raw: unknown,
  options: DeploymentDropNormalizationOptions = {},
): DeploymentDropConfigSerialized | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const object = raw as Record<string, unknown>;
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

async function importModuleFresh(
  filePath: string,
): Promise<Record<string, unknown>> {
  const href = pathToFileURL(filePath).href;
  const mtimeMs = existsSync(filePath)
    ? statSync(filePath).mtimeMs
    : Date.now();
  return (await import(
    `${href}?t=${mtimeMs}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  )) as Record<string, unknown>;
}

async function readModule(filePath: string, label: string) {
  try {
    return await importModuleFresh(filePath);
  } catch (err) {
    throw new Error(
      `Failed to load existing ${label} at ${filePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

const DEPLOYMENT_REGISTRY_DROP_KEYS = new Set(
  Object.keys(DEPLOYMENT_REGISTRY_DROP_FIELDS),
);
const DEPLOYMENT_REGISTRY_REQUIRED_DROP_KEYS = Object.entries(
  DEPLOYMENT_REGISTRY_DROP_FIELDS,
)
  .filter(([, descriptor]) => descriptor.required)
  .map(([field]) => field);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeReceiptPoolDeployment(
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

function assertValidReceiptPoolDeployment(args: {
  registryKey: string;
  value: unknown;
  filePath: string;
}): asserts args is {
  registryKey: string;
  value: Record<string, unknown>;
  filePath: string;
} {
  const invalid = (reason: string): never => {
    throw new Error(
      `Invalid receipt pool deployment ${args.registryKey}: ${reason}: ${args.filePath}`,
    );
  };
  if (!isPlainRecord(args.value)) invalid('expected an object');
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
      invalid(`${field} must be a non-empty trimmed string`);
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
      invalid(`${field} has an invalid integer value`);
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

function assertValidCanonicalRegistryRow(args: {
  registryKey: string;
  value: unknown;
  filePath: string;
}): asserts args is {
  registryKey: string;
  value: Record<string, unknown>;
  filePath: string;
} {
  const invalid = (reason: string): never => {
    throw new Error(
      `Invalid canonical deployment registry row ${args.registryKey}: ${reason}: ${args.filePath}`,
    );
  };
  if (!isPlainRecord(args.value)) invalid('expected an object');
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
      invalid(`${field} must be a${options.allowEmpty ? '' : ' non-empty'} trimmed string`);
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
      invalid(`${field} has an invalid numeric value`);
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
      invalid('metadataBaseAliases must be a non-empty array');
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

function normalizeBoxMinterConfigTombstone(args: {
  registryKey: string;
  value: unknown;
  filePath: string;
}): BoxMinterConfigTombstone {
  const invalid = (reason: string): never => {
    throw new Error(
      `Invalid BoxMinter config tombstone ${args.registryKey}: ${reason}: ${args.filePath}`,
    );
  };
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

function assertNoBoxMinterConfigRegistryCollisions(args: {
  drops: Record<string, DeploymentDropConfigSerialized>;
  tombstones: Record<string, BoxMinterConfigTombstone>;
  filePath: string;
}): void {
  const configOwners = new Map<string, string>();
  Object.entries(args.drops).forEach(([dropId, drop]) => {
    if (Object.prototype.hasOwnProperty.call(args.tombstones, dropId)) {
      throw new Error(
        `Deployment registry drop ${dropId} cannot also be a BoxMinter config tombstone: ${args.filePath}`,
      );
    }
    if (!drop.boxMinterConfigPda) return;
    const key = `${drop.solanaCluster}:${drop.boxMinterConfigPda}`;
    const duplicate = configOwners.get(key);
    if (duplicate) {
      throw new Error(
        `Deployment registry config PDA collision between ${duplicate} and ${dropId}: ${args.filePath}`,
      );
    }
    configOwners.set(key, `active drop ${dropId}`);
  });
  Object.entries(args.tombstones).forEach(([dropId, tombstone]) => {
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

export async function readDeploymentDropRegistry(
  filePath: string,
): Promise<DeploymentDropRegistry> {
  if (!existsSync(filePath)) {
    throw new Error(`Missing canonical deployment registry: ${filePath}`);
  }
  const sourceBeforeImport = readFileSync(filePath, 'utf8');
  findUniqueDeploymentDropsExport({
    filePath,
    content: sourceBeforeImport,
  });
  findUniqueBoxMinterConfigTombstonesExport({
    filePath,
    content: sourceBeforeImport,
  });
  const drops: Record<string, DeploymentDropConfigSerialized> = {};
  const tombstones: Record<string, BoxMinterConfigTombstone> = {};
  const mod = await readModule(filePath, 'deployment registry');
  const sourceContent = readFileSync(filePath, 'utf8');
  if (sourceContent !== sourceBeforeImport) {
    throw new Error(
      `Canonical deployment registry changed while it was being loaded: ${filePath}`,
    );
  }
  if (
    !Object.prototype.hasOwnProperty.call(mod, 'DEPLOYMENT_DROPS') ||
    !mod.DEPLOYMENT_DROPS ||
    typeof mod.DEPLOYMENT_DROPS !== 'object' ||
    Array.isArray(mod.DEPLOYMENT_DROPS) ||
    !isPlainRecord(mod.DEPLOYMENT_DROPS)
  ) {
    throw new Error(
      `Canonical deployment registry must export DEPLOYMENT_DROPS as an object: ${filePath}`,
    );
  }
  findUniqueDeploymentDropsExport({
    filePath,
    content: sourceContent,
  });
  const candidate = mod.DEPLOYMENT_DROPS;
  for (const [registryKey, value] of Object.entries(
    candidate as Record<string, unknown>,
  )) {
    if (
      isPlainRecord(value) &&
      Object.prototype.hasOwnProperty.call(value, 'dropId') &&
      value.dropId !== registryKey
    ) {
      throw new Error(
        `Canonical deployment registry key ${registryKey} does not match embedded dropId ${String(value.dropId)}: ${filePath}`,
      );
    }
    const rowArgs = { registryKey, value, filePath };
    assertValidCanonicalRegistryRow(rowArgs);
    const normalized = normalizeDeploymentDropForRegistry(rowArgs.value);
    if (!normalized) {
      throw new Error(
        `Invalid canonical deployment registry row ${registryKey}: ${filePath}`,
      );
    }
    const embeddedDropId = rowArgs.value.dropId;
    if (
      embeddedDropId !== registryKey ||
      registryKey !== normalized.dropId
    ) {
      throw new Error(
        `Canonical deployment registry key ${registryKey} does not match embedded dropId ${String(embeddedDropId)}: ${filePath}`,
      );
    }
    Object.defineProperty(drops, registryKey, {
      value: normalized,
      configurable: true,
      enumerable: true,
      writable: true,
    });
  }

  const tombstoneCandidate = mod.BOX_MINTER_CONFIG_TOMBSTONES;
  if (!isPlainRecord(tombstoneCandidate)) {
    throw new Error(
      `Canonical deployment registry must export BOX_MINTER_CONFIG_TOMBSTONES as an object: ${filePath}`,
    );
  }
  findUniqueBoxMinterConfigTombstonesExport({
    filePath,
    content: sourceContent,
  });
  for (const [registryKey, value] of Object.entries(
    tombstoneCandidate,
  )) {
    const tombstone = normalizeBoxMinterConfigTombstone({
      registryKey,
      value,
      filePath,
    });
    Object.defineProperty(tombstones, registryKey, {
      value: tombstone,
      configurable: true,
      enumerable: true,
      writable: true,
    });
  }
  assertNoBoxMinterConfigRegistryCollisions({
    drops,
    tombstones,
    filePath,
  });

  const receiptPools: Record<string, ReceiptPoolDeployment> = {};
  const receiptPoolCandidate = mod.RECEIPT_POOL_DEPLOYMENTS;
  if (
    receiptPoolCandidate !== undefined &&
    !isPlainRecord(receiptPoolCandidate)
  ) {
    throw new Error(
      `Canonical deployment registry RECEIPT_POOL_DEPLOYMENTS must be an object: ${filePath}`,
    );
  }
  for (const [registryKey, value] of Object.entries(
    receiptPoolCandidate ?? {},
  )) {
    const rowArgs = { registryKey, value, filePath };
    assertValidReceiptPoolDeployment(rowArgs);
    Object.defineProperty(receiptPools, registryKey, {
      value: normalizeReceiptPoolDeployment(rowArgs.value),
      configurable: true,
      enumerable: true,
      writable: true,
    });
  }

  // Validate the mutation boundary while the source is still unchanged. This
  // rejects a missing or malformed declaration before deploy or wipe can mutate
  // remote state without requiring rendered formatting to equal hand-written
  // source byte-for-byte.
  renderDeploymentRegistryFileFromSource({
    filePath,
    existingContent: sourceContent,
    drops,
    tombstones,
  });
  if (receiptPoolCandidate !== undefined) {
    renderReceiptPoolDeploymentsFileFromSource({
      filePath,
      existingContent: sourceContent,
      receiptPools,
    });
  }
  assertReceiptPoolDropRelations({ drops, receiptPools });
  return { drops, tombstones, receiptPools, sourceContent };
}

function tsStringLiteral(value: string): string {
  return `'${value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')}'`;
}

function tsPropertyName(value: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)
    ? value
    : tsStringLiteral(value);
}

function mediaMapConfigsEqual(
  left: MediaMapConfigSerialized | undefined,
  right: MediaMapConfigSerialized | undefined,
): boolean {
  return JSON.stringify(normalizeMediaMapConfig(left)) ===
    JSON.stringify(normalizeMediaMapConfig(right));
}

function renderMediaMapConfigLiteral(
  propertyName: 'figureMedia' | 'boxMedia',
  config: MediaMapConfigSerialized,
): string[] {
  const lines = [`    ${propertyName}: {`];
  if (config.strategy) {
    lines.push(`      strategy: ${tsStringLiteral(config.strategy)},`);
  }
  if (config.count) lines.push(`      count: ${Math.floor(config.count)},`);
  const overrides = Object.entries(config.overrides || {})
    .map(
      ([tokenId, mediaId]) =>
        [Math.floor(Number(tokenId)), Math.floor(Number(mediaId))] as const,
    )
    .filter(
      ([tokenId, mediaId]) =>
        Number.isFinite(tokenId) &&
        tokenId > 0 &&
        Number.isFinite(mediaId) &&
        mediaId > 0,
    )
    .sort(([left], [right]) => left - right);
  if (overrides.length) {
    lines.push('      overrides: {');
    overrides.forEach(([tokenId, mediaId]) => {
      lines.push(`        ${tokenId}: ${mediaId},`);
    });
    lines.push('      },');
  }
  lines.push('    },');
  return lines;
}

function renderMintSelectionConfigLiteral(
  config: MintSelectionConfigSerialized,
): string[] {
  const lines = [
    '    mintSelection: {',
    `      kind: ${tsStringLiteral(config.kind)},`,
    '      options: [',
  ];
  config.options.forEach((option) => {
    lines.push(
      `        { key: ${tsStringLiteral(option.key)}, label: ${tsStringLiteral(option.label)}, startId: ${Math.floor(option.startId)}, endId: ${Math.floor(option.endId)} },`,
    );
  });
  lines.push('      ],', '    },');
  return lines;
}

function renderDeploymentDropEntry(
  drop: DeploymentDropConfigSerialized,
): string {
  const lines = [
    `  ${tsPropertyName(drop.dropId)}: {`,
    `    solanaCluster: ${tsStringLiteral(drop.solanaCluster)},`,
    `    dropId: ${tsStringLiteral(drop.dropId)},`,
    `    dropFamily: ${tsStringLiteral(drop.dropFamily)},`,
    `    collectionName: ${tsStringLiteral(drop.collectionName)},`,
  ];
  if (drop.displayName) {
    lines.push(`    displayName: ${tsStringLiteral(drop.displayName)},`);
  }
  if (drop.salesMode) {
    lines.push(`    salesMode: ${tsStringLiteral(drop.salesMode)},`);
  }
  if (drop.receiptPoolId) {
    lines.push(`    receiptPoolId: ${tsStringLiteral(drop.receiptPoolId)},`);
  }
  lines.push(
    `    metadataBase: ${tsStringLiteral(drop.metadataBase)},`,
  );
  if (drop.metadataBaseAliases?.length) {
    lines.push(
      `    metadataBaseAliases: [${drop.metadataBaseAliases.map(tsStringLiteral).join(', ')}],`,
    );
  }
  lines.push(
    `    metadataPathFormat: ${tsStringLiteral(drop.metadataPathFormat)},`,
  );
  const defaultMarket = defaultSecondaryMarketHref(drop.dropId);
  if (
    drop.secondaryMarketHref &&
    drop.secondaryMarketHref !== defaultMarket
  ) {
    lines.push(
      `    secondaryMarketHref: ${tsStringLiteral(drop.secondaryMarketHref)},`,
    );
  }
  const defaultFigureMedia = defaultFrontendFigureMediaForDropFamily(
    drop.dropFamily,
  );
  if (
    drop.figureMedia &&
    !mediaMapConfigsEqual(drop.figureMedia, defaultFigureMedia)
  ) {
    lines.push(...renderMediaMapConfigLiteral('figureMedia', drop.figureMedia));
  }
  const defaultBoxMedia = defaultFrontendBoxMediaForDropFamily(drop.dropFamily);
  if (
    drop.boxMedia &&
    !mediaMapConfigsEqual(drop.boxMedia, defaultBoxMedia)
  ) {
    lines.push(...renderMediaMapConfigLiteral('boxMedia', drop.boxMedia));
  }
  if (drop.forceSoldOut === true) {
    lines.push('    forceSoldOut: true,');
  }
  if (drop.mintSelection) {
    lines.push(...renderMintSelectionConfigLiteral(drop.mintSelection));
  }
  if (drop.paymentRouting) {
    lines.push('    paymentRouting: {', '      mintProceeds: [');
    drop.paymentRouting.mintProceeds.forEach((recipient) => {
      lines.push(
        `        { address: ${tsStringLiteral(recipient.address)}, percentage: ${recipient.percentage} },`,
      );
    });
    lines.push(
      '      ],',
      `      deliveryPaymentReceiver: ${tsStringLiteral(drop.paymentRouting.deliveryPaymentReceiver)},`,
      '    },',
    );
  } else {
    lines.push(
      `    treasury: ${tsStringLiteral(deploymentTreasuryAlias(drop))},`,
    );
  }
  lines.push(
    `    priceSol: ${Number(drop.priceSol)},`,
    `    discountPriceSol: ${Number(drop.discountPriceSol)},`,
  );
  const defaultStripeEnabled =
    defaultStripeCheckoutEnabledForDropFamily(drop.dropFamily);
  if (drop.stripeCheckoutEnabled === true && !defaultStripeEnabled) {
    lines.push('    stripeCheckoutEnabled: true,');
  } else if (
    drop.stripeCheckoutEnabled === false &&
    defaultStripeEnabled
  ) {
    lines.push('    stripeCheckoutEnabled: false,');
  }
  if (drop.stripeLiveUnitAmountCents != null) {
    lines.push(
      `    stripeLiveUnitAmountCents: ${Math.floor(drop.stripeLiveUnitAmountCents)},`,
    );
  }
  const defaultTaxCode = defaultStripeProductTaxCodeForDropFamily(
    drop.dropFamily,
  );
  const stripeCheckoutEnabled = resolveStripeCheckoutEnabledForDropFamily(
    drop.stripeCheckoutEnabled,
    drop.dropFamily,
  ).enabled;
  if (
    drop.stripeProductTaxCode &&
    (drop.stripeProductTaxCode !== defaultTaxCode ||
      !stripeCheckoutEnabled)
  ) {
    lines.push(
      `    stripeProductTaxCode: ${tsStringLiteral(drop.stripeProductTaxCode)},`,
    );
  }
  lines.push(
    `    discountMintsPerWallet: ${Math.floor(drop.discountMintsPerWallet)},`,
    `    discountMerkleRoot: ${tsStringLiteral(drop.discountMerkleRoot)},`,
    `    maxSupply: ${Math.floor(drop.maxSupply)},`,
  );
  if (drop.receiptMaxId != null) {
    lines.push(`    receiptMaxId: ${Math.floor(drop.receiptMaxId)},`);
  }
  lines.push(
    `    itemsPerBox: ${Math.floor(drop.itemsPerBox)},`,
    `    maxPerTx: ${Math.floor(drop.maxPerTx)},`,
    `    namePrefix: ${tsStringLiteral(drop.namePrefix)},`,
    `    figureNamePrefix: ${tsStringLiteral(drop.figureNamePrefix)},`,
    `    symbol: ${tsStringLiteral(drop.symbol)},`,
    `    boxMinterProgramId: ${tsStringLiteral(drop.boxMinterProgramId)},`,
  );
  if (drop.boxMinterConfigPda) {
    lines.push(
      `    boxMinterConfigPda: ${tsStringLiteral(drop.boxMinterConfigPda)},`,
    );
  }
  lines.push(
    `    collectionMint: ${tsStringLiteral(drop.collectionMint)},`,
    `    receiptsMerkleTree: ${tsStringLiteral(drop.receiptsMerkleTree)},`,
  );
  if (drop.receiptsTreeMaxDepth != null) {
    lines.push(
      `    receiptsTreeMaxDepth: ${Math.floor(drop.receiptsTreeMaxDepth)},`,
    );
  }
  if (drop.receiptsTreeCanopyDepth != null) {
    lines.push(
      `    receiptsTreeCanopyDepth: ${Math.floor(drop.receiptsTreeCanopyDepth)},`,
    );
  }
  lines.push(
    `    deliveryLookupTable: ${tsStringLiteral(drop.deliveryLookupTable)},`,
    '  },',
  );
  return lines.join('\n');
}

function renderDeploymentRegistrySection(args: {
  drops: Record<string, DeploymentDropConfigSerialized>;
}): string {
  const entries = Object.keys(args.drops)
    .sort((left, right) => left.localeCompare(right))
    .map((registryKey) => {
      if (!Object.prototype.hasOwnProperty.call(args.drops, registryKey)) {
        throw new Error(
          `Canonical deployment registry row is not an own property: ${registryKey}`,
        );
      }
      const normalizedRegistryKey = normalizeAndValidateDropId(
        registryKey,
        'deployment registry key',
      );
      if (normalizedRegistryKey !== registryKey) {
        throw new Error(
          `Canonical deployment registry key must be normalized: ${registryKey}`,
        );
      }
      const drop = args.drops[registryKey];
      const normalizedDropId = normalizeAndValidateDropId(
        drop?.dropId,
        'deployment registry row dropId',
      );
      if (drop.dropId !== normalizedDropId || normalizedDropId !== registryKey) {
        throw new Error(
          `Canonical deployment registry key ${registryKey} does not match embedded dropId ${String(drop?.dropId)}`,
        );
      }
      return renderDeploymentDropEntry(drop);
    })
    .join('\n');
  return `export const DEPLOYMENT_DROPS: DeploymentDropsMap = {
${entries}
};`;
}

function renderBoxMinterConfigTombstoneEntry(
  tombstone: BoxMinterConfigTombstone,
): string {
  const lines = [
    `  ${tsPropertyName(tombstone.dropId)}: {`,
    `    solanaCluster: ${tsStringLiteral(tombstone.solanaCluster)},`,
    `    dropId: ${tsStringLiteral(tombstone.dropId)},`,
    `    dropSeed: ${tsStringLiteral(tombstone.dropSeed)},`,
    `    boxMinterProgramId: ${tsStringLiteral(tombstone.boxMinterProgramId)},`,
    `    boxMinterConfigPda: ${tsStringLiteral(tombstone.boxMinterConfigPda)},`,
    `    collectionMint: ${tsStringLiteral(tombstone.collectionMint)},`,
    `    accountSize: ${tombstone.accountSize},`,
    `    schema: ${tsStringLiteral(tombstone.schema)},`,
  ];
  if (tombstone.paymentRouting) {
    lines.push('    paymentRouting: {', '      mintProceeds: [');
    tombstone.paymentRouting.mintProceeds.forEach((recipient) => {
      lines.push(
        `        { address: ${tsStringLiteral(recipient.address)}, percentage: ${recipient.percentage} },`,
      );
    });
    lines.push(
      '      ],',
      `      deliveryPaymentReceiver: ${tsStringLiteral(tombstone.paymentRouting.deliveryPaymentReceiver)},`,
      '    },',
    );
  } else {
    lines.push(`    treasury: ${tsStringLiteral(tombstone.treasury)},`);
  }
  lines.push(
    `    reason: ${tsStringLiteral(tombstone.reason)},`,
    '  },',
  );
  return lines.join('\n');
}

function renderBoxMinterConfigTombstonesSection(args: {
  tombstones: Record<string, BoxMinterConfigTombstone>;
}): string {
  const entries = Object.keys(args.tombstones)
    .sort((left, right) => left.localeCompare(right))
    .map((registryKey) => {
      if (!Object.prototype.hasOwnProperty.call(args.tombstones, registryKey)) {
        throw new Error(
          `BoxMinter config tombstone is not an own property: ${registryKey}`,
        );
      }
      const tombstone = normalizeBoxMinterConfigTombstone({
        registryKey,
        value: args.tombstones[registryKey],
        filePath: 'rendered deployment registry',
      });
      if (!isDeepStrictEqual(tombstone, args.tombstones[registryKey])) {
        throw new Error(
          `BoxMinter config tombstone ${registryKey} must be canonical`,
        );
      }
      return renderBoxMinterConfigTombstoneEntry(tombstone);
    })
    .join('\n');
  return `export const BOX_MINTER_CONFIG_TOMBSTONES: BoxMinterConfigTombstonesMap = {
${entries}
};`;
}

function renderReceiptPoolDeploymentEntry(
  registryKey: string,
  pool: ReceiptPoolDeployment,
): string {
  return [
    `  ${tsPropertyName(registryKey)}: {`,
    `    solanaCluster: ${tsStringLiteral(pool.solanaCluster)},`,
    `    receiptPoolId: ${tsStringLiteral(pool.receiptPoolId)},`,
    `    collectionMint: ${tsStringLiteral(pool.collectionMint)},`,
    `    receiptsMerkleTree: ${tsStringLiteral(pool.receiptsMerkleTree)},`,
    `    authority: ${tsStringLiteral(pool.authority)},`,
    `    collectionMetadataUri: ${tsStringLiteral(pool.collectionMetadataUri)},`,
    `    collectionName: ${tsStringLiteral(pool.collectionName)},`,
    `    collectionSymbol: ${tsStringLiteral(pool.collectionSymbol)},`,
    `    royaltiesBasisPoints: ${Math.floor(pool.royaltiesBasisPoints)},`,
    `    royaltiesRecipient: ${tsStringLiteral(pool.royaltiesRecipient)},`,
    `    receiptsTreeMaxDepth: ${Math.floor(pool.receiptsTreeMaxDepth)},`,
    `    receiptsTreeMaxBufferSize: ${Math.floor(pool.receiptsTreeMaxBufferSize)},`,
    `    receiptsTreeCanopyDepth: ${Math.floor(pool.receiptsTreeCanopyDepth)},`,
    '  },',
  ].join('\n');
}

function renderReceiptPoolDeploymentsSection(args: {
  receiptPools: Record<string, ReceiptPoolDeployment>;
}): string {
  const entries = Object.keys(args.receiptPools)
    .sort((left, right) => left.localeCompare(right))
    .map((registryKey) => {
      const pool = args.receiptPools[registryKey];
      const rowArgs = {
        registryKey,
        value: pool,
        filePath: 'rendered deployment registry',
      };
      assertValidReceiptPoolDeployment(rowArgs);
      return renderReceiptPoolDeploymentEntry(registryKey, pool);
    })
    .join('\n');
  return `export const RECEIPT_POOL_DEPLOYMENTS: ReceiptPoolDeploymentsMap = {
${entries}
};`;
}

type DeploymentDropsExportBounds = {
  start: number;
  end: number;
};

function findUniqueDeploymentDropsExport(args: {
  filePath: string;
  content: string;
}): DeploymentDropsExportBounds {
  const sourceFile = ts.createSourceFile(
    args.filePath,
    args.content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declarations = sourceFile.statements.flatMap((statement) => {
    if (
      !ts.isVariableStatement(statement) ||
      !(statement.declarationList.flags & ts.NodeFlags.Const) ||
      statement.declarationList.declarations.length !== 1 ||
      !statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      )
    ) {
      return [];
    }
    return statement.declarationList.declarations
      .filter(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === 'DEPLOYMENT_DROPS',
      )
      .map(() => statement);
  });
  const declaration = declarations[0];
  if (declarations.length !== 1) {
    throw new Error(
      `Canonical deployment registry must contain exactly one top-level exported const DEPLOYMENT_DROPS declaration: ${args.filePath}`,
    );
  }
  return {
    start: declaration.getStart(sourceFile),
    end: declaration.end,
  };
}

function replaceDeploymentDropsExport(args: {
  filePath: string;
  existingContent: string;
  nextDeclaration: string;
}): string {
  const bounds = findUniqueDeploymentDropsExport({
    filePath: args.filePath,
    content: args.existingContent,
  });
  return `${
    args.existingContent.slice(0, bounds.start)
  }${args.nextDeclaration}${
    args.existingContent.slice(bounds.end)
  }`;
}

function findUniqueBoxMinterConfigTombstonesExport(args: {
  filePath: string;
  content: string;
}): DeploymentDropsExportBounds {
  const sourceFile = ts.createSourceFile(
    args.filePath,
    args.content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declarations = sourceFile.statements.flatMap((statement) => {
    if (
      !ts.isVariableStatement(statement) ||
      !(statement.declarationList.flags & ts.NodeFlags.Const) ||
      statement.declarationList.declarations.length !== 1 ||
      !statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      )
    ) {
      return [];
    }
    return statement.declarationList.declarations
      .filter(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === 'BOX_MINTER_CONFIG_TOMBSTONES',
      )
      .map(() => statement);
  });
  const declaration = declarations[0];
  if (declarations.length !== 1) {
    throw new Error(
      `Canonical deployment registry must contain exactly one top-level exported const BOX_MINTER_CONFIG_TOMBSTONES declaration: ${args.filePath}`,
    );
  }
  return {
    start: declaration.getStart(sourceFile),
    end: declaration.end,
  };
}

function replaceBoxMinterConfigTombstonesExport(args: {
  filePath: string;
  existingContent: string;
  nextDeclaration: string;
}): string {
  const bounds = findUniqueBoxMinterConfigTombstonesExport({
    filePath: args.filePath,
    content: args.existingContent,
  });
  return `${args.existingContent.slice(0, bounds.start)}${args.nextDeclaration}${args.existingContent.slice(bounds.end)}`;
}

function findUniqueReceiptPoolDeploymentsExport(args: {
  filePath: string;
  content: string;
}): DeploymentDropsExportBounds {
  const sourceFile = ts.createSourceFile(
    args.filePath,
    args.content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declarations = sourceFile.statements.flatMap((statement) => {
    if (
      !ts.isVariableStatement(statement) ||
      !(statement.declarationList.flags & ts.NodeFlags.Const) ||
      statement.declarationList.declarations.length !== 1 ||
      !statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      )
    ) {
      return [];
    }
    return statement.declarationList.declarations
      .filter(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === 'RECEIPT_POOL_DEPLOYMENTS',
      )
      .map(() => statement);
  });
  const declaration = declarations[0];
  if (declarations.length !== 1) {
    throw new Error(
      `Canonical deployment registry must contain exactly one top-level exported const RECEIPT_POOL_DEPLOYMENTS declaration: ${args.filePath}`,
    );
  }
  return {
    start: declaration.getStart(sourceFile),
    end: declaration.end,
  };
}

export function renderReceiptPoolDeploymentsFileFromSource(args: {
  filePath: string;
  existingContent: string;
  receiptPools: Record<string, ReceiptPoolDeployment>;
}): string {
  const bounds = findUniqueReceiptPoolDeploymentsExport({
    filePath: args.filePath,
    content: args.existingContent,
  });
  const nextDeclaration = renderReceiptPoolDeploymentsSection({
    receiptPools: args.receiptPools,
  });
  const next = `${args.existingContent.slice(0, bounds.start)}${nextDeclaration}${args.existingContent.slice(bounds.end)}`;
  return next.endsWith('\n') ? next : `${next}\n`;
}

function canonicalRegistryTemplatePath(): string {
  return fileURLToPath(
    new URL(
      '../../shared/deploymentRegistry.ts',
      import.meta.url,
    ),
  );
}

export function renderDeploymentRegistryFile(args: {
  drops: Record<string, DeploymentDropConfigSerialized>;
  tombstones?: Record<string, BoxMinterConfigTombstone>;
}): string {
  const templatePath = canonicalRegistryTemplatePath();
  return renderDeploymentRegistryFileFromSource({
    filePath: templatePath,
    existingContent: readFileSync(templatePath, 'utf8'),
    drops: args.drops,
    tombstones: args.tombstones ?? BOX_MINTER_CONFIG_TOMBSTONES,
  });
}

export function renderDeploymentRegistryFileFromSource(args: {
  filePath: string;
  existingContent: string;
  drops: Record<string, DeploymentDropConfigSerialized>;
  tombstones?: Record<string, BoxMinterConfigTombstone>;
}): string {
  if (args.tombstones) {
    assertNoBoxMinterConfigRegistryCollisions({
      drops: args.drops,
      tombstones: args.tombstones,
      filePath: args.filePath,
    });
  }
  const dropsNext = replaceDeploymentDropsExport({
    filePath: args.filePath,
    existingContent: args.existingContent,
    nextDeclaration: renderDeploymentRegistrySection({ drops: args.drops }),
  });
  const next = args.tombstones
    ? replaceBoxMinterConfigTombstonesExport({
        filePath: args.filePath,
        existingContent: dropsNext,
        nextDeclaration: renderBoxMinterConfigTombstonesSection({
          tombstones: args.tombstones,
        }),
      })
    : dropsNext;
  return next.endsWith('\n') ? next : `${next}\n`;
}

export class DeploymentRegistryPostCommitVerificationError extends Error {
  constructor(filePath: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `Canonical deployment registry was durably committed, but post-commit verification failed for ${filePath}: ${detail}`,
      { cause },
    );
    this.name = 'DeploymentRegistryPostCommitVerificationError';
  }
}

export function isDeploymentRegistryPostCommitVerificationError(
  error: unknown,
): error is DeploymentRegistryPostCommitVerificationError {
  return error instanceof DeploymentRegistryPostCommitVerificationError;
}

export function writeDeploymentRegistryFile(args: {
  filePath: string;
  expectedContent: string;
  nextContent: string;
}, ioOverrides: Partial<OptimisticTextFileWriteIo> = {}): void {
  try {
    writeOptimisticTextFile(
      {
        ...args,
        targetLabel: 'canonical deployment registry',
      },
      ioOverrides,
    );
  } catch (error) {
    if (isOptimisticTextFilePostCommitVerificationError(error)) {
      throw new DeploymentRegistryPostCommitVerificationError(
        args.filePath,
        error.cause,
      );
    }
    throw error;
  }
}
