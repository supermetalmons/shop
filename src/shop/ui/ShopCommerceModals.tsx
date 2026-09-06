import { PublicKey } from '@solana/web3.js';
import { FaBoxOpen, FaReceipt } from 'react-icons/fa6';
import { ClaimForm } from '../../components/ClaimForm';
import { DeliveryForm } from '../../components/DeliveryForm';
import { Modal } from '../../components/Modal';
import { ReceiptTransferForm } from '../../components/ReceiptTransferForm';
import {
  type FrontendDeploymentConfig
} from '../../config/deployment';
import { hideImageShowFallback, showImageHideFallback } from '../../lib/imageFallback';
import type { ActiveModalLayer } from '../../lib/modalLayers';
import {
  isModalLayerSuspended
} from '../../lib/modalLayers';
import {
  shortAddress
} from '../../lib/solana';
import type { ShopAccount } from '../account/useShopAccount';
import type { useClaimActions } from '../commerce/useClaimActions';
import type { useCommerceModals } from '../commerce/useCommerceModals';
import type { useDeliveryActions } from '../commerce/useDeliveryActions';
import type { useReceiptActions } from '../commerce/useReceiptActions';
import type { ShopInventoryView } from '../inventory/useShopInventoryView';
import { RevealOverlayState } from '../reveal/types';

type ShopCommerceModalsProps = {
  modals: ReturnType<typeof useCommerceModals>;
  view: ShopInventoryView;
  activeModalLayer: ActiveModalLayer;
  suspended: boolean;
  connectedWallet: string | undefined;
  publicKey: PublicKey | null;
  routeDrop: FrontendDeploymentConfig | null;
  viewedProfile: ShopAccount['viewedProfile'];
  pendingDeliveryItemIds: ReadonlySet<string>;
  revealOverlay: RevealOverlayState | null;
  handleReceiptTransfer: ReturnType<typeof useReceiptActions>['handleReceiptTransfer'];
  handleAdminIrlRedeem: ReturnType<typeof useReceiptActions>['handleAdminIrlRedeem'];
  handleShip: ReturnType<typeof useDeliveryActions>['handleShip'];
  handleClaim: ReturnType<typeof useClaimActions>['handleClaim'];
};
export function ShopCommerceModals({
  modals,
  view,
  activeModalLayer,
  suspended,
  connectedWallet,
  publicKey,
  routeDrop,
  viewedProfile,
  pendingDeliveryItemIds,
  revealOverlay,
  handleReceiptTransfer,
  handleAdminIrlRedeem,
  handleShip,
  handleClaim,
}: ShopCommerceModalsProps) {
  const {
    receiptTransferTarget,
    receiptTransferInFlight,
    receiptTransferReturnFocusRef,
    closeReceiptTransferModal,
    deliveryOpen,
    closeDelivery,
    deliveryCountryCode,
    setDeliveryCountryCode,
    adminIrlRedeeming,
    claimOpen,
    claimSubmitting,
    closeClaimModal,
    setClaimSubmitting,
    claimInitialCode,
  } = modals;
  const { selectionSummary, selectedDropConfig, canShipSelected, deliveryCtaLabel, canShowAdminIrlRedeem } = view;
  const receiptTransferThumbnail =
    receiptTransferTarget?.image ||
    (receiptTransferTarget
      ? revealOverlay?.receiptImages?.find((image) => image.key === receiptTransferTarget.id)?.image
      : undefined);
  return <><Modal
    open={Boolean(receiptTransferTarget)}
    title="Transfer receipt"
    ariaLabel={
      receiptTransferTarget
        ? `Transfer receipt: ${receiptTransferTarget.name || shortAddress(receiptTransferTarget.id)}`
        : 'Transfer receipt'
    }
    titleAbove={
      receiptTransferTarget ? (
        <>
          {receiptTransferThumbnail ? (
            <img
              className="receipt-transfer-modal__thumbnail"
              src={receiptTransferThumbnail}
              alt=""
              draggable={false}
              onLoad={(evt) => showImageHideFallback(evt.currentTarget)}
              onError={(evt) => hideImageShowFallback(evt.currentTarget)}
            />
          ) : null}
          <span
            className="receipt-transfer-modal__thumbnail receipt-transfer-modal__thumbnail--placeholder"
            hidden={Boolean(receiptTransferThumbnail)}
          >
            <FaReceipt aria-hidden="true" focusable="false" />
          </span>
        </>
      ) : undefined
    }
    onClose={closeReceiptTransferModal}
    className="compact-modal receipt-transfer-modal"
    overlayClassName="receipt-transfer-modal-overlay"
    blurBackground
    showCloseButton={false}
    closeOnEscape={!receiptTransferInFlight}
    suspended={isModalLayerSuspended({
      activeLayer: activeModalLayer,
      appSuspended: suspended,
      layer: 'transfer',
      open: Boolean(receiptTransferTarget),
    })}
    returnFocusRef={receiptTransferReturnFocusRef}
  >
    {receiptTransferTarget ? (
      <ReceiptTransferForm
        feePayer={connectedWallet || ''}
        onCancel={closeReceiptTransferModal}
        onTransfer={handleReceiptTransfer}
      />
    ) : null}
  </Modal>
    <Modal
      open={deliveryOpen}
      title="Shipment"
      onClose={closeDelivery}
      suspended={isModalLayerSuspended({
        activeLayer: activeModalLayer,
        appSuspended: suspended,
        layer: 'shipment',
        open: deliveryOpen,
      })}
    >
      <div className="modal-form delivery-modal">
        <div className="delivery-modal__summary">
          <div>
            <div className="card__title">{selectionSummary}</div>
          </div>
        </div>

        {!connectedWallet || !publicKey ? <div className="muted small">Connect a wallet to ship items.</div> : null}
        <DeliveryForm
          mode="modal"
          onSubmit={handleShip}
          defaultEmail={viewedProfile?.email || ''}
          itemsPerBox={selectedDropConfig?.itemsPerBox}
          boxNamePrefix={selectedDropConfig?.namePrefix}
          figureNamePrefix={selectedDropConfig?.figureNamePrefix}
          dropFamily={selectedDropConfig?.dropFamily}
          shipmentPending={pendingDeliveryItemIds.size > 0}
          submitDisabled={
            !canShipSelected ||
            !connectedWallet ||
            !publicKey ||
            pendingDeliveryItemIds.size > 0 ||
            adminIrlRedeeming
          }
          countryCode={deliveryCountryCode}
          onCountryCodeChange={setDeliveryCountryCode}
          submitLabel={deliveryCtaLabel}
        />
        {canShowAdminIrlRedeem ? (
          <div className="delivery-modal__admin-irl">
            <button
              type="button"
              className="ghost delivery-modal__admin-irl-button"
              onClick={() => {
                void handleAdminIrlRedeem();
              }}
              disabled={adminIrlRedeeming}
            >
              <FaBoxOpen aria-hidden="true" focusable="false" size={16} />
              <span>{adminIrlRedeeming ? 'Redeeming…' : 'Admin IRL Redeem'}</span>
            </button>
          </div>
        ) : null}
      </div>
    </Modal>
    <Modal
      open={claimOpen}
      title="Secret Code"
      onClose={closeClaimModal}
      closeOnEscape={!claimSubmitting}
      suspended={isModalLayerSuspended({
        activeLayer: activeModalLayer,
        appSuspended: suspended,
        layer: 'claim',
        open: claimOpen,
      })}
    >
      <ClaimForm
        onClaim={handleClaim}
        onSuccess={closeClaimModal}
        onLoadingChange={setClaimSubmitting}
        mode="modal"
        showTitle={false}
        itemsPerBox={routeDrop?.itemsPerBox}
        boxNamePrefix={routeDrop?.namePrefix}
        figureNamePrefix={routeDrop?.figureNamePrefix}
        initialCode={claimInitialCode}
        defaultRecipient={connectedWallet || ''}
      />
    </Modal></>;
}
