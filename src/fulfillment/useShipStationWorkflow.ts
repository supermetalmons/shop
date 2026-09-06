import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef } from 'react';
import {
  addFulfillmentOrderToShipStation,
  fulfillmentShipStationAddressCorrectionDetails,
  getFulfillmentShipStationLabel,
  getFulfillmentShipStationRates,
  purchaseFulfillmentShipStationLabel,
  voidFulfillmentShipStationLabel,
} from '../api/fulfillment';
import type { FulfillmentOrder, ShipStationEditableAddressField, ShipStationPackageInput } from '../types';
import {
  fulfillmentShipStationAddressCanRetry,
  fulfillmentShipStationAddressCorrectionFailure,
  fulfillmentShipStationAddressDraft,
  fulfillmentShipStationAddressOtherFailure,
  fulfillmentShipStationAddressPatch,
} from '../lib/fulfillmentShipStationAddress';
import { groupFulfillmentShipStationRates, prepareFulfillmentShipStationRates } from '../lib/fulfillmentShipStationRates';
import { normalizeFulfillmentStatus } from '../lib/fulfillmentStatus';
import { normalizeShipStationPackage, SHIPSTATION_PACKAGE_RANGE_MESSAGE } from '../../shared/shipstationPackage.js';
import { fulfillmentOrderKey } from './orders';
import {
  createShipStationWorkflowState,
  defaultShipStationPackageDraft,
  downloadShipStationLabel,
  isActiveShipStationLabel,
  parseShipStationPackageDraft,
  SHIPSTATION_PACKAGE_FIELDS,
  shipStationLabelOrderUpdate,
  shipStationPackageDraft,
  shipStationWorkflowReducer,
  type ShipStationPackageDraft,
} from './shipStationWorkflow';

const defaultShipStationApi = {
  addFulfillmentOrderToShipStation,
  getFulfillmentShipStationLabel,
  getFulfillmentShipStationRates,
  purchaseFulfillmentShipStationLabel,
  voidFulfillmentShipStationLabel,
};

export type ShipStationWorkflowOptions = {
  order: FulfillmentOrder | null;
  canManage: boolean;
  onClose: () => void;
  onOrderUpdated: (
    key: string,
    update: (current: FulfillmentOrder) => FulfillmentOrder,
  ) => void;
  isCurrentScope: () => boolean;
};

export function useShipStationWorkflow(
  { order: activeShipstationOrder, canManage, onClose, onOrderUpdated, isCurrentScope }: ShipStationWorkflowOptions,
  api = defaultShipStationApi,
) {
  const [state, dispatch] = useReducer(shipStationWorkflowReducer, undefined, createShipStationWorkflowState);
  const generationRef = useRef(0);
  const operationPendingRef = useRef(false);
  const activeShipstationOrderKeyResolved = activeShipstationOrder ? fulfillmentOrderKey(activeShipstationOrder) : '';

  useLayoutEffect(() => {
    generationRef.current += 1;
    operationPendingRef.current = false;
    dispatch({ type: 'reset' });
    return () => {
      generationRef.current += 1;
      operationPendingRef.current = false;
    };
  }, [activeShipstationOrderKeyResolved]);

  const beginOperation = useCallback(() => {
    if (operationPendingRef.current || !isCurrentScope()) return null;
    operationPendingRef.current = true;
    const generation = generationRef.current;
    return () => generationRef.current === generation && isCurrentScope();
  }, [isCurrentScope]);

  const finishOperation = useCallback((isCurrent: () => boolean) => {
    if (!isCurrent()) return;
    operationPendingRef.current = false;
    dispatch({ type: 'finished' });
  }, []);

  const activeShipstationAddressBaseline = useMemo(
    () => activeShipstationOrder ? fulfillmentShipStationAddressDraft(activeShipstationOrder.address) : null,
    [activeShipstationOrder],
  );
  const activeShipstationPackageDraft = activeShipstationOrder
    ? state.packageEdits[activeShipstationOrderKeyResolved] ??
      (activeShipstationOrder.shipstationPackage
        ? shipStationPackageDraft(activeShipstationOrder.shipstationPackage)
        : defaultShipStationPackageDraft(activeShipstationOrder))
    : { length: '', width: '', height: '', weight: '' };
  const activeShipstationLabel = activeShipstationOrder?.shipstationLabel;
  const activeShipstationHasLabel = isActiveShipStationLabel(activeShipstationLabel);
  const activeShipstationPackageKnown = Boolean(
    activeShipstationOrder &&
      (!activeShipstationOrder.shipstationShipmentId ||
        activeShipstationOrder.shipstationPackage ||
        state.packageEdits[activeShipstationOrderKeyResolved]),
  );
  const activeShipstationMultiPackage = Boolean(
    activeShipstationOrder?.shipstationShipmentId &&
      activeShipstationOrder.shipstationPackageCount != null &&
      activeShipstationOrder.shipstationPackageCount !== 1,
  );
  const activeShipstationPurchaseUnknown = Boolean(state.purchaseUnknown || activeShipstationOrder?.shipstationPurchaseUnknown);
  const activeShipstationBusy = state.operation !== 'idle';
  const activeShipstationSelectedRate = state.rates.find((rate) => rate.rateId === state.selectedRateId) ?? null;
  const activeShipstationPreparedRates = useMemo(() => prepareFulfillmentShipStationRates(state.rates), [state.rates]);
  const activeShipstationRateGroups = useMemo(
    () => groupFulfillmentShipStationRates(activeShipstationPreparedRates.rates, state.selectedRateId),
    [activeShipstationPreparedRates.rates, state.selectedRateId],
  );
  const activeShipstationSelectedRateDetail = activeShipstationSelectedRate
    ? activeShipstationPreparedRates.detailByRateId.get(activeShipstationSelectedRate.rateId)
    : undefined;
  const visibleShipstationInvalidRates = state.rates.length
    ? state.invalidRates.filter((rate) => rate.responseIssue)
    : state.invalidRates;
  const activeShipstationCanAdd = Boolean(
    activeShipstationOrder &&
      !activeShipstationOrder.shipstationShipmentId &&
      normalizeFulfillmentStatus(activeShipstationOrder.fulfillmentStatus) !== 'Shipped',
  );
  const activeShipstationAddressPatch = state.addressCorrection
    ? fulfillmentShipStationAddressPatch(state.addressCorrection)
    : {};
  const activeShipstationAddressCorrectionValid = Boolean(
    state.addressCorrection && fulfillmentShipStationAddressCanRetry(state.addressCorrection),
  );
  const activeShipstationCanGetRates = Boolean(
    activeShipstationOrder?.shipstationShipmentId && !activeShipstationHasLabel &&
      !activeShipstationMultiPackage && !activeShipstationPurchaseUnknown,
  );

  const handleCloseShipstationModal = () => {
    if (operationPendingRef.current) return;
    dispatch({ type: 'reset' });
    onClose();
  };

  const handleAddToShipStation = async () => {
    if (
      !activeShipstationOrder || !canManage || operationPendingRef.current ||
      (Boolean(state.addressCorrection?.visibleFields.length) && !activeShipstationAddressCorrectionValid)
    ) return;
    const key = fulfillmentOrderKey(activeShipstationOrder);
    const addressPatch = state.addressCorrection && Object.keys(activeShipstationAddressPatch).length > 0
      ? activeShipstationAddressPatch
      : undefined;
    const draft = state.packageEdits[key] ?? defaultShipStationPackageDraft(activeShipstationOrder);
    const parcel = normalizeShipStationPackage(parseShipStationPackageDraft(draft));
    if (!parcel) {
      dispatch({ type: 'failed', message: SHIPSTATION_PACKAGE_RANGE_MESSAGE });
      return;
    }
    const isCurrent = beginOperation();
    if (!isCurrent) return;
    dispatch({ type: 'started', operation: 'adding' });
    try {
      const response = await api.addFulfillmentOrderToShipStation(
        activeShipstationOrder.deliveryId, activeShipstationOrder.dropId, parcel, addressPatch,
      );
      if (!isCurrent()) return;
      onOrderUpdated(key, (order) => ({
        ...order,
        shipstationShipmentId: response.shipmentId,
        shipstationAddedAt: response.shipstationAddedAt ?? order.shipstationAddedAt ?? Date.now(),
        ...(!response.alreadyAdded ? { shipstationPackage: parcel, shipstationPackageCount: 1 } : {}),
      }));
      dispatch({
        type: 'add-completed', key,
        warning: response.alreadyAdded
          ? `This order was already in ShipStation, so these measurements${addressPatch ? ' and address corrections' : ''} were not applied.`
          : null,
      });
    } catch (err) {
      if (!isCurrent()) return;
      console.error(err);
      const correction = fulfillmentShipStationAddressCorrectionDetails(err);
      dispatch({
        type: 'add-failed',
        message: err instanceof Error ? err.message : 'Failed to add the order to ShipStation',
        correction: correction
          ? fulfillmentShipStationAddressCorrectionFailure(
              state.addressCorrection, activeShipstationAddressBaseline, correction.fields, addressPatch ?? {},
            )
          : fulfillmentShipStationAddressOtherFailure(state.addressCorrection, addressPatch ?? {}),
      });
    } finally {
      finishOperation(isCurrent);
    }
  };

  const handleGetShipstationRates = async () => {
    if (!activeShipstationOrder || !canManage || !activeShipstationCanGetRates || operationPendingRef.current) return;
    const key = fulfillmentOrderKey(activeShipstationOrder);
    const packageDraft = state.packageEdits[key];
    const draftPackage = packageDraft ? parseShipStationPackageDraft(packageDraft) : undefined;
    const canonicalPackage = activeShipstationOrder.shipstationPackage;
    const draftMatchesCanonical = Boolean(
      draftPackage && canonicalPackage &&
      SHIPSTATION_PACKAGE_FIELDS.every(({ key: field }) => draftPackage[field] === canonicalPackage[field]),
    );
    let parcel: ShipStationPackageInput | undefined;
    if (draftPackage && !draftMatchesCanonical) {
      parcel = normalizeShipStationPackage(draftPackage) ?? undefined;
      if (!parcel) {
        dispatch({ type: 'failed', message: SHIPSTATION_PACKAGE_RANGE_MESSAGE });
        return;
      }
    }
    const isCurrent = beginOperation();
    if (!isCurrent) return;
    dispatch({ type: 'started', operation: 'rates' });
    try {
      const response = await api.getFulfillmentShipStationRates(
        activeShipstationOrder.deliveryId, activeShipstationOrder.dropId, parcel,
      );
      if (!isCurrent()) return;
      onOrderUpdated(key, (order) => ({
        ...order,
        ...(response.package ? { shipstationPackage: response.package } : {}),
        shipstationPackageCount: response.packageCount,
        ...shipStationLabelOrderUpdate(order, response.label),
        shipstationPurchaseUnknown: Boolean(response.purchaseUnknown),
      }));
      dispatch({ type: 'rates-received', key, response });
    } catch (err) {
      if (!isCurrent()) return;
      console.error(err);
      dispatch({ type: 'failed', message: err instanceof Error ? err.message : 'Failed to get ShipStation rates' });
    } finally {
      finishOperation(isCurrent);
    }
  };

  const handleReviewShipstationPurchase = () => {
    if (!activeShipstationSelectedRate || operationPendingRef.current) return;
    dispatch({ type: 'purchase-reviewed', requestId: globalThis.crypto.randomUUID() });
  };

  const handleConfirmShipstationPurchase = async () => {
    if (!activeShipstationOrder || !activeShipstationSelectedRate || !canManage) return;
    const isCurrent = beginOperation();
    if (!isCurrent) return;
    const key = fulfillmentOrderKey(activeShipstationOrder);
    const requestId = state.purchaseRequestId || globalThis.crypto.randomUUID();
    dispatch({ type: 'purchase-started', requestId });
    try {
      const response = await api.purchaseFulfillmentShipStationLabel({
        dropId: activeShipstationOrder.dropId,
        deliveryId: activeShipstationOrder.deliveryId,
        rateId: activeShipstationSelectedRate.rateId,
        expectedTotal: activeShipstationSelectedRate.totalAmount,
        requestId,
      });
      if (!isCurrent()) return;
      onOrderUpdated(key, (order) => ({
        ...order, ...shipStationLabelOrderUpdate(order, response.label), shipstationPurchaseUnknown: false,
      }));
      dispatch({ type: 'purchase-completed', labelDownloadUrl: response.labelDownloadUrl || null });
    } catch (err) {
      if (!isCurrent()) return;
      console.error(err);
      const message = err instanceof Error ? err.message : 'Failed to purchase the ShipStation label';
      const reason = /check purchase status|may already|did not confirm/i.test(message)
        ? 'unknown'
        : /rate.*changed|refresh rates|no longer valid/i.test(message) ? 'expired' : 'other';
      dispatch({ type: 'purchase-failed', message, reason });
      if (reason === 'unknown') {
        onOrderUpdated(key, (order) => ({ ...order, shipstationPurchaseUnknown: true }));
      }
    } finally {
      finishOperation(isCurrent);
    }
  };

  const handleConfirmShipstationVoid = async () => {
    if (!activeShipstationOrder || activeShipstationLabel?.status !== 'completed' || !canManage) return;
    const isCurrent = beginOperation();
    if (!isCurrent) return;
    const key = fulfillmentOrderKey(activeShipstationOrder);
    const labelId = activeShipstationLabel.labelId;
    dispatch({ type: 'started', operation: 'voiding' });
    try {
      const response = await api.voidFulfillmentShipStationLabel({
        dropId: activeShipstationOrder.dropId, deliveryId: activeShipstationOrder.deliveryId, labelId,
      });
      if (!isCurrent()) return;
      if (response.label.labelId !== labelId) {
        throw new Error('ShipStation returned a different label. Check its status again.');
      }
      onOrderUpdated(key, (order) => ({
        ...order, ...shipStationLabelOrderUpdate(order, response.label), shipstationPurchaseUnknown: false,
      }));
      dispatch({ type: 'void-completed' });
    } catch (err) {
      if (!isCurrent()) return;
      console.error(err);
      dispatch({ type: 'failed', message: err instanceof Error ? err.message : 'Failed to void the ShipStation label' });
    } finally {
      finishOperation(isCurrent);
    }
  };

  const refreshShipstationLabel = useCallback(async (downloadAfterRefresh: boolean) => {
    if (!activeShipstationOrder?.shipstationShipmentId || !canManage) return;
    const isCurrent = beginOperation();
    if (!isCurrent) return;
    const key = fulfillmentOrderKey(activeShipstationOrder);
    dispatch({ type: 'started', operation: 'label' });
    try {
      const response = await api.getFulfillmentShipStationLabel(
        activeShipstationOrder.deliveryId, activeShipstationOrder.dropId,
      );
      if (!isCurrent()) return;
      onOrderUpdated(key, (order) => ({
        ...order,
        ...shipStationLabelOrderUpdate(order, response.label),
        shipstationPurchaseUnknown: Boolean(response.purchaseUnknown),
      }));
      dispatch({
        type: 'label-received', purchaseUnknown: Boolean(response.purchaseUnknown),
        labelDownloadUrl: response.labelDownloadUrl || null,
      });
      if (downloadAfterRefresh && response.labelDownloadUrl) {
        downloadShipStationLabel(response.labelDownloadUrl);
      } else if (downloadAfterRefresh && !response.labelDownloadUrl) {
        dispatch({ type: 'failed', message: 'The ShipStation label PDF is not ready yet.' });
      }
    } catch (err) {
      if (!isCurrent()) return;
      console.error(err);
      dispatch({ type: 'failed', message: err instanceof Error ? err.message : 'Failed to check the ShipStation label' });
    } finally {
      finishOperation(isCurrent);
    }
  }, [activeShipstationOrder, api, beginOperation, canManage, finishOperation, onOrderUpdated]);

  useEffect(() => {
    if (!activeShipstationOrderKeyResolved || activeShipstationLabel?.status !== 'processing' || activeShipstationBusy) return;
    const interval = window.setInterval(() => { void refreshShipstationLabel(false); }, 2500);
    return () => window.clearInterval(interval);
  }, [activeShipstationBusy, activeShipstationLabel?.status, activeShipstationOrderKeyResolved, refreshShipstationLabel]);

  const editPackage = (field: keyof ShipStationPackageDraft, value: string) => {
    if (!activeShipstationOrder || operationPendingRef.current) return;
    dispatch({ type: 'package-edited', key: activeShipstationOrderKeyResolved, draft: activeShipstationPackageDraft, field, value });
  };
  const editAddress = (field: ShipStationEditableAddressField, value: string) => {
    if (operationPendingRef.current) return;
    dispatch({ type: 'address-edited', field, value });
  };
  const downloadLabel = () => {
    if (operationPendingRef.current || !isCurrentScope()) return;
    if (state.labelDownloadUrl) downloadShipStationLabel(state.labelDownloadUrl);
    else void refreshShipstationLabel(true);
  };

  return {
    activeShipstationOrder,
    activeShipstationOrderKeyResolved,
    activeShipstationPackageDraft,
    activeShipstationLabel,
    activeShipstationHasLabel,
    activeShipstationPackageKnown,
    activeShipstationMultiPackage,
    activeShipstationPurchaseUnknown,
    activeShipstationBusy,
    activeShipstationSelectedRate,
    activeShipstationPreparedRates,
    activeShipstationRateGroups,
    activeShipstationSelectedRateDetail,
    activeShipstationSelectedOtherRate: activeShipstationRateGroups.selectedOtherRate,
    visibleShipstationInvalidRates,
    activeShipstationCanAdd,
    activeShipstationAddressCorrectionValid,
    activeShipstationCanGetRates,
    shipstationSaving: state.operation === 'adding',
    shipstationRatesLoading: state.operation === 'rates',
    shipstationPurchasing: state.operation === 'purchasing',
    shipstationLabelLoading: state.operation === 'label',
    shipstationVoiding: state.operation === 'voiding',
    shipstationError: state.error,
    shipstationAddressCorrection: state.addressCorrection,
    shipstationRates: state.rates,
    shipstationRatesExpanded: state.ratesExpanded,
    shipstationSelectedRateId: state.selectedRateId,
    shipstationRatesRequested: state.ratesRequested,
    shipstationReviewingPurchase: state.review === 'purchase',
    shipstationReviewingVoid: state.review === 'void',
    shipstationPurchaseRequestId: state.purchaseRequestId,
    shipstationLabelDownloadUrl: state.labelDownloadUrl,
    shipstationPurchaseUnknown: state.purchaseUnknown,
    handleCloseShipstationModal,
    handleAddToShipStation,
    handleGetShipstationRates,
    handleSelectShipstationRate: (rateId: string) => dispatch({ type: 'rate-selected', rateId }),
    handleReviewShipstationPurchase,
    handleConfirmShipstationPurchase,
    handleConfirmShipstationVoid,
    refreshShipstationLabel,
    editPackage,
    toggleRatesExpanded: () => dispatch({ type: 'rates-toggled' }),
    editAddress,
    reviewVoid: () => dispatch({ type: 'void-reviewed' }),
    cancelVoidReview: () => dispatch({ type: 'void-cancelled' }),
    cancelPurchaseReview: () => dispatch({ type: 'purchase-cancelled' }),
    downloadLabel,
  };
}
