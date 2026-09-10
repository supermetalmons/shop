import assert from 'node:assert/strict';
import test, { afterEach, mock } from 'node:test';
import { createElement, useState } from 'react';
import type { FulfillmentOrder } from '../src/types.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

setupFrontendDom();

const { act, cleanup, fireEvent, render } = await import('@testing-library/react');
const { FulfillmentStatusModal } = await import('../src/fulfillment/FulfillmentStatusModal.tsx');
const { FulfillmentAddressModal } = await import('../src/fulfillment/FulfillmentAddressModal.tsx');
type StatusProps = Parameters<typeof FulfillmentStatusModal>[0];
type AddressProps = Parameters<typeof FulfillmentAddressModal>[0];
type StatusResponse = Awaited<ReturnType<NonNullable<StatusProps['api']>['updateFulfillmentStatus']>>;
type AddressResponse = Awaited<ReturnType<NonNullable<AddressProps['api']>['updateFulfillmentAddress']>>;

afterEach(() => {
  cleanup();
  mock.restoreAll();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function order(deliveryId = 42): FulfillmentOrder {
  return {
    dropId: 'card_nft_2',
    deliveryId,
    owner: 'wallet',
    status: 'processed',
    fulfillmentStatus: 'Preparing',
    address: { full: `${deliveryId} Main Street`, email: 'recipient@example.com', countryCode: 'US' },
    boxes: [],
    looseDudes: [],
  };
}

function statusProps(overrides: Partial<StatusProps> = {}): StatusProps {
  return {
    order: order(),
    canManage: true,
    suspended: false,
    isCurrentScope: () => true,
    onClose: () => undefined,
    onOrderUpdated: () => undefined,
    onError: () => undefined,
    api: { updateFulfillmentStatus: async () => { throw new Error('Unexpected status request'); } },
    ...overrides,
  };
}

function addressProps(overrides: Partial<AddressProps> = {}): AddressProps {
  return {
    order: order(),
    canManage: true,
    suspended: false,
    isCurrentScope: () => true,
    onClose: () => undefined,
    onOrderUpdated: () => undefined,
    api: { updateFulfillmentAddress: async () => { throw new Error('Unexpected address request'); } },
    ...overrides,
  };
}

test('status saves sanitized tracking once and merges the normalized response into the order', async (t) => {
  const request = deferred<StatusResponse>();
  const update = t.mock.fn(() => request.promise);
  const onClose = t.mock.fn();
  let current: FulfillmentOrder = { ...order(), stripeChargeback: true };
  const props = statusProps({
    order: current,
    api: { updateFulfillmentStatus: update },
    onClose,
    onOrderUpdated: (key, apply) => {
      assert.equal(key, 'card_nft_2:42');
      current = apply(current);
    },
  });
  const view = render(createElement(FulfillmentStatusModal, props), { reactStrictMode: true });
  fireEvent.change(view.getByRole('combobox', { name: 'Fulfillment status' }), { target: { value: 'Shipped' } });
  fireEvent.change(view.getByRole('textbox', { name: 'Tracking link' }), { target: { value: '  https://tracking.example/package  ' } });
  const save = view.getByRole('button', { name: 'Save' });
  act(() => { fireEvent.click(save); fireEvent.click(save); });
  assert.equal(update.mock.callCount(), 1);
  assert.deepEqual(update.mock.calls[0].arguments, [42, 'Shipped', 'card_nft_2', 'https://tracking.example/package']);
  assert.equal((save as HTMLButtonElement).disabled, true);
  await act(async () => request.resolve({ deliveryId: 42, fulfillmentStatus: 'Shipped', fulfillmentTrackingCode: '  https://tracking.example/canonical  ' }));
  assert.equal(current.fulfillmentStatus, 'Shipped');
  assert.equal(current.stripeChargeback, true);
  assert.equal(current.fulfillmentTrackingCode, 'https://tracking.example/canonical');
  assert.equal(onClose.mock.callCount(), 1);
});

test('non-shipped status updates retain stored tracking and Not set clears the status', async (t) => {
  let current: FulfillmentOrder = { ...order(), fulfillmentStatus: 'Shipped', fulfillmentTrackingCode: 'https://tracking.example/old' };
  const update = t.mock.fn(async () => ({ deliveryId: 42, fulfillmentStatus: '' as const }));
  const view = render(createElement(FulfillmentStatusModal, statusProps({
    order: current,
    api: { updateFulfillmentStatus: update },
    onOrderUpdated: (_key, apply) => { current = apply(current); },
  })));
  fireEvent.change(view.getByRole('combobox'), { target: { value: '' } });
  assert.equal(view.queryByRole('textbox', { name: 'Tracking link' }), null);
  await act(async () => fireEvent.click(view.getByRole('button', { name: 'Save' })));
  assert.deepEqual(update.mock.calls[0].arguments, [42, '', 'card_nft_2', undefined]);
  assert.equal(current.fulfillmentStatus, undefined);
  assert.equal(current.fulfillmentTrackingCode, 'https://tracking.example/old');
});

test('status failures preserve edits and report through the page error callback for retry', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const failed = deferred<StatusResponse>();
  let attempt = 0;
  const onError = t.mock.fn();
  const onClose = t.mock.fn();
  const view = render(createElement(FulfillmentStatusModal, statusProps({
    onError,
    onClose,
    api: { updateFulfillmentStatus: () => ++attempt === 1 ? failed.promise : Promise.resolve({ deliveryId: 42, fulfillmentStatus: 'Shipped' }) },
  })));
  fireEvent.change(view.getByRole('combobox'), { target: { value: 'Shipped' } });
  fireEvent.change(view.getByRole('textbox', { name: 'Tracking link' }), { target: { value: 'keep this draft' } });
  fireEvent.click(view.getByRole('button', { name: 'Save' }));
  await act(async () => failed.reject(new Error('Status unavailable')));
  assert.equal((view.getByRole('textbox', { name: 'Tracking link' }) as HTMLInputElement).value, 'keep this draft');
  assert.deepEqual(onError.mock.calls.map((call) => call.arguments), [[null], ['Status unavailable']]);
  assert.equal(onClose.mock.callCount(), 0);
  await act(async () => fireEvent.click(view.getByRole('button', { name: 'Save' })));
  assert.equal(attempt, 2);
  assert.equal(onClose.mock.callCount(), 1);
});

test('a dismissed status request retains its lock and updates the order without closing a reopened session', async (t) => {
  const request = deferred<StatusResponse>();
  const update = t.mock.fn(() => request.promise);
  const onClose = t.mock.fn();
  const onOrderUpdated = t.mock.fn();
  const props = statusProps({ api: { updateFulfillmentStatus: update }, onClose, onOrderUpdated });
  const view = render(createElement(FulfillmentStatusModal, props));
  fireEvent.change(view.getByRole('combobox'), { target: { value: 'Shipped' } });
  fireEvent.click(view.getByRole('button', { name: 'Save' }));
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(onClose.mock.callCount(), 1);
  view.rerender(createElement(FulfillmentStatusModal, { ...props, order: null }));
  view.rerender(createElement(FulfillmentStatusModal, props));
  assert.equal((view.getByRole('combobox') as HTMLSelectElement).value, 'Preparing');
  fireEvent.change(view.getByRole('combobox'), { target: { value: '' } });
  assert.equal((view.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled, true);
  await act(async () => request.resolve({ deliveryId: 42, fulfillmentStatus: 'Shipped' }));
  assert.equal(onOrderUpdated.mock.callCount(), 1);
  assert.equal(onOrderUpdated.mock.calls[0].arguments[0], 'card_nft_2:42');
  assert.equal(onClose.mock.callCount(), 1);
  assert.equal((view.getByRole('combobox') as HTMLSelectElement).value, '');
  assert.equal((view.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled, false);
});

test('finishing a status request cannot close another order or release that order’s pending lock', async (t) => {
  const first = deferred<StatusResponse>();
  const second = deferred<StatusResponse>();
  const onClose = t.mock.fn();
  const onOrderUpdated = t.mock.fn();
  const props = statusProps({
    onClose,
    onOrderUpdated,
    api: { updateFulfillmentStatus: (id) => id === 42 ? first.promise : second.promise },
  });
  const view = render(createElement(FulfillmentStatusModal, props));
  fireEvent.change(view.getByRole('combobox'), { target: { value: 'Shipped' } });
  fireEvent.click(view.getByRole('button', { name: 'Save' }));
  view.rerender(createElement(FulfillmentStatusModal, { ...props, order: order(43) }));
  fireEvent.change(view.getByRole('combobox'), { target: { value: 'Shipped' } });
  fireEvent.click(view.getByRole('button', { name: 'Save' }));
  await act(async () => first.resolve({ deliveryId: 42, fulfillmentStatus: 'Shipped' }));
  assert.equal(onOrderUpdated.mock.calls[0].arguments[0], 'card_nft_2:42');
  assert.equal(onClose.mock.callCount(), 0);
  assert.equal((view.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled, true);
  await act(async () => second.resolve({ deliveryId: 43, fulfillmentStatus: 'Shipped' }));
  assert.equal(onClose.mock.callCount(), 1);
});

test('address saves trim input, block duplicate submits and dismissal, and preserve unrelated address fields', async (t) => {
  const request = deferred<AddressResponse>();
  const update = t.mock.fn(() => request.promise);
  const onClose = t.mock.fn();
  let current = order();
  const view = render(createElement(FulfillmentAddressModal, addressProps({
    api: { updateFulfillmentAddress: update },
    onClose,
    onOrderUpdated: (key, apply) => {
      assert.equal(key, 'card_nft_2:42');
      current = apply(current);
    },
  })), { reactStrictMode: true });
  const input = view.getByRole('textbox', { name: 'Delivery address' }) as HTMLTextAreaElement;
  assert.equal(input.maxLength, 2048);
  assert.equal(input.rows, 8);
  fireEvent.change(input, { target: { value: '  99 New Street\nNew City  ' } });
  act(() => { fireEvent.submit(input.form!); fireEvent.submit(input.form!); });
  assert.equal(update.mock.callCount(), 1);
  assert.deepEqual(update.mock.calls[0].arguments, [42, '99 New Street\nNew City', 'card_nft_2']);
  assert.equal(input.disabled, true);
  assert.equal((view.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled, true);
  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.click(view.getByRole('dialog').parentElement!);
  assert.equal(onClose.mock.callCount(), 0);
  await act(async () => request.resolve({ deliveryId: 42, address: { full: '99 New Street\nNew City', countryCode: 'CA' } }));
  assert.deepEqual(current.address, { full: '99 New Street\nNew City', countryCode: 'CA', email: 'recipient@example.com' });
  assert.equal(onClose.mock.callCount(), 1);
});

test('address validation and save errors retain the draft and allow retry', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const first = deferred<AddressResponse>();
  let attempts = 0;
  const onClose = t.mock.fn();
  const view = render(createElement(FulfillmentAddressModal, addressProps({
    onClose,
    api: { updateFulfillmentAddress: () => ++attempts === 1 ? first.promise : Promise.resolve({ deliveryId: 42, address: { full: 'New address' } }) },
  })));
  const input = view.getByRole('textbox', { name: 'Delivery address' }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: '   ' } });
  fireEvent.submit(input.form!);
  assert.ok(view.getByText('Enter a delivery address.'));
  assert.equal(attempts, 0);
  fireEvent.change(input, { target: { value: 'New address' } });
  fireEvent.submit(input.form!);
  await act(async () => first.reject(new Error('Address unavailable')));
  assert.ok(view.getByText('Address unavailable'));
  assert.equal(input.value, 'New address');
  assert.equal(input.disabled, false);
  assert.equal(onClose.mock.callCount(), 0);
  await act(async () => fireEvent.submit(input.form!));
  assert.equal(attempts, 2);
  assert.equal(onClose.mock.callCount(), 1);
});

test('address edits never submit without access or for an IRL-redeemed order', (t) => {
  const update = t.mock.fn(async () => ({ deliveryId: 42, address: { full: 'New address' } }));
  const props = addressProps({ order: { ...order(), address: { full: '***' } }, canManage: false, api: { updateFulfillmentAddress: update } });
  const view = render(createElement(FulfillmentAddressModal, props));
  let input = view.getByRole('textbox', { name: 'Delivery address' }) as HTMLTextAreaElement;
  assert.equal(input.value, '');
  fireEvent.change(input, { target: { value: 'New address' } });
  fireEvent.submit(input.form!);
  assert.equal(update.mock.callCount(), 0);
  view.rerender(createElement(FulfillmentAddressModal, { ...props, canManage: true, order: { ...order(), source: 'admin_irl_redeem' } }));
  input = view.getByRole('textbox', { name: 'Delivery address' }) as HTMLTextAreaElement;
  fireEvent.submit(input.form!);
  assert.equal(update.mock.callCount(), 0);
});

test('an old address request cannot close a different order, change its draft, or release its saving lock', async (t) => {
  const first = deferred<AddressResponse>();
  const second = deferred<AddressResponse>();
  const onClose = t.mock.fn();
  const onOrderUpdated = t.mock.fn();
  const props = addressProps({
    onClose,
    onOrderUpdated,
    api: { updateFulfillmentAddress: (id) => id === 42 ? first.promise : second.promise },
  });
  const view = render(createElement(FulfillmentAddressModal, props));
  let input = view.getByRole('textbox', { name: 'Delivery address' }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'First new address' } });
  fireEvent.submit(input.form!);
  view.rerender(createElement(FulfillmentAddressModal, { ...props, order: order(43) }));
  input = view.getByRole('textbox', { name: 'Delivery address' }) as HTMLTextAreaElement;
  assert.equal(input.value, '43 Main Street');
  fireEvent.change(input, { target: { value: 'Second new address' } });
  fireEvent.submit(input.form!);
  await act(async () => first.resolve({ deliveryId: 42, address: { full: 'First new address' } }));
  assert.equal(onOrderUpdated.mock.calls[0].arguments[0], 'card_nft_2:42');
  assert.equal(onClose.mock.callCount(), 0);
  assert.equal(input.value, 'Second new address');
  assert.equal(input.disabled, true);
  await act(async () => second.resolve({ deliveryId: 43, address: { full: 'Second new address' } }));
  assert.equal(onClose.mock.callCount(), 1);
});

for (const kind of ['status', 'address'] as const) {
  test(`${kind} keeps an active draft through order updates and reopens with the latest canonical values`, () => {
    const original = { ...order(), fulfillmentStatus: 'Shipped' as const, fulfillmentTrackingCode: 'https://tracking.example/original' };
    const refreshed = {
      ...original,
      fulfillmentTrackingCode: 'https://tracking.example/shipstation',
      address: { ...original.address, full: 'Updated canonical address' },
    };
    const element = (current: FulfillmentOrder | null) => kind === 'status'
      ? createElement(FulfillmentStatusModal, statusProps({ order: current }))
      : createElement(FulfillmentAddressModal, addressProps({ order: current }));
    const view = render(element(original));
    fireEvent.change(view.getByRole('textbox'), { target: { value: 'Keep my draft' } });
    view.rerender(element(refreshed));
    assert.equal((view.getByRole('textbox') as HTMLInputElement).value, 'Keep my draft');
    view.rerender(element(null));
    view.rerender(element(refreshed));
    assert.equal((view.getByRole('textbox') as HTMLInputElement).value,
      kind === 'status' ? 'https://tracking.example/shipstation' : 'Updated canonical address');
  });

  test(`${kind} scope remount isolates a new request from an old failure and finally handler`, async (t) => {
    const oldStatus = deferred<StatusResponse>();
    const newStatus = deferred<StatusResponse>();
    const oldAddress = deferred<AddressResponse>();
    const newAddress = deferred<AddressResponse>();
    let currentScope = 1;
    const onClose = t.mock.fn();
    const onOrderUpdated = t.mock.fn();
    const onError = t.mock.fn();
    const element = (scope: number) => {
      const common = { onClose, onOrderUpdated, isCurrentScope: () => currentScope === scope };
      return kind === 'status'
        ? createElement(FulfillmentStatusModal, {
          ...statusProps({ ...common, onError, api: { updateFulfillmentStatus: () => scope === 1 ? oldStatus.promise : newStatus.promise } }),
          key: scope,
        })
        : createElement(FulfillmentAddressModal, {
          ...addressProps({ ...common, api: { updateFulfillmentAddress: () => scope === 1 ? oldAddress.promise : newAddress.promise } }),
          key: scope,
        });
    };
    const view = render(element(1));
    const submit = () => {
      if (kind === 'status') {
        fireEvent.change(view.getByRole('combobox'), { target: { value: 'Shipped' } });
        fireEvent.click(view.getByRole('button', { name: 'Save' }));
      } else {
        const input = view.getByRole('textbox') as HTMLTextAreaElement;
        fireEvent.change(input, { target: { value: 'New address' } });
        fireEvent.submit(input.form!);
      }
    };
    submit();
    currentScope = 2;
    view.rerender(element(2));
    submit();
    await act(async () => (kind === 'status' ? oldStatus : oldAddress).reject(new Error('Old scope error')));
    assert.equal(onOrderUpdated.mock.callCount(), 0);
    assert.equal(onClose.mock.callCount(), 0);
    assert.ok(onError.mock.calls.every((call) => call.arguments[0] === null));
    assert.equal(view.queryByText('Old scope error'), null);
    assert.equal((view.getByRole('button', { name: kind === 'status' ? 'Save' : 'Saving…' }) as HTMLButtonElement).disabled, true);
    await act(async () => {
      if (kind === 'status') newStatus.resolve({ deliveryId: 42, fulfillmentStatus: 'Shipped' });
      else newAddress.resolve({ deliveryId: 42, address: { full: 'New address' } });
    });
    assert.equal(onOrderUpdated.mock.callCount(), 1);
    assert.equal(onClose.mock.callCount(), 1);
  });

  test(`${kind} suspension and same-order refresh preserve drafts, while cancel restores focus and discards edits`, () => {
    function Harness({ suspended = false }: { suspended?: boolean }) {
      const [open, setOpen] = useState(false);
      const common = { order: open ? { ...order() } : null, suspended, onClose: () => setOpen(false) };
      return createElement('div', null,
        createElement('button', { onClick: () => setOpen(true) }, 'Edit order'),
        kind === 'status'
          ? createElement(FulfillmentStatusModal, statusProps(common))
          : createElement(FulfillmentAddressModal, addressProps(common)),
      );
    }
    const view = render(createElement(Harness));
    const opener = view.getByRole('button', { name: 'Edit order' });
    opener.focus();
    fireEvent.click(opener);
    if (kind === 'status') fireEvent.change(view.getByRole('combobox'), { target: { value: 'Shipped' } });
    const input = view.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Preserved draft' } });
    const dialog = view.getByRole('dialog');
    view.rerender(createElement(Harness, { suspended: true }));
    assert.equal(dialog.hasAttribute('inert'), true);
    fireEvent.keyDown(document, { key: 'Escape' });
    assert.equal(document.querySelector('[role="dialog"]'), dialog);
    view.rerender(createElement(Harness, { suspended: false }));
    assert.equal((view.getByRole('textbox') as HTMLInputElement).value, 'Preserved draft');
    fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
    assert.equal(view.queryByRole('dialog'), null);
    assert.equal(document.activeElement, opener);
    assert.equal(document.body.style.overflow, '');
    fireEvent.click(opener);
    if (kind === 'status') assert.equal((view.getByRole('combobox') as HTMLSelectElement).value, 'Preparing');
    else assert.equal((view.getByRole('textbox') as HTMLTextAreaElement).value, '42 Main Street');
  });

  for (const end of ['scope change', 'unmount'] as const) {
    for (const outcome of ['success', 'failure'] as const) {
      test(`${kind} ignores late ${outcome} after ${end}`, async (t) => {
        const statusRequest = deferred<StatusResponse>();
        const addressRequest = deferred<AddressResponse>();
        let currentScope = true;
        const onClose = t.mock.fn();
        const onOrderUpdated = t.mock.fn();
        const onError = t.mock.fn();
        const common = { onClose, onOrderUpdated, isCurrentScope: () => currentScope };
        const view = render(kind === 'status'
          ? createElement(FulfillmentStatusModal, statusProps({ ...common, onError, api: { updateFulfillmentStatus: () => statusRequest.promise } }))
          : createElement(FulfillmentAddressModal, addressProps({ ...common, api: { updateFulfillmentAddress: () => addressRequest.promise } })),
        );
        if (kind === 'status') {
          fireEvent.change(view.getByRole('combobox'), { target: { value: 'Shipped' } });
          fireEvent.click(view.getByRole('button', { name: 'Save' }));
        } else {
          const input = view.getByRole('textbox') as HTMLTextAreaElement;
          fireEvent.change(input, { target: { value: 'New address' } });
          fireEvent.submit(input.form!);
        }
        if (end === 'unmount') view.unmount();
        else currentScope = false;
        await act(async () => {
          if (outcome === 'failure') (kind === 'status' ? statusRequest : addressRequest).reject(new Error('Stale failure'));
          else if (kind === 'status') statusRequest.resolve({ deliveryId: 42, fulfillmentStatus: 'Shipped' });
          else addressRequest.resolve({ deliveryId: 42, address: { full: 'New address' } });
        });
        assert.equal(onClose.mock.callCount(), 0);
        assert.equal(onOrderUpdated.mock.callCount(), 0);
        assert.ok(onError.mock.calls.every((call) => call.arguments[0] === null));
      });
    }
  }
}
