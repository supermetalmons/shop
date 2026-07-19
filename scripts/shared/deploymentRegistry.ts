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
import ts from 'typescript';
import {
  defaultBoxMediaConfigForDropFamily,
  defaultFigureMediaConfigForDropFamily,
} from '../../functions/src/shared/dropMediaDefaults.ts';
import {
  DEPLOYMENT_REGISTRY_DROP_FIELDS,
  getDeploymentDrop,
  type DeploymentMediaMapConfig,
  type DeploymentRegistryDrop,
} from '../../functions/src/shared/deploymentRegistry.ts';
import {
  normalizeMediaMapConfig,
} from '../../functions/src/shared/mediaMap.ts';
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
  type StripeCheckoutEnabledResolution,
} from '../../functions/src/shared/stripeCheckoutCore.ts';
import {
  BOX_MINTER_MAX_DISCOUNT_MINTS_PER_WALLET,
  BOX_MINTER_MAX_ITEMS_PER_BOX,
  BOX_MINTER_MIN_CONFIGURED_ITEMS_PER_BOX,
  BOX_MINTER_MIN_DISCOUNT_MINTS_PER_WALLET,
} from '../../functions/src/shared/boxMinterProtocol.ts';
import {
  canonicalizeDropAssetUrl,
  defaultDropFamilyForDropId,
  dropPathsFromBase,
  normalizeDiscountMintsPerWallet,
  normalizeDropBase,
  normalizeDropFamily,
  normalizeDropId,
  normalizeMetadataPathFormat,
  normalizeMintSelectionConfig,
  type DropFamily,
  type DropPaths,
  type MetadataPathFormat,
  type MintSelectionConfig,
  type SolanaCluster,
} from '../../functions/src/shared/deploymentCore.ts';
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
  normalizeDropFamily,
  normalizeDropId,
  resolveStripeCheckoutEnabledForDropFamily,
  resolveStripeProductTaxCodeForDropFamily,
};
export type {
  DropFamily,
  DropPaths,
  MetadataPathFormat,
  MintSelectionConfig,
  SolanaCluster,
  StripeCheckoutEnabledResolution,
};

export type MediaMapConfigSerialized = DeploymentMediaMapConfig;

export type FigureMediaConfigSerialized = MediaMapConfigSerialized;
export type BoxMediaConfigSerialized = MediaMapConfigSerialized;
export type MintSelectionConfigSerialized = MintSelectionConfig;

export type FrontendDropConfigSerialized = Omit<
  DeploymentRegistryDrop,
  'stripeProductTaxCode' | 'receiptsMerkleTree' | 'deliveryLookupTable'
>;

export type FunctionsDropConfigSerialized = DeploymentRegistryDrop;

export type DeploymentDropConfigSerialized = DeploymentRegistryDrop;

export type FrontendDropRegistry = {
  drops: Record<string, FrontendDropConfigSerialized>;
};

export type FunctionsDropRegistry = {
  drops: Record<string, FunctionsDropConfigSerialized>;
};

export type DeploymentDropRegistry = {
  drops: Record<string, DeploymentDropConfigSerialized>;
  sourceContent: string;
};

const DEPLOYMENT_REGISTRY_START =
  '// BEGIN AUTO-GENERATED DEPLOYMENT DROP REGISTRY';
const DEPLOYMENT_REGISTRY_END =
  '// END AUTO-GENERATED DEPLOYMENT DROP REGISTRY';
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
    } catch {
      // Keep the conservative owner description above.
    }
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
        } catch {
          // Cleanup warnings must not disrupt the caller.
        }
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
      } catch {
        // Cleanup warnings must not disrupt the caller.
      }
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
    normalized === 'little_swag_boxes' ||
    normalized === 'little_swag_hoodies' ||
    normalized === 'poncho_drifella' ||
    normalized === 'drifella_binder' ||
    normalized === 'drifella_shirt' ||
    normalized === 'card_nft_2'
  ) {
    return normalized;
  }
  throw new Error(
    `Invalid ${label}: ${value} (expected default, little_swag_boxes, little_swag_hoodies, poncho_drifella, drifella_binder, drifella_shirt, or card_nft_2)`,
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

  return {
    solanaCluster,
    dropId,
    dropFamily,
    collectionName: asTrimmedString(object.collectionName) || dropId,
    metadataBase: normalizeDropBase(
      asTrimmedString(object.metadataBase) ||
        asTrimmedString(
          (object.paths as Record<string, unknown> | undefined)?.base,
        ),
    ),
    metadataPathFormat: normalizeMetadataPathFormat(
      object.metadataPathFormat,
    ),
    ...(secondaryMarketHref ? { secondaryMarketHref } : {}),
    ...(figureMedia ? { figureMedia } : {}),
    ...(boxMedia ? { boxMedia } : {}),
    ...(forceSoldOut ? { forceSoldOut: true } : {}),
    ...(mintSelection ? { mintSelection } : {}),
    treasury: asTrimmedString(object.treasury),
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
    deliveryLookupTable: asTrimmedString(object.deliveryLookupTable),
  };
}

function projectFrontendSerialized(
  drop: DeploymentDropConfigSerialized,
): FrontendDropConfigSerialized {
  const {
    secondaryMarketHref,
    stripeProductTaxCode: _stripeProductTaxCode,
    receiptsMerkleTree: _receiptsMerkleTree,
    deliveryLookupTable: _deliveryLookupTable,
    ...frontend
  } = drop;
  const defaultMarket = defaultSecondaryMarketHref(drop.dropId);
  return {
    ...frontend,
    ...(secondaryMarketHref && secondaryMarketHref !== defaultMarket
      ? { secondaryMarketHref }
      : {}),
  };
}

function projectFunctionsSerialized(
  drop: DeploymentDropConfigSerialized,
): FunctionsDropConfigSerialized {
  return {
    ...projectFrontendSerialized(drop),
    ...(drop.stripeProductTaxCode
      ? { stripeProductTaxCode: drop.stripeProductTaxCode }
      : {}),
    receiptsMerkleTree: drop.receiptsMerkleTree,
    deliveryLookupTable: drop.deliveryLookupTable,
  };
}

function setOwnDrop<T>(
  drops: Record<string, T>,
  dropId: string,
  drop: T,
): void {
  Object.defineProperty(drops, dropId, {
    value: drop,
    configurable: true,
    enumerable: true,
    writable: true,
  });
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
  const metadataBase = requireString('metadataBase');
  if (normalizeAndValidateMetadataBaseInput(metadataBase) !== metadataBase) {
    invalid('metadataBase must be canonical');
  }
  const metadataPathFormat = requireString('metadataPathFormat');
  if (
    metadataPathFormat !== 'legacy' &&
    metadataPathFormat !== 'compact'
  ) {
    invalid('metadataPathFormat is unsupported');
  }

  requireString('treasury');
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
  const itemsPerBox = requireNumber('itemsPerBox', {
    integer: true,
    min: BOX_MINTER_MIN_CONFIGURED_ITEMS_PER_BOX,
    max: BOX_MINTER_MAX_ITEMS_PER_BOX,
  });
  if (maxSupply * itemsPerBox > 0xffff) {
    invalid('maxSupply and itemsPerBox exceed the supported figure ID range');
  }
  requireNumber('maxPerTx', { integer: true, min: 1, max: 0xff });
  requireString('namePrefix');
  requireString('figureNamePrefix');
  requireString('symbol');
  requireString('boxMinterProgramId');
  requireString('collectionMint');
  requireString('receiptsMerkleTree');
  requireString('deliveryLookupTable', { allowEmpty: true });

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
}

export async function readDeploymentDropRegistry(
  filePath: string,
): Promise<DeploymentDropRegistry> {
  if (!existsSync(filePath)) {
    throw new Error(`Missing canonical deployment registry: ${filePath}`);
  }
  const sourceBeforeImport = readFileSync(filePath, 'utf8');
  const markerBounds = validateDeploymentRegistryMarkerLines({
    filePath,
    content: sourceBeforeImport,
  });
  const drops: Record<string, DeploymentDropConfigSerialized> = {};
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
  assertDeploymentDropsExportInsideMarkers({
    filePath,
    content: sourceContent,
    markerBounds,
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
  // Validate the mutation boundary while the source is still unchanged. This
  // rejects missing/malformed markers before deploy or wipe can mutate remote
  // state, without requiring the rendered formatting to equal hand-written
  // source byte-for-byte.
  renderDeploymentRegistryFileFromSource({
    filePath,
    existingContent: sourceContent,
    drops,
  });
  return { drops, sourceContent };
}

function canonicalForceSoldOutForLegacyDropId(dropId: string): boolean {
  return getDeploymentDrop(dropId)?.forceSoldOut === true;
}

export async function readFrontendDropRegistry(
  filePath: string,
): Promise<FrontendDropRegistry> {
  const drops: Record<string, FrontendDropConfigSerialized> = {};
  if (!existsSync(filePath)) return { drops };
  const mod = await readModule(filePath, 'frontend deployment config');
  const candidate = mod.FRONTEND_DROPS;
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    Object.values(candidate as Record<string, unknown>).forEach((value) => {
      const normalized = normalizeDeploymentDropForRegistry({
        ...(value as Record<string, unknown>),
        receiptsMerkleTree: '',
        deliveryLookupTable: '',
      }, {
        forceSoldOutFallback: canonicalForceSoldOutForLegacyDropId,
      });
      if (normalized) {
        setOwnDrop(
          drops,
          normalized.dropId,
          projectFrontendSerialized(normalized),
        );
      }
    });
  }
  if (!Object.keys(drops).length) {
    const legacy = mod.FRONTEND_DEPLOYMENT || mod.DEPLOYMENT || mod.default;
    const normalized = normalizeDeploymentDropForRegistry({
      ...(legacy && typeof legacy === 'object'
        ? (legacy as Record<string, unknown>)
        : {}),
      receiptsMerkleTree: '',
      deliveryLookupTable: '',
    }, {
      forceSoldOutFallback: canonicalForceSoldOutForLegacyDropId,
    });
    if (normalized) {
      setOwnDrop(
        drops,
        normalized.dropId,
        projectFrontendSerialized(normalized),
      );
    }
  }
  return { drops };
}

export async function readFunctionsDropRegistry(
  filePath: string,
): Promise<FunctionsDropRegistry> {
  const drops: Record<string, FunctionsDropConfigSerialized> = {};
  if (!existsSync(filePath)) return { drops };
  const mod = await readModule(filePath, 'Functions deployment config');
  const candidate = mod.FUNCTIONS_DROPS;
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    Object.values(candidate as Record<string, unknown>).forEach((value) => {
      const normalized = normalizeDeploymentDropForRegistry(value, {
        forceSoldOutFallback: canonicalForceSoldOutForLegacyDropId,
      });
      if (normalized) {
        setOwnDrop(
          drops,
          normalized.dropId,
          projectFunctionsSerialized(normalized),
        );
      }
    });
  }
  if (!Object.keys(drops).length) {
    const legacy = mod.FUNCTIONS_DEPLOYMENT || mod.DEPLOYMENT || mod.default;
    const normalized = normalizeDeploymentDropForRegistry(legacy, {
      forceSoldOutFallback: canonicalForceSoldOutForLegacyDropId,
    });
    if (normalized) {
      setOwnDrop(
        drops,
        normalized.dropId,
        projectFunctionsSerialized(normalized),
      );
    }
  }
  return { drops };
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
    `    metadataBase: ${tsStringLiteral(drop.metadataBase)},`,
    `    metadataPathFormat: ${tsStringLiteral(drop.metadataPathFormat)},`,
  ];
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
  lines.push(
    `    treasury: ${tsStringLiteral(drop.treasury)},`,
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
  return `${DEPLOYMENT_REGISTRY_START}
export const DEPLOYMENT_DROPS: DeploymentDropsMap = {
${entries}
};
${DEPLOYMENT_REGISTRY_END}`;
}

type DeploymentRegistryMarkerBounds = {
  startLineStart: number;
  startLineEnd: number;
  endLineStart: number;
  endLineEnd: number;
};

function malformedDeploymentRegistryMarkers(filePath: string): never {
  throw new Error(
    `Malformed or missing canonical deployment registry markers in ${filePath}`,
  );
}

function findUniqueDeploymentRegistryMarkerLine(args: {
  filePath: string;
  content: string;
  marker: string;
}): { lineStart: number; lineEnd: number } {
  const markerStart = args.content.indexOf(args.marker);
  if (
    markerStart === -1 ||
    markerStart !== args.content.lastIndexOf(args.marker) ||
    (markerStart !== 0 && args.content[markerStart - 1] !== '\n')
  ) {
    return malformedDeploymentRegistryMarkers(args.filePath);
  }

  const afterMarker = markerStart + args.marker.length;
  if (afterMarker === args.content.length) {
    return { lineStart: markerStart, lineEnd: afterMarker };
  }
  if (args.content[afterMarker] === '\n') {
    return { lineStart: markerStart, lineEnd: afterMarker + 1 };
  }
  if (
    args.content[afterMarker] === '\r' &&
    args.content[afterMarker + 1] === '\n'
  ) {
    return { lineStart: markerStart, lineEnd: afterMarker + 2 };
  }
  return malformedDeploymentRegistryMarkers(args.filePath);
}

function validateDeploymentRegistryMarkerLines(args: {
  filePath: string;
  content: string;
}): DeploymentRegistryMarkerBounds {
  const start = findUniqueDeploymentRegistryMarkerLine({
    ...args,
    marker: DEPLOYMENT_REGISTRY_START,
  });
  const end = findUniqueDeploymentRegistryMarkerLine({
    ...args,
    marker: DEPLOYMENT_REGISTRY_END,
  });
  if (end.lineStart < start.lineEnd) {
    return malformedDeploymentRegistryMarkers(args.filePath);
  }
  return {
    startLineStart: start.lineStart,
    startLineEnd: start.lineEnd,
    endLineStart: end.lineStart,
    endLineEnd: end.lineEnd,
  };
}

function assertDeploymentDropsExportInsideMarkers(args: {
  filePath: string;
  content: string;
  markerBounds: DeploymentRegistryMarkerBounds;
}): void {
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
  if (
    declarations.length !== 1 ||
    declaration.getStart(sourceFile) < args.markerBounds.startLineEnd ||
    declaration.end > args.markerBounds.endLineStart
  ) {
    throw new Error(
      `Canonical deployment registry must contain exactly one DEPLOYMENT_DROPS export inside its generated markers: ${args.filePath}`,
    );
  }
}

function replaceMarkedSection(args: {
  filePath: string;
  existingContent: string;
  nextSection: string;
}): string {
  const markerBounds = validateDeploymentRegistryMarkerLines({
    filePath: args.filePath,
    content: args.existingContent,
  });
  assertDeploymentDropsExportInsideMarkers({
    filePath: args.filePath,
    content: args.existingContent,
    markerBounds,
  });
  const nextSection = args.nextSection.endsWith('\n')
    ? args.nextSection
    : `${args.nextSection}\n`;
  return `${
    args.existingContent.slice(0, markerBounds.startLineStart)
  }${nextSection}${
    args.existingContent.slice(markerBounds.endLineEnd)
  }`;
}

function canonicalRegistryTemplatePath(): string {
  return fileURLToPath(
    new URL(
      '../../functions/src/shared/deploymentRegistry.ts',
      import.meta.url,
    ),
  );
}

export function renderDeploymentRegistryFile(args: {
  drops: Record<string, DeploymentDropConfigSerialized>;
}): string {
  const templatePath = canonicalRegistryTemplatePath();
  return renderDeploymentRegistryFileFromSource({
    filePath: templatePath,
    existingContent: readFileSync(templatePath, 'utf8'),
    drops: args.drops,
  });
}

export function renderDeploymentRegistryFileFromSource(args: {
  filePath: string;
  existingContent: string;
  drops: Record<string, DeploymentDropConfigSerialized>;
}): string {
  const next = replaceMarkedSection({
    filePath: args.filePath,
    existingContent: args.existingContent,
    nextSection: renderDeploymentRegistrySection({ drops: args.drops }),
  });
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

export function asDeploymentDropConfigSerialized(
  drop: DeploymentRegistryDrop,
): DeploymentDropConfigSerialized {
  const normalized = normalizeDeploymentDropForRegistry(drop);
  if (!normalized) throw new Error('Invalid deployment registry drop');
  return normalized;
}
