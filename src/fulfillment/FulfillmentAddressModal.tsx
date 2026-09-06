import { useLayoutEffect, useRef, useState } from 'react';
import { updateFulfillmentAddress } from '../api/fulfillment';
import { Modal } from '../components/Modal';
import { isRedeemedForIrlFulfillmentOrder } from '../lib/fulfillmentOrderVisibility';
import type { FulfillmentOrder } from '../types';
import { fulfillmentOrderKey } from './orders';

type FulfillmentAddressModalProps = {
  order: FulfillmentOrder | null;
  canManage: boolean;
  suspended: boolean;
  isCurrentScope: () => boolean;
  onClose: () => void;
  onOrderUpdated: (key: string, update: (order: FulfillmentOrder) => FulfillmentOrder) => void;
  api?: { updateFulfillmentAddress: typeof updateFulfillmentAddress };
};

const defaultApi = { updateFulfillmentAddress };

export function FulfillmentAddressModal({
  order,
  canManage,
  suspended,
  isCurrentScope,
  onClose,
  onOrderUpdated,
  api = defaultApi,
}: FulfillmentAddressModalProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef(0);
  const pendingRef = useRef<object | null>(null);
  const mountedRef = useRef(false);
  const orderKey = order ? fulfillmentOrderKey(order) : '';
  const currentAddress = typeof order?.address.full === 'string' && order.address.full !== '***' ? order.address.full : '';
  const address = draft ?? currentAddress;
  const dirty = address.trim() !== currentAddress.trim();
  const canEdit = canManage && Boolean(order && !isRedeemedForIrlFulfillmentOrder(order));

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useLayoutEffect(() => {
    sessionRef.current += 1;
    pendingRef.current = null;
    setDraft(null);
    setSaving(false);
    setError(null);
    return () => { sessionRef.current += 1; };
  }, [orderKey]);

  const close = () => {
    if (pendingRef.current) return;
    sessionRef.current += 1;
    setDraft(null);
    setError(null);
    onClose();
  };

  const save = async () => {
    if (!order || !canEdit || !isCurrentScope() || pendingRef.current) return;
    const full = address.trim();
    if (!full) {
      setError('Enter a delivery address.');
      return;
    }
    if (!dirty) {
      close();
      return;
    }
    const key = orderKey;
    const session = sessionRef.current;
    const pending = {};
    const requestIsCurrent = () => mountedRef.current && isCurrentScope();
    const sessionIsCurrent = () => requestIsCurrent() && sessionRef.current === session && pendingRef.current === pending;
    pendingRef.current = pending;
    setSaving(true);
    setError(null);
    try {
      const response = await api.updateFulfillmentAddress(order.deliveryId, full, order.dropId);
      if (!requestIsCurrent()) return;
      onOrderUpdated(key, (current) => ({ ...current, address: { ...current.address, ...response.address } }));
      if (sessionIsCurrent()) {
        setDraft(null);
        onClose();
      }
    } catch (error) {
      if (!sessionIsCurrent()) return;
      console.error(error);
      setError(error instanceof Error ? error.message : 'Failed to update delivery address');
    } finally {
      if (sessionIsCurrent()) {
        pendingRef.current = null;
        setSaving(false);
      }
    }
  };

  return (
    <Modal
      open={order !== null}
      title={order ? `Edit address · Order ${order.deliveryId}` : 'Edit address'}
      onClose={close}
      showCloseButton={false}
      closeOnEscape={!saving}
      suspended={suspended}
    >
      <form className="modal-form fulfillment-address-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label>
          <span className="muted">Delivery address</span>
          <textarea
            value={address}
            onChange={(event) => setDraft(event.target.value)}
            rows={8}
            maxLength={2048}
            required
            disabled={saving}
            autoComplete="street-address"
            aria-label="Delivery address"
          />
        </label>
        <div className="muted small">This changes the address for this order only.</div>
        {error ? <div className="error">{error}</div> : null}
        <div className="row row--end">
          <button type="button" className="secondary-light" onClick={close} disabled={saving}>Cancel</button>
          <button type="submit" disabled={!canEdit || saving || !dirty || !address.trim()}>
            {saving ? 'Saving…' : 'Save address'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
