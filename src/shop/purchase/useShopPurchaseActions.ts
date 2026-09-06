import { createStripeCheckoutSession } from '../../api/commerce';
import {
  buildMintBoxesTxWithAccounts,
  buildMintDiscountedBoxTxWithAccounts,
  buildMintDiscountedVariantBoxTxWithAccounts,
  buildMintVariantBoxTxWithAccounts,
  fetchBoxMinterConfig,
  fetchDiscountMintRecordUsedCount,
} from '../../lib/boxMinter';
import { getDiscountProof, isDiscountListed } from '../../lib/discounts';
import { registerRecentExpectedInventoryAssets } from '../../lib/recentExpectedInventoryAssets';
import {
  useShopPurchaseActionsWithRuntime,
  type ShopPurchaseActionsOptions,
  type ShopPurchaseRuntime,
} from './useShopPurchaseActionsWithRuntime';

const DEFAULT_RUNTIME = {
  createStripeCheckoutSession,
  buildMintBoxesTxWithAccounts,
  buildMintDiscountedBoxTxWithAccounts,
  buildMintDiscountedVariantBoxTxWithAccounts,
  buildMintVariantBoxTxWithAccounts,
  fetchBoxMinterConfig,
  fetchDiscountMintRecordUsedCount,
  getDiscountProof,
  isDiscountListed,
  registerRecentExpectedInventoryAssets,
  redirect: (url: string) => window.location.assign(url),
};

export function useShopPurchaseActions(options: ShopPurchaseActionsOptions) {
  return useShopPurchaseActionsWithRuntime(options, DEFAULT_RUNTIME satisfies ShopPurchaseRuntime);
}
