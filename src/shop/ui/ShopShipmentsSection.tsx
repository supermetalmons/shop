import type { ReactNode } from 'react';
import {
  useCallback
} from 'react';
import {
  normalizeOptionalFulfillmentTrackingCode,
  resolveFulfillmentTrackingHref
} from '../../../shared/fulfillmentTracking.ts';
import {
  getFrontendDrop,
  type FrontendDeploymentConfig
} from '../../config/deployment';
import { clearCardModelUrl } from '../../lib/clearCardModels';
import {
  joinDropAssetUrl,
  normalizeBoxDisplayImage,
  resolveDropContent
} from '../../lib/dropContent';
import {
  dropAssetReference
} from '../../lib/dropLabels';
import { getMediaIdForFigureId } from '../../lib/figureMediaMap';
import {
  figureMetadataCacheKey,
  figureMetadataHasImage,
  getCachedFigureMetadata,
  type FigureMetadataRecord
} from '../../lib/figureMetadata';
import {
  getInteractiveCardPackCardByFigureId
} from '../../lib/interactiveCardPackReveal';
import { getInventoryRevealRect } from '../../lib/inventoryMediaRect';
import {
  DeliveryOrderSummary
} from '../../types';
import { displayOrderStatus, formatOrderDate, shouldShowDeliveryTrackingCode } from '../account/display';
import { FigureTileImage } from '../inventory/media';
import { getRenderedImagePreview } from '../reveal/layout';
import type { ShopRevealController } from '../reveal/useShopReveal';

type ShopShipmentsSectionProps = Pick<ShopRevealController,
  'openClearCardModelViewer'
  | 'openImageViewer'
  | 'openInteractiveCardViewer'
  | 'usesClearCard3dRevealForDropId'
  | 'usesInteractiveCardPackRevealForDropId'
> & {
  shipmentsSectionReady: boolean;
  deliveryOrders: DeliveryOrderSummary[];
  shipmentsRetainedError: string | null;
  dropById: Map<string, FrontendDeploymentConfig>;
  shipmentsEmptyStateVisibility: 'visible' | 'hidden';
  shipmentsEmptyContent: ReactNode;
  figureMetadataByKey: Record<string, FigureMetadataRecord>;
  getDropContent: (dropId?: string) => ReturnType<typeof resolveDropContent>;
  mergeLoadedFigureMetadata: (record: FigureMetadataRecord) => void;
};
export function ShopShipmentsSection({
  openClearCardModelViewer,
  openImageViewer,
  openInteractiveCardViewer,
  usesClearCard3dRevealForDropId,
  usesInteractiveCardPackRevealForDropId,
  shipmentsSectionReady,
  deliveryOrders,
  shipmentsRetainedError,
  dropById,
  shipmentsEmptyStateVisibility,
  shipmentsEmptyContent,
  figureMetadataByKey,
  getDropContent,
  mergeLoadedFigureMetadata,
}: ShopShipmentsSectionProps) {
  const renderShipmentItems = useCallback(
    (order: DeliveryOrderSummary) => {
      const dropConfig = getFrontendDrop(order.dropId);
      const dropContent = getDropContent(order.dropId);
      const figureMediaBase = dropContent.figures.fulfillmentMediaBaseUrl;
      const useMediaFolderPreview = dropContent.figures.fulfillmentPreviewMode === 'media_map_folder';
      return (
        <div className="figure-grid shipment-item-grid">
          {order.items.map((item, index) => {
            const label = dropAssetReference(dropConfig, item.kind === 'box' ? 'box' : 'figure', item.refId);
            const previewId = `shipment:${order.dropId}:${order.deliveryId}:${item.kind}:${item.refId}:${index}`;
            if (item.kind === 'box') {
              const boxImage = normalizeBoxDisplayImage({ dropId: order.dropId, boxId: item.refId });
              return (
                <div
                  key={previewId}
                  className="figure-tile shipment-item-tile shipment-item-tile--interactive"
                  role="button"
                  tabIndex={0}
                  aria-label={`View ${label}`}
                  draggable={false}
                  onDragStart={(evt) => evt.preventDefault()}
                  onClick={(evt) => {
                    const originRect = getInventoryRevealRect(evt.currentTarget);
                    const previewImage = getRenderedImagePreview(evt.currentTarget, boxImage);
                    openImageViewer(
                      { id: previewId, dropId: order.dropId, name: label, image: previewImage.src },
                      originRect,
                      {
                        aspectRatio: previewImage.aspectRatio,
                        size: 'shipment',
                        unavailableMessage: 'Shipment image unavailable',
                      },
                    );
                  }}
                  onKeyDown={(evt) => {
                    if (evt.key !== 'Enter' && evt.key !== ' ') return;
                    evt.preventDefault();
                    const originRect = getInventoryRevealRect(evt.currentTarget);
                    const previewImage = getRenderedImagePreview(evt.currentTarget, boxImage);
                    openImageViewer(
                      { id: previewId, dropId: order.dropId, name: label, image: previewImage.src },
                      originRect,
                      {
                        aspectRatio: previewImage.aspectRatio,
                        size: 'shipment',
                        unavailableMessage: 'Shipment image unavailable',
                      },
                    );
                  }}
                >
                  {boxImage ? (
                    <img
                      src={boxImage}
                      alt={label}
                      loading="lazy"
                      className="figure-image"
                      draggable={false}
                      onDragStart={(evt) => evt.preventDefault()}
                    />
                  ) : (
                    <div className="figure-image figure-image--placeholder" aria-hidden="true" />
                  )}
                </div>
              );
            }

            const cacheKey = figureMetadataCacheKey(order.dropId, item.refId);
            const metadata = figureMetadataByKey[cacheKey] || getCachedFigureMetadata(order.dropId, item.refId);
            const fallbackSrc = figureMetadataHasImage(metadata) ? metadata.image : undefined;
            const mediaId = useMediaFolderPreview
              ? getMediaIdForFigureId(item.refId, dropConfig?.figureMedia)
              : undefined;
            const primarySrc = mediaId ? joinDropAssetUrl(figureMediaBase, `${mediaId}.webp`) : undefined;
            const canViewInteractiveCard =
              usesInteractiveCardPackRevealForDropId(order.dropId) &&
              Boolean(getInteractiveCardPackCardByFigureId(order.dropId, item.refId));
            const canViewClearCardModel =
              usesClearCard3dRevealForDropId(order.dropId) &&
              Boolean(clearCardModelUrl(item.refId));
            const previewImage = primarySrc || fallbackSrc;

            return (
              <div
                key={previewId}
                className="figure-tile shipment-item-tile shipment-item-tile--interactive"
                role="button"
                tabIndex={0}
                aria-label={`View ${label}`}
                draggable={false}
                onDragStart={(evt) => evt.preventDefault()}
                onClick={(evt) => {
                  const originRect = getInventoryRevealRect(evt.currentTarget);
                  const renderedPreviewImage = getRenderedImagePreview(evt.currentTarget, previewImage);
                  if (canViewClearCardModel) {
                    openClearCardModelViewer({
                      overlayId: previewId,
                      dropId: order.dropId,
                      name: label,
                      image: renderedPreviewImage.src,
                      figureId: item.refId,
                      viewerMode: 'clear-card',
                      originRect,
                    });
                    return;
                  }
                  if (canViewInteractiveCard) {
                    openInteractiveCardViewer({
                      overlayId: previewId,
                      dropId: order.dropId,
                      name: label,
                      image: renderedPreviewImage.src,
                      figureId: item.refId,
                      originRect,
                    });
                    return;
                  }
                  openImageViewer(
                    { id: previewId, dropId: order.dropId, name: label, image: renderedPreviewImage.src },
                    originRect,
                    {
                      aspectRatio: renderedPreviewImage.aspectRatio,
                      size: 'shipment-figure',
                      unavailableMessage: 'Shipment image unavailable',
                    },
                  );
                }}
                onKeyDown={(evt) => {
                  if (evt.key !== 'Enter' && evt.key !== ' ') return;
                  evt.preventDefault();
                  const originRect = getInventoryRevealRect(evt.currentTarget);
                  const renderedPreviewImage = getRenderedImagePreview(evt.currentTarget, previewImage);
                  if (canViewClearCardModel) {
                    openClearCardModelViewer({
                      overlayId: previewId,
                      dropId: order.dropId,
                      name: label,
                      image: renderedPreviewImage.src,
                      figureId: item.refId,
                      viewerMode: 'clear-card',
                      originRect,
                    });
                    return;
                  }
                  if (canViewInteractiveCard) {
                    openInteractiveCardViewer({
                      overlayId: previewId,
                      dropId: order.dropId,
                      name: label,
                      image: renderedPreviewImage.src,
                      figureId: item.refId,
                      originRect,
                    });
                    return;
                  }
                  openImageViewer(
                    { id: previewId, dropId: order.dropId, name: label, image: renderedPreviewImage.src },
                    originRect,
                    {
                      aspectRatio: renderedPreviewImage.aspectRatio,
                      size: 'shipment-figure',
                      unavailableMessage: 'Shipment image unavailable',
                    },
                  );
                }}
              >
                <FigureTileImage
                  dropId={order.dropId}
                  figureId={item.refId}
                  primarySrc={primarySrc}
                  fallbackSrc={fallbackSrc}
                  alt={label}
                  onMetadataResolved={mergeLoadedFigureMetadata}
                />
              </div>
            );
          })}
        </div>
      );
    },
    [
      figureMetadataByKey,
      getDropContent,
      mergeLoadedFigureMetadata,
      openClearCardModelViewer,
      openImageViewer,
      openInteractiveCardViewer,
      usesClearCard3dRevealForDropId,
      usesInteractiveCardPackRevealForDropId,
    ],
  );
  return (<section className="app-section shipments-section">
    <div className="app-section__head">
      <div className="app-section__title">Shipments</div>
    </div>
    {shipmentsSectionReady ? (
      deliveryOrders.length ? (
        <>
          {shipmentsRetainedError ? (
            <div className="muted small" role="status">
              {shipmentsRetainedError}
            </div>
          ) : null}
          <div className="delivery-list">
            {deliveryOrders.map((order) => {
              const trackingCode = shouldShowDeliveryTrackingCode(order)
                ? normalizeOptionalFulfillmentTrackingCode(order.fulfillmentTrackingCode)
                : '';
              const trackingHref = resolveFulfillmentTrackingHref(trackingCode);
              return (
                <div key={`${order.dropId}:${order.deliveryId}`} className="delivery-row">
                  <div className="delivery-row__head">
                    <div>
                      <div className="delivery-row__title">
                        {dropById.get(order.dropId)?.displayName || dropById.get(order.dropId)?.collectionName || order.dropId}
                      </div>
                      <div className="muted small">{formatOrderDate(order)}</div>
                    </div>
                    <div className="delivery-status">
                      <div>{displayOrderStatus(order)}</div>
                      {trackingCode ? (
                        trackingHref ? (
                          <a className="tracking-link small" href={trackingHref} target="_blank" rel="noopener noreferrer">
                            Tracking
                          </a>
                        ) : (
                          <div className="tracking-code-readout mono small">{trackingCode}</div>
                        )
                      ) : null}
                    </div>
                  </div>
                  {order.items.length ? (
                    renderShipmentItems(order)
                  ) : (
                    <div className="muted small">Items unavailable.</div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <div
          className={`muted small${shipmentsEmptyStateVisibility === 'hidden' ? ' empty-state--hidden' : ''}`}
          aria-hidden={shipmentsEmptyStateVisibility === 'hidden'}
        >
          {shipmentsEmptyContent}
        </div>
      )
    ) : (
      <div className="muted small empty-state--hidden" aria-hidden="true">
        {shipmentsEmptyContent}
      </div>
    )}
  </section>);
}
