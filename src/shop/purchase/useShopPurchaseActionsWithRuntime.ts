import { useMemo, useRef, useState } from 'react';
import type { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import type { FrontendDeploymentConfig } from '../../config/deployment';
import type { MintStats } from '../../types';
import type { useStripeCheckoutRecovery } from '../../hooks/useStripeCheckoutRecovery';
import {
  stripeCheckoutOperationAfterFailure,
  stripeCheckoutOperationState,
  stripeCheckoutOperationWithCredential,
  type StripeCheckoutOperationState,
} from '../../api/commerce';
import { recoverAlreadyProcessedAccounts } from '../../lib/solana';
import { classifyStripeCheckoutKind, stripeCheckoutModeForDrop } from '../../../shared/stripeCheckoutCore';
import { runMintWorkflow, type MintMode } from '../mint';
import { useMintDiscount } from './useMintDiscount';

export type ShopPurchaseRuntime = {
  createStripeCheckoutSession: typeof import('../../api/commerce')['createStripeCheckoutSession'];
  buildMintBoxesTxWithAccounts: typeof import('../../lib/boxMinter')['buildMintBoxesTxWithAccounts'];
  buildMintDiscountedBoxTxWithAccounts: typeof import('../../lib/boxMinter')['buildMintDiscountedBoxTxWithAccounts'];
  buildMintDiscountedVariantBoxTxWithAccounts: typeof import('../../lib/boxMinter')['buildMintDiscountedVariantBoxTxWithAccounts'];
  buildMintVariantBoxTxWithAccounts: typeof import('../../lib/boxMinter')['buildMintVariantBoxTxWithAccounts'];
  fetchBoxMinterConfig: typeof import('../../lib/boxMinter')['fetchBoxMinterConfig'];
  fetchDiscountMintRecordUsedCount: typeof import('../../lib/boxMinter')['fetchDiscountMintRecordUsedCount'];
  getDiscountProof: typeof import('../../lib/discounts')['getDiscountProof'];
  isDiscountListed: typeof import('../../lib/discounts')['isDiscountListed'];
  registerRecentExpectedInventoryAssets: typeof import('../../lib/recentExpectedInventoryAssets')['registerRecentExpectedInventoryAssets'];
  redirect: (url: string) => void;
};

export type ShopPurchaseActionsOptions = {
  routeDrop: FrontendDeploymentConfig | null;
  routeConnection: Connection | null;
  connectedWallet: string | undefined;
  publicKey: PublicKey | null;
  walletBusy: boolean;
  authSubject: string | null;
  effectiveMintStats: MintStats | undefined;
  activeDiscountAllowance: number;
  activeDiscountScope: string;
  activeDiscountVersion: string;
  shouldFetchMintStats: boolean;
  refetchStats: () => Promise<unknown>;
  refetchInventory: () => Promise<unknown>;
  refreshInventoryAfterMint: () => Promise<unknown>;
  addLocalMintedBoxes: (quantity: number, dropId: string, assetIds: readonly string[]) => void;
  blockViewerModeAction: () => boolean;
  requireRouteDrop: (context: string) => FrontendDeploymentConfig;
  setVisible: (visible: boolean) => void;
  showToast: (message: string) => void;
  isUserRejectedError: (error: unknown) => boolean;
  rememberCheckoutStarted: ReturnType<typeof useStripeCheckoutRecovery>['rememberCheckoutStarted'];
  sendAndConfirmMintViaConnection: (
    transaction: VersionedTransaction,
    connection: Connection,
    options?: { onAlreadyProcessedWithoutSignature?: (error: unknown) => Promise<boolean> },
  ) => Promise<boolean>;
};

export function useShopPurchaseActionsWithRuntime({
  routeDrop, routeConnection, connectedWallet, publicKey, walletBusy, authSubject,
  effectiveMintStats, activeDiscountAllowance, activeDiscountScope, activeDiscountVersion,
  shouldFetchMintStats, refetchStats, refetchInventory, refreshInventoryAfterMint,
  addLocalMintedBoxes, blockViewerModeAction, requireRouteDrop, setVisible, showToast,
  isUserRejectedError, rememberCheckoutStarted, sendAndConfirmMintViaConnection,
}: ShopPurchaseActionsOptions, runtime: ShopPurchaseRuntime) {
  const {
    createStripeCheckoutSession,
    buildMintBoxesTxWithAccounts, buildMintDiscountedBoxTxWithAccounts,
    buildMintDiscountedVariantBoxTxWithAccounts, buildMintVariantBoxTxWithAccounts,
    fetchBoxMinterConfig, fetchDiscountMintRecordUsedCount, getDiscountProof,
    registerRecentExpectedInventoryAssets,
  } = runtime;
  const [minting, setMinting] = useState(false);
  const [discountMinting, setDiscountMinting] = useState(false);
  const [stripePaymentLoading, setStripePaymentLoading] = useState(false);
  const [successfulMintToken, setSuccessfulMintToken] = useState(0);
  const mintActionLockRef = useRef<MintMode | null>(null);
  const stripeCheckoutOperationRef = useRef<StripeCheckoutOperationState | null>(null);
  const mintedOut = useMemo(() => {
    return !effectiveMintStats || effectiveMintStats.remaining <= 0;
  }, [effectiveMintStats]);

  const {
    discountEligible, discountRemainingCount, discountChecking, discountAvailable, captureDiscountUpdate,
  } = useMintDiscount({
    routeDrop, routeConnection, connectedWallet, publicKey, walletBusy, mintedOut,
    activeDiscountAllowance, activeDiscountScope, activeDiscountVersion,
  }, runtime);
  const handleSolanaMint = async (mode: MintMode, quantity: number, variantKey?: string) => {
    if (blockViewerModeAction()) return;
    const action = mode === 'discount' ? 'discount mint' : 'mint';
    const mintDrop = requireRouteDrop(action);
    if (mintDrop.salesMode === 'stripe_receipt_only') {
      showToast('This drop is available through Stripe checkout only');
      return;
    }
    if (!connectedWallet || !publicKey) {
      setVisible(true);
      return;
    }
    if (!routeConnection) throw new Error(`Missing route connection for ${action}`);
    if (mintedOut || minting || discountMinting || mintActionLockRef.current) return;
    if (mintDrop.mintSelection?.kind === 'size' && !variantKey) {
      showToast('Select a size');
      return;
    }

    await runMintWorkflow({
      mode,
      quantity,
      drop: mintDrop,
      discountRemainingCount,
      lock: mintActionLockRef,
    }, {
      setBusy: mode === 'discount' ? setDiscountMinting : setMinting,
      getDiscountProof: () => getDiscountProof(mintDrop.dropId, publicKey.toBase58()),
      fetchConfig: () => fetchBoxMinterConfig(routeConnection, mintDrop),
      fetchDiscountUsedCount: () => fetchDiscountMintRecordUsedCount(routeConnection, publicKey, mintDrop),
      buildTransaction: (config, proof) => {
        if (proof) {
          return mintDrop.mintSelection?.kind === 'size'
            ? buildMintDiscountedVariantBoxTxWithAccounts(routeConnection, config, publicKey, variantKey || '', proof, mintDrop)
            : buildMintDiscountedBoxTxWithAccounts(routeConnection, config, publicKey, quantity, proof, mintDrop);
        }
        return mintDrop.mintSelection?.kind === 'size'
          ? buildMintVariantBoxTxWithAccounts(routeConnection, config, publicKey, variantKey || '', mintDrop)
          : buildMintBoxesTxWithAccounts(routeConnection, config, publicKey, quantity, mintDrop);
      },
      sendAndConfirm: ({ tx, boxAccounts }) => sendAndConfirmMintViaConnection(tx, routeConnection, {
        onAlreadyProcessedWithoutSignature: (error) => recoverAlreadyProcessedAccounts(routeConnection, boxAccounts, error),
      }),
      onConfirmed: (mintedQuantity, assetIds) => {
        registerRecentExpectedInventoryAssets(publicKey.toBase58(), mintDrop.solanaCluster, assetIds);
        addLocalMintedBoxes(mintedQuantity, mintDrop.dropId, assetIds);
        setSuccessfulMintToken((prev) => prev + 1);
      },
      updateDiscount: captureDiscountUpdate(),
      refresh: (confirmed) => Promise.all([
        shouldFetchMintStats ? refetchStats() : Promise.resolve(),
        confirmed ? refreshInventoryAfterMint() : refetchInventory(),
      ]),
      isUserRejectedError,
      showToast,
      warn: (message, error) => console.warn(message, error),
    });
  };

  const handleMint = (quantity: number, variantKey?: string) => handleSolanaMint('mint', quantity, variantKey);
  const handleDiscountMint = (quantity: number, variantKey?: string) => handleSolanaMint('discount', quantity, variantKey);

  const handleStripePayment = async (quantity: number, variantKey?: string) => {
    if (blockViewerModeAction()) return;
    const mintDrop = requireRouteDrop('Stripe payment');
    const stripePaymentMode = stripeCheckoutModeForDrop(mintDrop);
    if (!stripePaymentMode) {
      showToast('Stripe payment is not enabled for this drop');
      return;
    }
    const stripeCheckoutKind = classifyStripeCheckoutKind(mintDrop);
    if (!stripeCheckoutKind) {
      showToast('Stripe payment is not available for this drop');
      return;
    }
    if (stripePaymentLoading) return;

    setStripePaymentLoading(true);
    try {
      const returnUrl = typeof window !== 'undefined' ? window.location.href : undefined;
      const checkoutQuantity = stripeCheckoutKind === 'size_variant' ? 1 : quantity;
      const checkoutRequest = {
        dropId: mintDrop.dropId,
        quantity: checkoutQuantity,
        variantKey,
        returnUrl,
      };
      const operation = stripeCheckoutOperationState(
        stripeCheckoutOperationRef.current,
        checkoutRequest,
        authSubject,
      );
      stripeCheckoutOperationRef.current = operation;
      const { id, url, authSubject: checkoutAuthSubject } = await createStripeCheckoutSession(
        checkoutRequest,
        operation.operationId,
        (credentialSubject) => {
          const current = stripeCheckoutOperationRef.current;
          if (current?.operationId !== operation.operationId) return;
          stripeCheckoutOperationRef.current = stripeCheckoutOperationWithCredential(
            current,
            credentialSubject,
          );
        },
      );
      rememberCheckoutStarted({
        sessionId: id,
        dropId: mintDrop.dropId,
        authSubject: checkoutAuthSubject,
        createdAt: Date.now(),
        quantity: checkoutQuantity,
        remainingBeforeCheckout: effectiveMintStats?.remaining,
        variantKey,
        variantRemainingBeforeCheckout: variantKey
          ? effectiveMintStats?.mintSelectionAvailability?.[variantKey]
          : undefined,
      });
      runtime.redirect(url);
      stripeCheckoutOperationRef.current = null;
    } catch (err) {
      stripeCheckoutOperationRef.current = stripeCheckoutOperationAfterFailure(
        stripeCheckoutOperationRef.current,
        err,
      );
      showToast(err instanceof Error ? err.message : 'Failed to start Stripe payment');
    } finally {
      setStripePaymentLoading(false);
    }
  };

  return {
    minting, discountMinting, stripePaymentLoading, successfulMintToken,
    discountEligible, discountRemainingCount, discountChecking, discountAvailable, mintedOut,
    handleMint, handleDiscountMint, handleStripePayment,
  };
}
