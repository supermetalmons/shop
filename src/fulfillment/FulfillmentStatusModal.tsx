import { useLayoutEffect, useRef, useState } from 'react';
import { updateFulfillmentStatus } from '../api/fulfillment';
import { Modal } from '../components/Modal';
import { FULFILLMENT_STATUS_OPTIONS, normalizeFulfillmentStatus } from '../lib/fulfillmentStatus';
import {
  normalizeOptionalFulfillmentTrackingCode,
  sanitizeFulfillmentTrackingCode,
} from '../../shared/fulfillmentTracking';
import type { FulfillmentOrder, FulfillmentStatus } from '../types';
import { fulfillmentOrderKey } from './orders';

type FulfillmentStatusModalProps = {
  order: FulfillmentOrder | null;
  canManage: boolean;
  suspended: boolean;
  isCurrentScope: () => boolean;
  onClose: () => void;
  onOrderUpdated: (key: string, update: (order: FulfillmentOrder) => FulfillmentOrder) => void;
  onError: (message: string | null) => void;
  api?: { updateFulfillmentStatus: typeof updateFulfillmentStatus };
};

type StatusDraft = { status: FulfillmentStatus | ''; trackingCode: string };
const defaultApi = { updateFulfillmentStatus };

export function FulfillmentStatusModal({
  order,
  canManage,
  suspended,
  isCurrentScope,
  onClose,
  onOrderUpdated,
  onError,
  api = defaultApi,
}: FulfillmentStatusModalProps) {
  const [draft, setDraft] = useState<StatusDraft | null>(null);
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const pendingKeysRef = useRef(new Set<string>());
  const sessionRef = useRef(0);
  const mountedRef = useRef(false);
  const orderKey = order ? fulfillmentOrderKey(order) : '';
  const currentStatus = normalizeFulfillmentStatus(order?.fulfillmentStatus);
  const currentTrackingCode = normalizeOptionalFulfillmentTrackingCode(order?.fulfillmentTrackingCode) || '';
  const status = draft?.status ?? currentStatus;
  const trackingCode = draft?.trackingCode ?? currentTrackingCode;
  const dirty = currentStatus !== status ||
    (status === 'Shipped' && currentTrackingCode !== sanitizeFulfillmentTrackingCode(trackingCode));
  const saving = pendingKeys.has(orderKey);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useLayoutEffect(() => {
    sessionRef.current += 1;
    setDraft(null);
    return () => { sessionRef.current += 1; };
  }, [orderKey]);

  const close = () => {
    sessionRef.current += 1;
    setDraft(null);
    onClose();
  };

  const save = async () => {
    if (!order || !canManage || !isCurrentScope() || pendingKeysRef.current.has(orderKey)) return;
    if (!dirty) {
      close();
      return;
    }
    const key = orderKey;
    const session = sessionRef.current;
    const requestIsCurrent = () => mountedRef.current && isCurrentScope();
    const sessionIsCurrent = () => requestIsCurrent() && sessionRef.current === session;
    const nextStatus = normalizeFulfillmentStatus(status);
    const nextTrackingCode = nextStatus === 'Shipped' ? sanitizeFulfillmentTrackingCode(trackingCode) : undefined;
    pendingKeysRef.current.add(key);
    setPendingKeys(new Set(pendingKeysRef.current));
    onError(null);
    try {
      const response = await api.updateFulfillmentStatus(order.deliveryId, nextStatus, order.dropId, nextTrackingCode);
      if (!requestIsCurrent()) return;
      const normalized = normalizeFulfillmentStatus(response.fulfillmentStatus || nextStatus);
      const responseTrackingCode = normalizeOptionalFulfillmentTrackingCode(response.fulfillmentTrackingCode);
      onOrderUpdated(key, (current) => ({
        ...current,
        fulfillmentStatus: normalized || undefined,
        fulfillmentTrackingCode: normalized === 'Shipped'
          ? responseTrackingCode
          : responseTrackingCode || normalizeOptionalFulfillmentTrackingCode(current.fulfillmentTrackingCode),
      }));
      if (sessionIsCurrent()) close();
    } catch (error) {
      if (!requestIsCurrent()) return;
      console.error(error);
      onError(error instanceof Error ? error.message : 'Failed to update status');
    } finally {
      if (requestIsCurrent()) {
        pendingKeysRef.current.delete(key);
        setPendingKeys(new Set(pendingKeysRef.current));
      }
    }
  };

  return (
    <Modal
      open={order !== null}
      title={order ? `Order ${order.deliveryId}` : 'Order'}
      onClose={close}
      showCloseButton={false}
      suspended={suspended}
    >
      <div className="modal-form">
        <select
          className="status-input"
          value={status}
          onChange={(event) => setDraft({ status: normalizeFulfillmentStatus(event.target.value), trackingCode })}
          aria-label="Fulfillment status"
        >
          <option value="">Not set</option>
          {FULFILLMENT_STATUS_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
        {status === 'Shipped' ? (
          <input
            className="tracking-input"
            value={trackingCode}
            onChange={(event) => setDraft({ status, trackingCode: event.target.value })}
            placeholder="Tracking link"
            aria-label="Tracking link"
            autoComplete="off"
          />
        ) : null}
        <div className="row row--end">
          <button type="button" className="secondary-light" onClick={close}>Cancel</button>
          <button type="button" onClick={() => void save()} disabled={!order || !canManage || saving || !dirty}>
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}
