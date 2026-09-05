import type { FrontendDeploymentConfig } from '../config/deployment';
import type { BoxMinterConfigAccount, buildMintBoxesTxWithAccounts } from '../lib/boxMinter';
import { dropAssetCount, dropAssetLabel } from '../lib/dropLabels';
import { isBlockhashExpiredError } from '../lib/solana';

export type MintMode = 'mint' | 'discount';

type BuiltMintTransaction = Awaited<ReturnType<typeof buildMintBoxesTxWithAccounts>>;

type MintWorkflowOptions = {
  mode: MintMode;
  quantity: number;
  drop: Pick<FrontendDeploymentConfig, 'namePrefix' | 'mintSelection'>;
  discountRemainingCount: number;
  lock: { current: MintMode | null };
};

type MintWorkflowOperations = {
  setBusy: (busy: boolean) => void;
  getDiscountProof: () => Promise<Uint8Array[] | null>;
  fetchConfig: () => Promise<BoxMinterConfigAccount>;
  fetchDiscountUsedCount: () => Promise<number>;
  buildTransaction: (config: BoxMinterConfigAccount, proof: Uint8Array[] | null) => Promise<BuiltMintTransaction>;
  sendAndConfirm: (mint: BuiltMintTransaction) => Promise<boolean>;
  onConfirmed: (quantity: number, assetIds: string[]) => void;
  updateDiscount: (remainingCount: number, usedCount?: number) => void;
  refresh: (confirmed: boolean) => Promise<unknown>;
  isUserRejectedError: (error: unknown) => boolean;
  showToast: (message: string) => void;
  warn: (message: string, error: unknown) => void;
};

export async function runMintWorkflow(
  { mode, quantity, drop, discountRemainingCount, lock }: MintWorkflowOptions,
  operations: MintWorkflowOperations,
): Promise<void> {
  if (lock.current) return;

  const showDiscountLimit = (remainingCount: number) => operations.showToast(
    remainingCount > 0
      ? `Discount available for up to ${dropAssetCount(drop, 'box', remainingCount)}`
      : 'Wallet is not eligible for the discount',
  );
  if (mode === 'discount') {
    const maxDiscountQuantity = Math.max(0, discountRemainingCount);
    if (!Number.isFinite(quantity) || quantity < 1 || quantity > maxDiscountQuantity) {
      showDiscountLimit(maxDiscountQuantity);
      return;
    }
  }

  lock.current = mode;
  operations.setBusy(true);
  let didConfirmMint = false;
  try {
    let proof: Uint8Array[] | null = null;
    if (mode === 'discount') {
      proof = await operations.getDiscountProof();
      if (!proof) {
        operations.updateDiscount(0);
        operations.showToast('Wallet is not eligible for the discount');
        return;
      }
    }

    const mintedQuantity = drop.mintSelection?.kind === 'size' ? 1 : quantity;
    const config = await operations.fetchConfig();
    let onchainUsedCount = 0;
    let onchainRemainingCount = 0;
    if (mode === 'discount') {
      onchainUsedCount = await operations.fetchDiscountUsedCount();
      onchainRemainingCount = Math.max(0, config.discountMintsPerWallet - onchainUsedCount);
      if (quantity > onchainRemainingCount) {
        operations.updateDiscount(onchainRemainingCount, onchainUsedCount);
        showDiscountLimit(onchainRemainingCount);
        return;
      }
    }

    let mintedBoxAssetIds: string[] = [];
    const sendOnce = async () => {
      const mint = await operations.buildTransaction(config, proof);
      mintedBoxAssetIds = mint.boxAccounts.map((account) => account.toBase58());
      return operations.sendAndConfirm(mint);
    };
    let hasConfirmationError: boolean;
    try {
      hasConfirmationError = await sendOnce();
    } catch (error) {
      if (!isBlockhashExpiredError(error)) throw error;
      operations.showToast('Transaction expired before you approved it. Please approve again…');
      hasConfirmationError = await sendOnce();
    }

    if (!hasConfirmationError) {
      operations.onConfirmed(mintedQuantity, mintedBoxAssetIds);
      didConfirmMint = true;
    }
    if (mode === 'discount') {
      const nextUsedCount = hasConfirmationError ? onchainUsedCount : onchainUsedCount + mintedQuantity;
      const nextRemainingCount = hasConfirmationError
        ? onchainRemainingCount
        : Math.max(0, config.discountMintsPerWallet - nextUsedCount);
      operations.updateDiscount(nextRemainingCount, nextUsedCount);
    }
    await operations.refresh(didConfirmMint);
  } catch (error) {
    if (operations.isUserRejectedError(error)) return;
    if (didConfirmMint) {
      operations.warn(
        mode === 'discount'
          ? 'Discount mint succeeded but failed to refresh mint state'
          : 'Mint succeeded but failed to refresh mint state',
        error,
      );
      return;
    }
    if (mode === 'discount') {
      operations.showToast(error instanceof Error ? error.message : `Failed to mint discounted ${dropAssetLabel(drop, 'box')}`);
      return;
    }
    throw error;
  } finally {
    if (lock.current === mode) lock.current = null;
    operations.setBusy(false);
  }
}
