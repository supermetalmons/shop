import { PublicKey } from '@solana/web3.js';
import { DropsPanel } from '../../components/DropsPanel';
import { MintPanel, type MintPanelBoxMedia } from '../../components/MintPanel';
import {
  type FrontendDeploymentConfig
} from '../../config/deployment';
import {
  resolveUpcomingDropRouteByPath
} from '../../lib/dropConfig';
import type { MintStats } from '../../types';
import type { useShopPurchaseActions } from '../purchase/useShopPurchaseActions';
import type { useShopPurchaseState } from '../purchase/useShopPurchaseState';

type ShopPurchaseSectionProps = Pick<ReturnType<typeof useShopPurchaseActions>,
  'minting'
  | 'discountMinting'
  | 'stripePaymentLoading'
  | 'successfulMintToken'
  | 'discountAvailable'
  | 'discountRemainingCount'
  | 'handleMint'
  | 'handleDiscountMint'
  | 'handleStripePayment'
> & Pick<ReturnType<typeof useShopPurchaseState>,
  'packStatusDropId'
  | 'packStatusBreakdown'
  | 'packStatusDisplayLabels'
> & {
  routeDrop: FrontendDeploymentConfig | null;
  upcomingDropRoute: ReturnType<typeof resolveUpcomingDropRouteByPath>;
  upcomingMintPreviewMedia: MintPanelBoxMedia;
  mintPreviewMedia: MintPanelBoxMedia;
  effectiveMintStats: MintStats | undefined;
  routeStripeOnly: boolean | undefined;
  connectedWallet: string | undefined;
  publicKey: PublicKey | null;
  walletBusy: boolean;
  showToast: (message: string) => void;
  handleOpenNotify: () => void;
  routeStripePaymentVisible: boolean;
  routeStripePaymentPriceLabel: string | undefined;
  routeStripePaymentUnitAmountCents: number | null;
};
export function ShopPurchaseSection({
  minting,
  discountMinting,
  stripePaymentLoading,
  successfulMintToken,
  discountAvailable,
  discountRemainingCount,
  handleMint,
  handleDiscountMint,
  handleStripePayment,
  packStatusDropId,
  packStatusBreakdown,
  packStatusDisplayLabels,
  routeDrop,
  upcomingDropRoute,
  upcomingMintPreviewMedia,
  mintPreviewMedia,
  effectiveMintStats,
  routeStripeOnly,
  connectedWallet,
  publicKey,
  walletBusy,
  showToast,
  handleOpenNotify,
  routeStripePaymentVisible,
  routeStripePaymentPriceLabel,
  routeStripePaymentUnitAmountCents,
}: ShopPurchaseSectionProps) {
  return (!routeDrop && upcomingDropRoute ? (
    <MintPanel
      onMint={() => undefined}
      busy={false}
      title={upcomingDropRoute.title}
      boxMedia={upcomingMintPreviewMedia}
      boxNamePrefix={upcomingDropRoute.boxNamePrefix}
      dropId={upcomingDropRoute.dropFamily}
      priceSol={0}
      discountPriceSol={0}
      maxSupply={1}
      maxPerTx={1}
      terminalAction={{
        statusText: upcomingDropRoute.statusText || 'Soon',
        buttonText: 'Notify Me',
        onClick: handleOpenNotify,
      }}
    />
  ) : !routeDrop ? (
    <DropsPanel />
  ) : (
    <MintPanel
      stats={effectiveMintStats}
      onMint={handleMint}
      solanaMintVisible={!routeStripeOnly}
      busy={minting}
      onError={showToast}
      title={routeDrop.displayName || routeDrop.collectionName}
      boxMedia={mintPreviewMedia}
      boxNamePrefix={routeDrop.namePrefix}
      dropId={routeDrop.dropId}
      receiptPoolId={routeDrop.receiptPoolId}
      priceSol={routeDrop.priceSol}
      discountPriceSol={routeDrop.discountPriceSol}
      maxSupply={routeDrop.maxSupply}
      maxPerTx={routeDrop.maxPerTx}
      discountAvailable={!routeStripeOnly && discountAvailable}
      discountMaxQuantity={!routeStripeOnly && connectedWallet && publicKey ? discountRemainingCount : undefined}
      onDiscountMint={routeStripeOnly ? undefined : handleDiscountMint}
      discountBusy={discountMinting || minting || walletBusy}
      onStripePaymentClick={handleStripePayment}
      stripePaymentVisible={routeStripePaymentVisible}
      stripePaymentBusy={stripePaymentLoading}
      stripePaymentPriceLabel={routeStripePaymentPriceLabel}
      stripePaymentUnitAmountCents={routeStripePaymentUnitAmountCents ?? undefined}
      mintSelection={routeDrop.mintSelection}
      successfulMintToken={successfulMintToken}
      onNotifyNextDrops={handleOpenNotify}
      showPackStatusInfo={Boolean(packStatusDropId)}
      packStatusBreakdown={packStatusBreakdown ?? undefined}
      packStatusDisplayLabels={packStatusDisplayLabels ?? undefined}
    />
  ));
}
