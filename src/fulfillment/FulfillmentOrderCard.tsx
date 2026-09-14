import type { CSSProperties } from 'react';
import { FiDownload, FiEdit2 } from 'react-icons/fi';
import { isDirectDeliveryItemsPerBox } from '../../shared/shipping';
import {
  normalizeOptionalFulfillmentTrackingCode,
  resolveFulfillmentTrackingHref,
  shouldDisplayFulfillmentTrackingCode,
} from '../../shared/fulfillmentTracking';
import { isDropFamily, type FrontendDeploymentConfig } from '../config/deployment';
import { CARD_NFT_2_PACK_IMAGES } from '../lib/cardNft2Packs';
import { normalizeBoxDisplayImage, resolveBoxMediaIdForDrop, resolveDropContent } from '../lib/dropContent';
import { dropAssetLabel } from '../lib/dropLabels';
import type { FigureMetadataRecord } from '../lib/figureMetadata';
import {
  fulfillmentBoxSecretCode,
  fulfillmentCardClaimSecretCode,
  fulfillmentLooseFigureIdsExcludingCardClaims,
  isUsedReceiptClaimStatus,
} from '../lib/fulfillmentCodes';
import { formatFulfillmentAddressText } from '../lib/fulfillmentExports';
import { fulfillmentBoxContentsLabel, resolveFulfillmentDirectDeliveryBoxLabel } from '../lib/fulfillmentLabels';
import { canEditFulfillmentOrderAddress, isRedeemedForIrlFulfillmentOrder } from '../lib/fulfillmentOrderVisibility';
import { normalizeFulfillmentStatus } from '../lib/fulfillmentStatus';
import type { FulfillmentOrder } from '../types';
import { FulfillmentFigureTiles, FulfillmentImage } from './FulfillmentMedia';
import { FulfillmentOrderTitle } from './FulfillmentOrderTitle';
import { formatOrderDate } from './manualReview';
import { fulfillmentOrderKey } from './orders';
import type { FulfillmentSecretCodeDownloadTarget } from './useFulfillmentExports';

const BOX_CONTENTS_FIGURE_WIDTH = 130;
const BOX_CONTENTS_FIGURE_GAP = 12;
const BOX_CONTENTS_HORIZONTAL_CHROME = 54;

function getBoxContentsStyle(itemCount: number): CSSProperties {
  const columns = Math.max(1, Math.min(itemCount, 3));
  const contentWidth = columns * BOX_CONTENTS_FIGURE_WIDTH + Math.max(0, columns - 1) * BOX_CONTENTS_FIGURE_GAP;
  return { width: `min(100%, ${contentWidth + BOX_CONTENTS_HORIZONTAL_CHROME}px)` };
}

function SecretCodeDownloadButton(props: {
  secretCode: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  if (!props.onClick) return null;

  return (
    <button
      type="button"
      className="fulfillment-secret-code-download"
      aria-label={`Download PNG for secret code ${props.secretCode}`}
      title="Download PNG"
      disabled={props.disabled}
      onClick={(evt) => {
        evt.stopPropagation();
        props.onClick?.();
      }}
    >
      <FiDownload aria-hidden="true" />
    </button>
  );
}

function fulfillmentSecretCodeClassName(receiptClaimStatus: string | undefined): string {
  return isUsedReceiptClaimStatus(receiptClaimStatus)
    ? 'fulfillment-secret-code fulfillment-secret-code--used'
    : 'fulfillment-secret-code';
}

function SecretCodeDisplay(props: {
  secretCode: string;
  receiptClaimStatus?: string;
  downloadDisabled?: boolean;
  onDownload?: () => void;
  className?: string;
}) {
  const className = props.className
    ? `fulfillment-secret-code-group ${props.className}`
    : 'fulfillment-secret-code-group';

  return (
    <span className={className}>
      <span className="fulfillment-secret-code-heading">
        <span>Secret Code</span>
        <SecretCodeDownloadButton
          secretCode={props.secretCode}
          disabled={props.downloadDisabled}
          onClick={props.onDownload}
        />
      </span>
      <span className={fulfillmentSecretCodeClassName(props.receiptClaimStatus)}>{props.secretCode}</span>
    </span>
  );
}

function FulfillmentBoxTiles(args: {
  boxes: Array<{ boxId: number; boxIndex: number; secretCode: string; receiptClaimStatus?: string }>;
  keyPrefix: string;
  aspectRatio: number;
  labelSource: Pick<FrontendDeploymentConfig, 'namePrefix' | 'figureNamePrefix' | 'mintSelection'>;
  getPreviewSrc?: (boxId: number) => string | undefined;
  secretCodeDownloadDisabled?: boolean;
  onDownloadSecretCode?: (boxIndex: number) => void;
}) {
  const {
    boxes,
    keyPrefix,
    aspectRatio,
    labelSource,
    getPreviewSrc,
    secretCodeDownloadDisabled,
    onDownloadSecretCode,
  } = args;
  return (
    <div className="figure-grid">
      {boxes.map(({ boxId, boxIndex, secretCode, receiptClaimStatus }, index) => {
        const { label, sizeLabel } = resolveFulfillmentDirectDeliveryBoxLabel(labelSource, boxId);
        const imageSrc = getPreviewSrc?.(boxId);
        const hideSecretCodeDownload = isUsedReceiptClaimStatus(receiptClaimStatus);
        return (
          <div key={`${keyPrefix}:${boxId}:${index}`} className="figure-tile">
            <FulfillmentImage src={imageSrc} alt={label} aspectRatio={aspectRatio} />
            <div className={sizeLabel ? 'fulfillment-size-label' : 'muted small'}>{label}</div>
            {secretCode ? (
              <SecretCodeDisplay
                className="muted small"
                secretCode={secretCode}
                receiptClaimStatus={receiptClaimStatus}
                downloadDisabled={secretCodeDownloadDisabled}
                onDownload={
                  onDownloadSecretCode && !hideSecretCodeDownload ? () => onDownloadSecretCode(boxIndex) : undefined
                }
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function FulfillmentPackSecretImage(args: {
  dropId: string;
  boxId: number;
}) {
  const { dropId, boxId } = args;
  const cardNft2PackMediaId = isDropFamily(dropId, 'card_nft_2') ? resolveBoxMediaIdForDrop(dropId, boxId) : null;
  const imageSrc =
    (cardNft2PackMediaId ? CARD_NFT_2_PACK_IMAGES[cardNft2PackMediaId - 1]?.src : undefined) ||
    normalizeBoxDisplayImage({ dropId, boxId });
  if (!imageSrc) return null;
  return (
    <img
      src={imageSrc}
      alt=""
      aria-hidden="true"
      loading="lazy"
      draggable={false}
      className="fulfillment-pack-secret-image"
    />
  );
}

type FulfillmentOrderCardProps = {
  order: FulfillmentOrder;
  drop?: FrontendDeploymentConfig;
  figureMetadataByKey: Record<string, FigureMetadataRecord>;
  showContactInfo?: boolean;
  showFullAddress?: boolean;
  canAdminEditFulfillmentAddress: boolean;
  secretCodeDownloadDisabled: boolean;
  onMetadataResolved: (record: FigureMetadataRecord) => void;
  onEditAddress: (order: FulfillmentOrder) => void;
  onEditStatus: (orderKey: string) => void;
  onPrintLabel: (orderKey: string) => void;
  onDownloadSecretCode: (order: FulfillmentOrder, target: FulfillmentSecretCodeDownloadTarget) => void | Promise<void>;
};

export function FulfillmentOrderCard({
  order,
  drop: orderDrop,
  figureMetadataByKey,
  showContactInfo = true,
  showFullAddress = true,
  canAdminEditFulfillmentAddress,
  secretCodeDownloadDisabled,
  onMetadataResolved,
  onEditAddress,
  onEditStatus,
  onPrintLabel,
  onDownloadSecretCode,
}: FulfillmentOrderCardProps) {
  if (!orderDrop) return null;
  const orderKey = fulfillmentOrderKey(order);
  const orderDropContent = resolveDropContent(orderDrop);
  const orderFigureMediaBase = orderDropContent.figures.fulfillmentMediaBaseUrl;
  const orderIsDirectDeliveryDrop = isDirectDeliveryItemsPerBox(orderDrop.itemsPerBox);
  const orderShowsFulfillmentPackPreview = isDropFamily(orderDrop, 'card_nft_2');
  const cardClaims = order.cardClaims || [];
  const looseDudes = fulfillmentLooseFigureIdsExcludingCardClaims(order);
  const canEditOrderAddress = canEditFulfillmentOrderAddress(order, {
    showFullAddress,
    hasAddressAccess: canAdminEditFulfillmentAddress,
  });
  const canPrintOrderLabel =
    !isRedeemedForIrlFulfillmentOrder(order) &&
    (Boolean(order.shipstationShipmentId) || normalizeFulfillmentStatus(order.fulfillmentStatus) !== 'Shipped');
  const showOrderEmailLine =
    showContactInfo && ((order.address.full !== '***' && Boolean(order.address.email)) || canEditOrderAddress);
  return (
    <div className="fulfillment-order-section">
      <div className="card__head">
        <div>
          <FulfillmentOrderTitle order={order} />
          <div className="muted fulfillment-order-date small">{formatOrderDate(order.processedAt || order.createdAt)}</div>
          {showOrderEmailLine ? (
            <div className="fulfillment-order-email-line">
              {order.address.full !== '***' && order.address.email ? (
                <div className="muted small">{order.address.email}</div>
              ) : null}
              {canEditOrderAddress ? (
                <button
                  type="button"
                  className="fulfillment-order-address-edit"
                  onClick={() => onEditAddress(order)}
                  aria-label={`Edit address for order ${order.deliveryId}`}
                  title="Edit address"
                >
                  <FiEdit2 aria-hidden="true" />
                </button>
              ) : null}
            </div>
          ) : null}
          {showContactInfo && order.address.full !== '***' && order.address.phone ? (
            <div className="muted small">{order.address.phone}</div>
          ) : null}
        </div>
        <div className="order-update">
          {(() => {
            const statusText = normalizeFulfillmentStatus(order.fulfillmentStatus);
            const trackingCode = shouldDisplayFulfillmentTrackingCode(order.fulfillmentStatus, order.fulfillmentTrackingCode)
              ? normalizeOptionalFulfillmentTrackingCode(order.fulfillmentTrackingCode)
              : '';
            const trackingHref = resolveFulfillmentTrackingHref(trackingCode);
            return statusText ? (
              <>
                <div className="status-readout fulfillment-order-status-text small">{statusText}</div>
                {trackingCode ? (
                  trackingHref ? (
                    <a className="tracking-link small" href={trackingHref} target="_blank" rel="noopener noreferrer">
                      Tracking
                    </a>
                  ) : (
                    <div className="tracking-code-readout mono small">{trackingCode}</div>
                  )
                ) : null}
              </>
            ) : (
              <em className="muted fulfillment-order-status-text small">Not set</em>
            );
          })()}
          <button
            type="button"
            className="link fulfillment-order-status-action small no-focus-style"
            onClick={() => onEditStatus(orderKey)}
          >
            {normalizeFulfillmentStatus(order.fulfillmentStatus) ? 'Edit status' : 'Set status'}
          </button>
        </div>
      </div>

      <div className="order-items">
        {showFullAddress || canPrintOrderLabel ? (
          <div className="address-lines">
            {showFullAddress ? (
              order.address.full ? (
                <div className="address-text">
                  {formatFulfillmentAddressText(order.address)}
                </div>
              ) : (
                <>
                  <div className="muted small">Encrypted address payload</div>
                  <div className="mono small">{order.address.encrypted || 'Unavailable'}</div>
                </>
              )
            ) : null}
            {canPrintOrderLabel ? (
              <div className="fulfillment-order-address-actions">
                <button
                  type="button"
                  className="link fulfillment-order-address-action small no-focus-style"
                  onClick={() => onPrintLabel(orderKey)}
                >
                  Print Label
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {order.boxes.length ? (
          orderIsDirectDeliveryDrop ? (
            <FulfillmentBoxTiles
              boxes={order.boxes.map((box, boxIndex) => ({
                boxId: box.boxId,
                boxIndex,
                secretCode: fulfillmentBoxSecretCode(box),
                receiptClaimStatus: box.receiptClaimStatus,
              }))}
              keyPrefix={`${orderKey}:box`}
              aspectRatio={orderDropContent.box.aspectRatio}
              labelSource={orderDrop}
              getPreviewSrc={(boxId) => normalizeBoxDisplayImage({ dropId: orderDrop.dropId, boxId })}
              secretCodeDownloadDisabled={secretCodeDownloadDisabled}
              onDownloadSecretCode={(boxIndex) =>
                void onDownloadSecretCode(order, { kind: 'box', index: boxIndex })}
            />
          ) : (
            <div className="box-contents-list">
              {order.boxes.map((box, boxIndex) => {
                const secretCode = fulfillmentBoxSecretCode(box);
                const hideSecretCodeDownload = isUsedReceiptClaimStatus(box.receiptClaimStatus);
                const packSecretImage = orderShowsFulfillmentPackPreview ? (
                  <FulfillmentPackSecretImage
                    dropId={orderDrop.dropId}
                    boxId={box.boxId}
                  />
                ) : null;
                return (
                  <div
                    key={`${orderKey}:${box.boxId}`}
                    className="card subtle box-contents"
                    style={getBoxContentsStyle(box.dudeIds.length)}
                  >
                    <div className="card__title">
                      {secretCode ? (
                        <span className="fulfillment-pack-secret">
                          {packSecretImage}
                          <SecretCodeDisplay
                            secretCode={secretCode}
                            receiptClaimStatus={box.receiptClaimStatus}
                            downloadDisabled={secretCodeDownloadDisabled}
                            onDownload={
                              hideSecretCodeDownload
                                ? undefined
                                : () => void onDownloadSecretCode(order, { kind: 'box', index: boxIndex })
                            }
                          />
                        </span>
                      ) : (
                        fulfillmentBoxContentsLabel(orderDrop, box.boxId, '')
                      )}
                    </div>
                    {!secretCode ? (
                      <div className="muted small">Secret code unavailable</div>
                    ) : !box.dudeIds.length ? (
                      <div className="muted small">Assigned {dropAssetLabel(orderDrop, 'figure', 2)} pending</div>
                    ) : null}
                    {box.dudeIds.length ? (
                      <FulfillmentFigureTiles
                        dropId={orderDrop.dropId}
                        drop={orderDrop}
                        figureIds={box.dudeIds}
                        keyPrefix={`${orderKey}:${box.boxId}`}
                        figureNamePrefix={orderDrop.figureNamePrefix}
                        previewMode={orderDropContent.figures.fulfillmentPreviewMode}
                        figureMediaBase={orderFigureMediaBase}
                        figureMedia={orderDrop.figureMedia}
                        figureMetadataByKey={figureMetadataByKey}
                        onMetadataResolved={onMetadataResolved}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          )
        ) : null}

        {cardClaims.length ? (
          <FulfillmentFigureTiles
            dropId={orderDrop.dropId}
            drop={orderDrop}
            figureIds={cardClaims.map((claim) => claim.figureId)}
            keyPrefix={`${orderKey}:card-claim`}
            figureNamePrefix={orderDrop.figureNamePrefix}
            previewMode={orderDropContent.figures.fulfillmentPreviewMode}
            figureMediaBase={orderFigureMediaBase}
            figureMedia={orderDrop.figureMedia}
            figureMetadataByKey={figureMetadataByKey}
            onMetadataResolved={onMetadataResolved}
            renderFooter={({ index }) => {
              const claim = cardClaims[index];
              const secretCode = claim ? fulfillmentCardClaimSecretCode(claim) : '';
              if (!claim || !secretCode) {
                return <span className="muted small">Secret code unavailable</span>;
              }
              const hideSecretCodeDownload = isUsedReceiptClaimStatus(claim.receiptClaimStatus);
              return (
                <SecretCodeDisplay
                  className="muted small"
                  secretCode={secretCode}
                  receiptClaimStatus={claim.receiptClaimStatus}
                  downloadDisabled={secretCodeDownloadDisabled}
                  onDownload={
                    hideSecretCodeDownload
                      ? undefined
                      : () => void onDownloadSecretCode(order, { kind: 'card-claim', index })
                  }
                />
              );
            }}
          />
        ) : null}

        {looseDudes.length ? (
          <FulfillmentFigureTiles
            dropId={orderDrop.dropId}
            drop={orderDrop}
            figureIds={looseDudes}
            keyPrefix={`${orderKey}:dude`}
            figureNamePrefix={orderDrop.figureNamePrefix}
            previewMode={orderDropContent.figures.fulfillmentPreviewMode}
            figureMediaBase={orderFigureMediaBase}
            figureMedia={orderDrop.figureMedia}
            figureMetadataByKey={figureMetadataByKey}
            onMetadataResolved={onMetadataResolved}
          />
        ) : null}
      </div>
    </div>
  );
}
