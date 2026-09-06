import { useCallback, useMemo, useState } from 'react';
import type { FrontendDeploymentConfig } from '../config/deployment';
import type { FulfillmentOrder } from '../types';
import {
  loadFigureMetadataBatch,
  type FigureMetadataRecord,
  type FigureMetadataTarget,
} from '../lib/figureMetadata';
import {
  fulfillmentBoxSecretCode,
  fulfillmentCardClaimSecretCode,
  isUsedReceiptClaimStatus,
} from '../lib/fulfillmentCodes';
import {
  buildFulfillmentAddressExport,
  buildFulfillmentCardClaimSecretCodeExportEntry,
  buildFulfillmentExportFilename,
  buildFulfillmentOrdersExport,
  buildFulfillmentSecretCodeExportEntry,
  buildFulfillmentSecretCodeExportEntries,
  countFulfillmentSecretCodeExportEntries,
} from '../lib/fulfillmentExports';
import type { FulfillmentOrderVisibilityFilter } from '../lib/fulfillmentOrderVisibility';
import {
  buildSecretCodePngBlob,
  buildSecretCodesZipBlob,
  downloadBlobFile,
  downloadJsonFile,
} from './exportFiles';
import { collectFulfillmentFigureMetadataTargets, mergeFigureMetadataRecords } from './figureMetadata';
import { fulfillmentOrderKey } from './orders';

const defaultFulfillmentExportDependencies = {
  loadFigureMetadataBatch,
  buildSecretCodePngBlob,
  buildSecretCodesZipBlob,
  downloadBlobFile,
  downloadJsonFile,
};

type FulfillmentSecretCodeDownloadTarget =
  | { kind: 'box'; index: number }
  | { kind: 'card-claim'; index: number };

type FulfillmentExportsOptions = {
  displayedOrders: FulfillmentOrder[];
  selectedDropId: string;
  orderVisibilityFilter: FulfillmentOrderVisibilityFilter;
  dropById: ReadonlyMap<string, FrontendDeploymentConfig>;
  figureMetadataByKey: Record<string, FigureMetadataRecord>;
  fulfillmentFigureMetadataTargets: FigureMetadataTarget[];
  mergeLoadedFigureMetadata: (records: FigureMetadataRecord[]) => void;
  setOrdersError: (error: string | null) => void;
  onMenuClose: () => void;
};

export function useFulfillmentExports({
  displayedOrders,
  selectedDropId,
  orderVisibilityFilter,
  dropById,
  figureMetadataByKey,
  fulfillmentFigureMetadataTargets,
  mergeLoadedFigureMetadata,
  setOrdersError,
  onMenuClose,
}: FulfillmentExportsOptions, dependencies = defaultFulfillmentExportDependencies) {
  const [secretCodesExporting, setSecretCodesExporting] = useState(false);
  const [secretCodesExportProgress, setSecretCodesExportProgress] = useState(0);
  const [secretCodePngExportingKey, setSecretCodePngExportingKey] = useState<string | null>(null);
  const displayedSecretCodeCount = useMemo(
    () => countFulfillmentSecretCodeExportEntries(displayedOrders),
    [displayedOrders],
  );

  const downloadDisplayedOrders = useCallback(() => {
    const filename = buildFulfillmentExportFilename({
      kind: 'orders',
      selectedDropId,
      orderVisibilityFilter,
    });
    const payload = buildFulfillmentOrdersExport(displayedOrders, { dropById, figureMetadataByKey });
    dependencies.downloadJsonFile(filename, payload);
    onMenuClose();
  }, [dependencies, displayedOrders, dropById, figureMetadataByKey, onMenuClose, orderVisibilityFilter, selectedDropId]);

  const downloadDisplayedAddresses = useCallback(() => {
    const filename = buildFulfillmentExportFilename({
      kind: 'addresses-sensitive',
      selectedDropId,
      orderVisibilityFilter,
    });
    const payload = buildFulfillmentAddressExport(displayedOrders);
    dependencies.downloadJsonFile(filename, payload);
    onMenuClose();
  }, [dependencies, displayedOrders, onMenuClose, orderVisibilityFilter, selectedDropId]);

  const loadFulfillmentExportFigureMetadata = useCallback(async (targets = fulfillmentFigureMetadataTargets) => {
    let exportFigureMetadataByKey = figureMetadataByKey;
    if (targets.length) {
      const records = await dependencies.loadFigureMetadataBatch(targets);
      if (records.length) {
        mergeLoadedFigureMetadata(records);
        exportFigureMetadataByKey = mergeFigureMetadataRecords(exportFigureMetadataByKey, records);
      }
    }
    return exportFigureMetadataByKey;
  }, [dependencies, figureMetadataByKey, fulfillmentFigureMetadataTargets, mergeLoadedFigureMetadata]);

  const downloadSecretCodePng = useCallback(
    async (order: FulfillmentOrder, target: FulfillmentSecretCodeDownloadTarget) => {
      if (secretCodesExporting || secretCodePngExportingKey) return;

      let figureIds: number[];
      if (target.kind === 'box') {
        const box = order.boxes[target.index];
        if (!box || !fulfillmentBoxSecretCode(box)) return;
        figureIds = box.dudeIds;
      } else {
        const claim = order.cardClaims?.[target.index];
        const secretCode = claim ? fulfillmentCardClaimSecretCode(claim) : '';
        if (!claim || !secretCode || isUsedReceiptClaimStatus(claim.receiptClaimStatus)) return;
        figureIds = [claim.figureId];
      }

      const exportKey = `${fulfillmentOrderKey(order)}:${
        target.kind === 'box' ? target.index : `card:${target.index}`
      }`;
      setSecretCodePngExportingKey(exportKey);
      setOrdersError(null);
      try {
        const orderDrop = dropById.get(order.dropId);
        const exportFigureMetadataByKey = await loadFulfillmentExportFigureMetadata(
          orderDrop
            ? collectFulfillmentFigureMetadataTargets({
                entries: [{ drop: orderDrop, figureIds }],
                figureMetadataByKey,
              })
            : [],
        );
        const options = { dropById, figureMetadataByKey: exportFigureMetadataByKey };
        const entry =
          target.kind === 'box'
            ? buildFulfillmentSecretCodeExportEntry({ order, boxIndex: target.index, options })
            : buildFulfillmentCardClaimSecretCodeExportEntry({
                order,
                cardClaimIndex: target.index,
                options,
              });
        if (!entry) throw new Error('Secret code unavailable');

        const pngBlob = await dependencies.buildSecretCodePngBlob(entry);
        dependencies.downloadBlobFile(entry.filename, pngBlob);
      } catch (err) {
        const fallbackMessage =
          target.kind === 'card-claim'
            ? 'Failed to export fulfillment card secret code PNG'
            : 'Failed to export fulfillment secret code PNG';
        console.error(
          target.kind === 'card-claim'
            ? '[mons] failed to export fulfillment card secret code PNG'
            : '[mons] failed to export fulfillment secret code PNG',
          err,
        );
        setOrdersError(err instanceof Error ? err.message : fallbackMessage);
      } finally {
        setSecretCodePngExportingKey((current) => (current === exportKey ? null : current));
      }
    },
    [dependencies, dropById, figureMetadataByKey, loadFulfillmentExportFigureMetadata, secretCodePngExportingKey, secretCodesExporting, setOrdersError],
  );

  const downloadDisplayedSecretCodes = useCallback(async () => {
    onMenuClose();
    if (secretCodesExporting || secretCodePngExportingKey || !displayedSecretCodeCount) return;

    setSecretCodesExporting(true);
    setSecretCodesExportProgress(0);
    setOrdersError(null);
    try {
      const filename = buildFulfillmentExportFilename({
        kind: 'secret-codes',
        selectedDropId,
        orderVisibilityFilter,
      });
      const exportFigureMetadataByKey = await loadFulfillmentExportFigureMetadata();
      const exportEntries = buildFulfillmentSecretCodeExportEntries(displayedOrders, {
        dropById,
        figureMetadataByKey: exportFigureMetadataByKey,
      });
      const zipBlob = await dependencies.buildSecretCodesZipBlob(exportEntries, setSecretCodesExportProgress);
      setSecretCodesExportProgress(100);
      dependencies.downloadBlobFile(filename, zipBlob);
    } catch (err) {
      console.error('[mons] failed to export fulfillment secret code PNGs', err);
      setOrdersError(err instanceof Error ? err.message : 'Failed to export fulfillment secret code PNGs');
    } finally {
      setSecretCodesExporting(false);
      setSecretCodesExportProgress(0);
    }
  }, [
    dependencies,
    displayedSecretCodeCount,
    displayedOrders,
    dropById,
    loadFulfillmentExportFigureMetadata,
    onMenuClose,
    orderVisibilityFilter,
    secretCodePngExportingKey,
    secretCodesExporting,
    selectedDropId,
    setOrdersError,
  ]);

  const secretCodesExportPercent = Math.max(0, Math.min(100, Math.round(secretCodesExportProgress)));
  const secretCodeDownloadDisabled = secretCodesExporting || Boolean(secretCodePngExportingKey);

  return {
    displayedSecretCodeCount,
    secretCodesExporting,
    secretCodesExportPercent,
    secretCodeDownloadDisabled,
    downloadDisplayedOrders,
    downloadDisplayedAddresses,
    downloadDisplayedSecretCodes,
    downloadSecretCodePng,
  };
}
