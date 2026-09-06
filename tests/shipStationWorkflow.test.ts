import assert from 'node:assert/strict';
import test, { afterEach, mock } from 'node:test';
import { JSDOM } from 'jsdom';
import { useCallback, useState } from 'react';
import { fulfillmentOrderKey } from '../src/fulfillment/orders.ts';
import type {
  FulfillmentOrder,
  FulfillmentShipStationRate,
  GetFulfillmentShipStationLabelResponse,
  GetFulfillmentShipStationRatesResponse,
} from '../src/types.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://mons.shop/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'MutationObserver'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });

const { act, cleanup, renderHook } = await import('@testing-library/react');
const { useShipStationWorkflow } = await import('../src/fulfillment/useShipStationWorkflow.ts');
const { ProfileApiError } = await import('../src/api/transport.ts');

type Options = Parameters<typeof useShipStationWorkflow>[0];
type Api = NonNullable<Parameters<typeof useShipStationWorkflow>[1]>;
type OrderUpdated = Options['onOrderUpdated'];

afterEach(() => {
  cleanup();
  mock.restoreAll();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function order(overrides: Partial<FulfillmentOrder> = {}): FulfillmentOrder {
  return {
    dropId: 'little_swag_boxes',
    deliveryId: 1,
    owner: 'owner-1',
    status: 'processed',
    address: { countryCode: 'US', full: 'Recipient\n1 Main Street\nPortland, OR 97201\nUnited States' },
    boxes: [{ boxId: 1, dudeIds: [1] }],
    looseDudes: [],
    shipstationShipmentId: 'shipment-1',
    shipstationPackage: { length: 10, width: 8, height: 6, weight: 20 },
    shipstationPackageCount: 1,
    ...overrides,
  };
}

function label(status: NonNullable<FulfillmentOrder['shipstationLabel']>['status'] = 'completed') {
  return { labelId: 'label-1', shipmentId: 'shipment-1', status, trackingNumber: 'TRACK-1' };
}

function rate(): FulfillmentShipStationRate {
  const zero = { currency: 'usd', amount: 0 };
  return {
    rateId: 'rate-1',
    shipmentId: 'shipment-1',
    carrierId: 'carrier-1',
    carrierCode: 'stamps_com',
    carrierName: 'USPS',
    serviceCode: 'usps_ground_advantage',
    serviceName: 'USPS Ground Advantage',
    shippingAmount: { currency: 'usd', amount: 6.25 },
    insuranceAmount: zero,
    confirmationAmount: zero,
    otherAmount: zero,
    totalAmount: { currency: 'usd', amount: 6.25 },
    guaranteedService: false,
    warningMessages: [],
  };
}

function ratesResponse(overrides: Partial<GetFulfillmentShipStationRatesResponse> = {}): GetFulfillmentShipStationRatesResponse {
  return {
    deliveryId: 1,
    shipmentId: 'shipment-1',
    packageCount: 1,
    rates: [rate()],
    invalidRates: [],
    ...overrides,
  };
}

function labelResponse(overrides: Partial<GetFulfillmentShipStationLabelResponse> = {}): GetFulfillmentShipStationLabelResponse {
  return {
    deliveryId: 1,
    shipmentId: 'shipment-1',
    label: label(),
    labelDownloadUrl: 'https://labels.example/label-1.pdf',
    purchaseUnknown: false,
    ...overrides,
  };
}

function mount(initialOrders: FulfillmentOrder[] = [order()], overrides: Partial<Api> = {}) {
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected ShipStation API call'); };
  const api: Api = {
    addFulfillmentOrderToShipStation: unexpected,
    getFulfillmentShipStationRates: unexpected,
    purchaseFulfillmentShipStationLabel: unexpected,
    voidFulfillmentShipStationLabel: unexpected,
    getFulfillmentShipStationLabel: unexpected,
    ...overrides,
  };
  const updates: Array<{ key: string; tracking: string | null | undefined }> = [];
  let scopeCurrent = true;
  const view = renderHook(({ canManage }: { canManage: boolean }) => {
    const [orders, setOrders] = useState(() => Object.fromEntries(initialOrders.map((item) => [fulfillmentOrderKey(item), item])));
    const [selectedKey, setSelectedKey] = useState<string | null>(fulfillmentOrderKey(initialOrders[0]));
    const onOrderUpdated = useCallback<OrderUpdated>((key, update, tracking) => {
      updates.push({ key, tracking });
      setOrders((current) => ({ ...current, [key]: update(current[key]) }));
    }, []);
    const onClose = useCallback(() => setSelectedKey(null), []);
    const isCurrentScope = useCallback(() => scopeCurrent, []);
    const workflow = useShipStationWorkflow({
      order: selectedKey ? orders[selectedKey] : null,
      canManage,
      onOrderUpdated,
      onClose,
      isCurrentScope,
    }, api);
    return { workflow, orders, selectedKey, openOrder: setSelectedKey };
  }, { initialProps: { canManage: true } });
  return { ...view, api, updates, invalidateScope: () => { scopeCurrent = false; } };
}

test('package drafts remain isolated by order across closing and reopening, while quotes reset', async () => {
  const first = order();
  const second = order({ dropId: 'another-drop' });
  const view = mount([first, second], { getFulfillmentShipStationRates: async () => ratesResponse() });
  const firstKey = fulfillmentOrderKey(first);
  const secondKey = fulfillmentOrderKey(second);

  act(() => view.result.current.workflow.editPackage('length', '12'));
  await act(async () => { await view.result.current.workflow.handleGetShipstationRates(); });
  assert.equal(view.result.current.workflow.shipstationRates.length, 1);
  act(() => view.result.current.workflow.handleCloseShipstationModal());
  assert.equal(view.result.current.selectedKey, null);

  act(() => view.result.current.openOrder(secondKey));
  assert.equal(view.result.current.workflow.activeShipstationPackageDraft.length, '10');
  act(() => view.result.current.workflow.editPackage('length', '7'));
  act(() => view.result.current.openOrder(firstKey));
  assert.equal(view.result.current.workflow.activeShipstationPackageDraft.length, '12');
  assert.deepEqual(view.result.current.workflow.shipstationRates, []);
  assert.equal(view.result.current.workflow.shipstationSelectedRateId, null);
  assert.equal(view.result.current.workflow.shipstationReviewingPurchase, false);
  act(() => view.result.current.openOrder(secondKey));
  assert.equal(view.result.current.workflow.activeShipstationPackageDraft.length, '7');
});

test('rate requests omit unchanged package values and apply the accepted server package', async (t) => {
  const acceptedPackage = { length: 12, width: 8, height: 6, weight: 20 };
  const getRates = t.mock.fn(async () => ratesResponse({ package: acceptedPackage }));
  const initial = order();
  const view = mount([initial], { getFulfillmentShipStationRates: getRates });
  act(() => view.result.current.workflow.editPackage('length', '10,0'));
  await act(async () => { await view.result.current.workflow.handleGetShipstationRates(); });

  assert.deepEqual(getRates.mock.calls[0].arguments, [1, initial.dropId, undefined]);
  assert.equal(view.result.current.workflow.activeShipstationPackageDraft.length, '12');
  assert.deepEqual(view.result.current.orders[fulfillmentOrderKey(initial)].shipstationPackage, acceptedPackage);
  act(() => view.result.current.workflow.editPackage('weight', '25,5'));
  assert.deepEqual(view.result.current.workflow.shipstationRates, []);
  await act(async () => { await view.result.current.workflow.handleGetShipstationRates(); });
  assert.deepEqual(getRates.mock.calls[1].arguments, [1, initial.dropId, { ...acceptedPackage, weight: 25.5 }]);
});

test('address corrections apply only to the shipment and prevent an unchanged failed retry', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const initial = order({ shipstationShipmentId: undefined, address: { countryCode: 'US', full: '***' } });
  const add = t.mock.fn<Api['addFulfillmentOrderToShipStation']>(async () => {
    throw new ProfileApiError({
      code: 'failed-precondition',
      message: 'Correct the destination country.',
      details: { kind: 'shipstation-address-correction', fields: ['country_code'] },
    });
  });
  const view = mount([initial], { addFulfillmentOrderToShipStation: add });
  await act(async () => { await view.result.current.workflow.handleAddToShipStation(); });
  assert.equal(view.result.current.workflow.activeShipstationAddressCorrectionValid, false);
  await act(async () => { await view.result.current.workflow.handleAddToShipStation(); });
  assert.equal(add.mock.callCount(), 1);

  act(() => view.result.current.workflow.editAddress('country_code', 'ca'));
  assert.equal(view.result.current.workflow.shipstationAddressCorrection?.draft.country_code, 'CA');
  assert.equal(view.result.current.workflow.activeShipstationAddressCorrectionValid, true);
  add.mock.mockImplementation(async () => ({ deliveryId: 1, shipmentId: 'shipment-1', alreadyAdded: false }));
  await act(async () => { await view.result.current.workflow.handleAddToShipStation(); });
  assert.deepEqual(add.mock.calls[1].arguments[3], { country_code: 'CA' });
  assert.deepEqual(view.result.current.orders[fulfillmentOrderKey(initial)].address, initial.address);
  assert.equal(view.result.current.workflow.shipstationAddressCorrection, null);
});

test('an already-added shipment does not claim package edits were applied', async () => {
  const initial = order({ shipstationShipmentId: undefined, shipstationPackage: undefined });
  const view = mount([initial], {
    addFulfillmentOrderToShipStation: async () => ({ deliveryId: 1, shipmentId: 'existing-shipment', alreadyAdded: true }),
  });
  act(() => view.result.current.workflow.editPackage('length', '12'));
  await act(async () => { await view.result.current.workflow.handleAddToShipStation(); });
  const updated = view.result.current.orders[fulfillmentOrderKey(initial)];
  assert.equal(updated.shipstationShipmentId, 'existing-shipment');
  assert.equal(updated.shipstationPackage, undefined);
  assert.equal(view.result.current.workflow.activeShipstationPackageKnown, false);
  assert.match(view.result.current.workflow.shipstationError ?? '', /measurements.*were not applied/);
});

for (const invalidation of ['unmount', 'switch order', 'scope invalidated'] as const) {
  test(`a label response after ${invalidation} cannot update orders or open a PDF`, async (t) => {
    const pending = deferred<GetFulfillmentShipStationLabelResponse>();
    const first = order();
    const second = order({ deliveryId: 2, shipstationShipmentId: 'shipment-2' });
    const open = t.mock.method(dom.window, 'open', () => null);
    const view = mount([first, second], { getFulfillmentShipStationLabel: () => pending.promise });
    let request!: Promise<void>;
    act(() => { request = view.result.current.workflow.refreshShipstationLabel(true); });
    assert.equal(view.result.current.workflow.activeShipstationBusy, true);

    if (invalidation === 'unmount') view.unmount();
    else if (invalidation === 'switch order') act(() => view.result.current.openOrder(fulfillmentOrderKey(second)));
    else view.invalidateScope();

    await act(async () => { pending.resolve(labelResponse()); await request; });
    assert.deepEqual(view.updates, []);
    assert.equal(open.mock.callCount(), 0);
    if (invalidation === 'switch order') {
      assert.equal(view.result.current.workflow.activeShipstationBusy, false);
      assert.equal(view.result.current.workflow.shipstationLabelDownloadUrl, null);
    }
  });
}

test('a failed rate request from the previous order cannot show an error in the next order', async () => {
  const pending = deferred<GetFulfillmentShipStationRatesResponse>();
  const first = order();
  const second = order({ deliveryId: 2 });
  const view = mount([first, second], { getFulfillmentShipStationRates: () => pending.promise });
  let request!: Promise<void>;
  act(() => { request = view.result.current.workflow.handleGetShipstationRates(); });
  act(() => view.result.current.openOrder(fulfillmentOrderKey(second)));
  await act(async () => { pending.reject(new Error('Old rate failure')); await request; });
  assert.equal(view.result.current.workflow.shipstationError, null);
  assert.equal(view.result.current.workflow.activeShipstationBusy, false);
  assert.deepEqual(view.result.current.workflow.shipstationRates, []);
});

test('purchase uncertainty preserves its request identity and survives reopening until status resolves', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const getRates = t.mock.fn(async () => ratesResponse());
  const purchase = t.mock.fn(async () => { throw new Error('ShipStation did not confirm the purchase. Check purchase status.'); });
  const initial = order();
  const key = fulfillmentOrderKey(initial);
  const view = mount([initial], {
    getFulfillmentShipStationRates: getRates,
    purchaseFulfillmentShipStationLabel: purchase,
    getFulfillmentShipStationLabel: async () => labelResponse(),
  });
  await act(async () => { await view.result.current.workflow.handleGetShipstationRates(); });
  act(() => view.result.current.workflow.handleReviewShipstationPurchase());
  const requestId = view.result.current.workflow.shipstationPurchaseRequestId;
  assert.ok(requestId);
  await act(async () => { await view.result.current.workflow.handleConfirmShipstationPurchase(); });

  assert.deepEqual(purchase.mock.calls[0].arguments, [{
    dropId: initial.dropId,
    deliveryId: initial.deliveryId,
    rateId: rate().rateId,
    expectedTotal: rate().totalAmount,
    requestId,
  }]);
  assert.equal(view.result.current.workflow.shipstationPurchaseRequestId, requestId);
  assert.equal(view.result.current.orders[key].shipstationPurchaseUnknown, true);
  assert.equal(view.result.current.workflow.activeShipstationCanGetRates, false);
  act(() => view.result.current.workflow.handleCloseShipstationModal());
  act(() => view.result.current.openOrder(key));
  assert.equal(view.result.current.workflow.activeShipstationPurchaseUnknown, true);
  await act(async () => { await view.result.current.workflow.handleGetShipstationRates(); });
  assert.equal(getRates.mock.callCount(), 1);

  await act(async () => { await view.result.current.workflow.refreshShipstationLabel(false); });
  assert.equal(view.result.current.workflow.activeShipstationPurchaseUnknown, false);
  assert.equal(view.result.current.orders[key].shipstationPurchaseUnknown, false);
  assert.equal(view.result.current.orders[key].shipstationLabel?.status, 'completed');
  assert.equal(view.result.current.orders[key].fulfillmentTrackingCode, 'TRACK-1');
  assert.equal(view.updates.at(-1)?.tracking, 'TRACK-1');
});

test('expired quotes leave purchase review and require fresh rates', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const view = mount([order()], {
    getFulfillmentShipStationRates: async () => ratesResponse(),
    purchaseFulfillmentShipStationLabel: async () => { throw new Error('This rate is no longer valid; refresh rates.'); },
  });
  await act(async () => { await view.result.current.workflow.handleGetShipstationRates(); });
  act(() => view.result.current.workflow.handleReviewShipstationPurchase());
  await act(async () => { await view.result.current.workflow.handleConfirmShipstationPurchase(); });
  assert.deepEqual(view.result.current.workflow.shipstationRates, []);
  assert.equal(view.result.current.workflow.shipstationSelectedRateId, null);
  assert.equal(view.result.current.workflow.shipstationReviewingPurchase, false);
  assert.equal(view.result.current.workflow.shipstationPurchaseRequestId, null);
  assert.equal(view.result.current.workflow.shipstationRatesRequested, true);
  assert.equal(view.result.current.workflow.activeShipstationCanGetRates, true);
});

for (const tracking of ['TRACK-1', 'MANUAL-TRACKING']) {
  test(`voiding a label ${tracking === 'TRACK-1' ? 'clears its matching' : 'preserves unrelated'} tracking`, async () => {
    const initial = order({ shipstationLabel: label(), fulfillmentTrackingCode: tracking });
    const view = mount([initial], {
      voidFulfillmentShipStationLabel: async () => ({
        deliveryId: initial.deliveryId,
        shipmentId: initial.shipstationShipmentId!,
        label: { ...label(), status: 'voided' },
      }),
    });
    act(() => view.result.current.workflow.reviewVoid());
    await act(async () => { await view.result.current.workflow.handleConfirmShipstationVoid(); });
    const updated = view.result.current.orders[fulfillmentOrderKey(initial)];
    assert.equal(updated.shipstationLabel?.status, 'voided');
    assert.equal(updated.fulfillmentTrackingCode, tracking === 'TRACK-1' ? undefined : tracking);
    assert.equal(view.updates.at(-1)?.tracking, tracking === 'TRACK-1' ? null : undefined);
    assert.equal(view.result.current.workflow.shipstationReviewingVoid, false);
    assert.equal(view.result.current.workflow.shipstationLabelDownloadUrl, null);
    assert.equal(view.result.current.workflow.activeShipstationCanGetRates, true);
  });
}

test('a void response for a different label cannot replace the purchased label', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const initial = order({ shipstationLabel: label(), fulfillmentTrackingCode: 'TRACK-1' });
  const view = mount([initial], {
    voidFulfillmentShipStationLabel: async () => ({
      deliveryId: initial.deliveryId,
      shipmentId: initial.shipstationShipmentId!,
      label: { ...label(), labelId: 'another-label', status: 'voided' },
    }),
  });
  await act(async () => { await view.result.current.workflow.handleConfirmShipstationVoid(); });
  assert.deepEqual(view.updates, []);
  assert.equal(view.result.current.orders[fulfillmentOrderKey(initial)].shipstationLabel?.status, 'completed');
  assert.match(view.result.current.workflow.shipstationError ?? '', /different label/);
  assert.equal(view.result.current.workflow.activeShipstationBusy, false);
});

test('processing labels poll while open and stop once completed or closed', async (t) => {
  const intervals = new Map<number, () => void>();
  let intervalId = 0;
  t.mock.method(dom.window, 'setInterval', (callback: () => void, delay: number) => {
    assert.equal(delay, 2500);
    intervals.set(++intervalId, callback);
    return intervalId;
  });
  t.mock.method(dom.window, 'clearInterval', (id: number) => { intervals.delete(id); });
  const getLabel = t.mock.fn(async () => labelResponse());
  const first = order({ shipstationLabel: label('processing') });
  const second = order({ deliveryId: 2, shipstationLabel: label('processing') });
  const view = mount([first, second], { getFulfillmentShipStationLabel: getLabel });
  assert.equal(intervals.size, 1);
  await act(async () => { intervals.values().next().value!(); });
  assert.equal(getLabel.mock.callCount(), 1);
  assert.equal(view.result.current.orders[fulfillmentOrderKey(first)].shipstationLabel?.status, 'completed');
  assert.equal(intervals.size, 0);

  act(() => view.result.current.openOrder(fulfillmentOrderKey(second)));
  assert.equal(intervals.size, 1);
  act(() => view.result.current.workflow.handleCloseShipstationModal());
  assert.equal(intervals.size, 0);
});
