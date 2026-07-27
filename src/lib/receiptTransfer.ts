import { PublicKey } from '@solana/web3.js';
import type { InventoryItem } from '../types';
import type { SubmittedTransactionReconciliationResult } from './solana';

type ReceiptTransferTargetItem = Pick<InventoryItem, 'id' | 'dropId' | 'kind'>;

type ReceiptTransferViewerImage = {
  key: string;
};

export type ResolveReceiptTransferTargetArgs<T extends ReceiptTransferTargetItem> = {
  wallet?: string | null;
  inventoryOwner?: string | null;
  inventoryItems: readonly T[];
  viewerMode?: string | null;
  viewerSize?: string | null;
  dropId?: string | null;
  receiptImages?: readonly ReceiptTransferViewerImage[] | null;
  isAdminReadOnly?: boolean;
};

export type ReceiptOperationPhase = 'in-flight' | 'hidden' | 'checking' | 'unverified';

export type ReceiptOperation = {
  key: string;
  wallet: string;
  assetId: string;
  dropId: string;
  createdGeneration: number;
  generation: number;
  phase: ReceiptOperationPhase;
  signature?: string;
  recentBlockhash?: string;
  adminFinalizeRequestId?: string;
};

export type ReceiptOperationRegistry = ReadonlyMap<string, ReceiptOperation>;

export type ReceiptReconciliationDisposition = 'hidden' | 'available' | 'unverified';

const SYSTEM_PROGRAM_ADDRESS = PublicKey.default.toBase58();

export function canSignReceiptTransferTransaction(
  signTransaction: unknown,
  supportedTransactionVersions?: ReadonlySet<'legacy' | 0> | null,
): boolean {
  return typeof signTransaction === 'function' && supportedTransactionVersions?.has(0) === true;
}

export function receiptReconciliationDisposition(
  resolution: SubmittedTransactionReconciliationResult,
): ReceiptReconciliationDisposition {
  if (resolution === 'confirmed') return 'hidden';
  if (resolution === 'failed' || resolution === 'expired') return 'available';
  return 'unverified';
}

export function canonicalReceiptPublicKey(value: string | null | undefined): string | null {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  try {
    return new PublicKey(trimmed).toBase58();
  } catch {
    return null;
  }
}

export function receiptOperationKey(wallet: string, assetId: string): string {
  const canonicalWallet = canonicalReceiptPublicKey(wallet);
  const canonicalAssetId = canonicalReceiptPublicKey(assetId);
  if (!canonicalWallet || !canonicalAssetId) {
    throw new Error('Invalid receipt operation identity');
  }
  return `${canonicalWallet}:${canonicalAssetId}`;
}

export function setReceiptOperation(
  registry: ReceiptOperationRegistry,
  operation: ReceiptOperation,
): ReceiptOperationRegistry {
  const next = new Map(registry);
  next.set(operation.key, operation);
  return next;
}

export function transitionReceiptOperation(
  registry: ReceiptOperationRegistry,
  key: string,
  generation: number,
  update: (current: ReceiptOperation) => ReceiptOperation | null,
): ReceiptOperationRegistry {
  const current = registry.get(key);
  if (!current || current.generation !== generation) return registry;
  const replacement = update(current);
  if (replacement === current) return registry;
  const next = new Map(registry);
  if (replacement) next.set(key, replacement);
  else next.delete(key);
  return next;
}

export function rebaseReceiptOperationsAfterWalletChange(
  registry: ReceiptOperationRegistry,
  wallet: string | null | undefined,
  lastGeneration: number,
): { registry: ReceiptOperationRegistry; lastGeneration: number } {
  const canonicalWallet = canonicalReceiptPublicKey(wallet);
  let nextGeneration = Number.isSafeInteger(lastGeneration) && lastGeneration >= 0
    ? lastGeneration
    : 0;
  registry.forEach((operation) => {
    nextGeneration = Math.max(nextGeneration, operation.generation);
  });
  if (!canonicalWallet) return { registry, lastGeneration: nextGeneration };

  let next: Map<string, ReceiptOperation> | null = null;
  registry.forEach((operation, key) => {
    if (operation.wallet !== canonicalWallet) return;
    next ??= new Map(registry);
    if (!operation.signature || !operation.recentBlockhash) {
      next.delete(key);
      return;
    }
    nextGeneration += 1;
    next.set(key, {
      ...operation,
      generation: nextGeneration,
      phase: 'unverified',
    });
  });

  return {
    registry: next ?? registry,
    lastGeneration: nextGeneration,
  };
}

export function receiptOperationAssetIds(
  registry: ReceiptOperationRegistry,
  wallet: string | null | undefined,
  phases: ReadonlySet<ReceiptOperationPhase>,
): Set<string> {
  const canonicalWallet = canonicalReceiptPublicKey(wallet);
  const ids = new Set<string>();
  if (!canonicalWallet || !phases.size) return ids;
  registry.forEach((operation) => {
    if (operation.wallet === canonicalWallet && phases.has(operation.phase)) {
      ids.add(operation.assetId);
    }
  });
  return ids;
}

export function removeReceiptOperationsForAssets(
  registry: ReceiptOperationRegistry,
  wallet: string | null | undefined,
  assetIds: Iterable<string>,
  maximumCreatedGeneration = Number.POSITIVE_INFINITY,
): ReceiptOperationRegistry {
  const canonicalWallet = canonicalReceiptPublicKey(wallet);
  if (!canonicalWallet) return registry;

  const keys = new Set<string>();
  for (const assetId of assetIds) {
    const canonicalAssetId = canonicalReceiptPublicKey(assetId);
    if (canonicalAssetId) keys.add(receiptOperationKey(canonicalWallet, canonicalAssetId));
  }
  if (!keys.size) return registry;

  let next: Map<string, ReceiptOperation> | null = null;
  keys.forEach((key) => {
    const operation = registry.get(key);
    if (
      !operation ||
      operation.phase === 'in-flight' ||
      operation.createdGeneration > maximumCreatedGeneration
    ) {
      return;
    }
    next ??= new Map(registry);
    next.delete(key);
  });
  return next ?? registry;
}

export function normalizeReceiptTransferDestination(
  value: string,
  currentOwner?: string | null,
): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    throw new Error('Enter a destination address.');
  }

  const destination = canonicalReceiptPublicKey(trimmed);
  if (!destination) {
    throw new Error('Enter a valid Solana address.');
  }
  if (destination === SYSTEM_PROGRAM_ADDRESS) {
    throw new Error('Enter a destination other than the system address.');
  }

  const owner = canonicalReceiptPublicKey(currentOwner);
  if (owner && destination === owner) {
    throw new Error('Enter a destination different from the current wallet.');
  }

  return destination;
}

export function resolveReceiptTransferTarget<T extends ReceiptTransferTargetItem>(
  args: ResolveReceiptTransferTargetArgs<T>,
): T | null {
  if (args.isAdminReadOnly) return null;
  if (args.viewerMode !== 'receipt-image' || args.viewerSize !== 'receipt') return null;

  const wallet = canonicalReceiptPublicKey(args.wallet);
  const inventoryOwner = canonicalReceiptPublicKey(args.inventoryOwner);
  if (!wallet || !inventoryOwner || wallet !== inventoryOwner) return null;

  const dropId = String(args.dropId || '').trim();
  const receiptImages = args.receiptImages || [];
  if (!dropId || receiptImages.length !== 1) return null;

  const receiptAssetId = canonicalReceiptPublicKey(receiptImages[0]?.key);
  if (!receiptAssetId) return null;

  const matches = args.inventoryItems.filter((item) => {
    if (item.kind !== 'certificate') return false;
    if (String(item.dropId || '').trim() !== dropId) return false;
    return canonicalReceiptPublicKey(item.id) === receiptAssetId;
  });

  return matches.length === 1 ? matches[0] : null;
}
