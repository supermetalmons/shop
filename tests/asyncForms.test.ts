import assert from 'node:assert/strict';
import test, { afterEach, mock } from 'node:test';
import { createElement } from 'react';
import { PublicKey } from '@solana/web3.js';
import { setupFrontendDom } from './helpers/frontendDom.ts';

setupFrontendDom();

const { act, cleanup, fireEvent, render } = await import('@testing-library/react');
const { NotifyForm } = await import('../src/components/NotifyForm.tsx');
const { ReceiptTransferForm } = await import('../src/components/ReceiptTransferForm.tsx');
const { ClaimForm } = await import('../src/components/ClaimForm.tsx');
const { DeliveryForm } = await import('../src/components/DeliveryForm.tsx');

type ClaimResult = Awaited<ReturnType<Parameters<typeof ClaimForm>[0]['onClaim']>>;

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

function submitTwice(form: HTMLFormElement) {
  act(() => {
    fireEvent.submit(form);
    fireEvent.submit(form);
  });
}

function fillDeliveryAddress(view: ReturnType<typeof render>) {
  for (const [name, value] of Object.entries({
    Email: 'recipient@example.com',
    'Full name': 'Alex Example',
    'Address line 1': '1 Main Street',
    City: 'Brooklyn',
    'State / Region': 'NY',
    'Postal code': '11201',
  })) {
    fireEvent.change(view.getByRole('textbox', { name }), { target: { value } });
  }
}

test('notification submissions keep validation local, block duplicates, and retry after failure', async (t) => {
  const first = deferred<Response>();
  const second = deferred<Response>();
  let attempts = 0;
  const fetch = t.mock.method(globalThis, 'fetch', () => ++attempts === 1 ? first.promise : second.promise);
  const onSuccess = t.mock.fn();
  const view = render(createElement(NotifyForm, { onSuccess, onCancel: () => undefined }), { reactStrictMode: true });
  const email = view.getByRole('textbox', { name: 'Email' }) as HTMLInputElement;
  fireEvent.change(email, { target: { value: 'invalid' } });
  fireEvent.submit(email.form!);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(view.getByRole('alert').textContent, 'Enter a valid email address.');

  fireEvent.change(email, { target: { value: '  recipient@example.com  ' } });
  submitTwice(email.form!);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(email.value, 'recipient@example.com');
  assert.equal(email.disabled, true);
  assert.equal(document.activeElement, view.getByRole('button', { name: 'OK' }));
  await act(async () => first.reject(new Error('Network unavailable')));
  assert.equal(view.getByRole('alert').textContent, 'Unable to subscribe. Please try again.');
  assert.equal(email.disabled, false);
  assert.equal(onSuccess.mock.callCount(), 0);

  fireEvent.submit(email.form!);
  assert.equal(fetch.mock.callCount(), 2);
  assert.equal(view.queryByRole('alert'), null);
  await act(async () => second.resolve(Response.json({ subscribed: true })));
  assert.equal(onSuccess.mock.callCount(), 1);
});

test('notification completion after unmount does not report success', async (t) => {
  const request = deferred<Response>();
  t.mock.method(globalThis, 'fetch', () => request.promise);
  const onSuccess = t.mock.fn();
  const view = render(createElement(NotifyForm, { onSuccess, onCancel: () => undefined }));
  const email = view.getByRole('textbox', { name: 'Email' }) as HTMLInputElement;
  fireEvent.change(email, { target: { value: 'recipient@example.com' } });
  fireEvent.submit(email.form!);
  view.unmount();
  await act(async () => request.resolve(Response.json({ subscribed: true })));
  assert.equal(onSuccess.mock.callCount(), 0);
});

test('receipt transfer blocks duplicate submissions and cancellation, then preserves errors for retry', async (t) => {
  const first = deferred<void>();
  const second = deferred<void>();
  const wallet = new PublicKey(new Uint8Array(32).fill(1)).toBase58();
  const destination = new PublicKey(new Uint8Array(32).fill(2)).toBase58();
  let attempts = 0;
  const onTransfer = t.mock.fn((_destination: string) => ++attempts === 1 ? first.promise : second.promise);
  const onCancel = t.mock.fn();
  const view = render(createElement(ReceiptTransferForm, { feePayer: wallet, onTransfer, onCancel }), { reactStrictMode: true });
  const input = view.getByRole('textbox', { name: 'Destination address' }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: `  ${destination}  ` } });
  submitTwice(input.form!);
  fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
  assert.equal(onTransfer.mock.callCount(), 1);
  assert.deepEqual(onTransfer.mock.calls[0].arguments, [destination]);
  assert.equal(onCancel.mock.callCount(), 0);
  assert.equal(document.activeElement, view.getByRole('button', { name: 'OK' }));
  await act(async () => first.reject(new Error('Wallet rejected the request')));
  assert.equal(view.getByRole('alert').textContent, 'Wallet rejected the request');
  assert.equal(input.disabled, false);
  assert.equal(input.value, destination);

  fireEvent.submit(input.form!);
  assert.equal(view.queryByRole('alert'), null);
  assert.equal(onTransfer.mock.callCount(), 2);
  await act(async () => second.resolve());
  assert.equal(input.disabled, false);
});

test('claim submissions block duplicates and notify the latest loading callback on completion', async (t) => {
  const request = deferred<ClaimResult>();
  const onClaim = t.mock.fn((_payload: { code: string; recipient?: string }) => request.promise);
  const firstLoading = t.mock.fn((_loading: boolean) => undefined);
  const latestLoading = t.mock.fn((_loading: boolean) => undefined);
  const props = { onClaim, initialCode: '  secret-code  ', onLoadingChange: firstLoading, itemsPerBox: 0, boxNamePrefix: 'binder' };
  const view = render(createElement(ClaimForm, props), { reactStrictMode: true });
  firstLoading.mock.resetCalls();
  const input = view.getByPlaceholderText('Code') as HTMLInputElement;
  submitTwice(input.form!);
  assert.equal(onClaim.mock.callCount(), 1);
  assert.deepEqual(onClaim.mock.calls[0].arguments, [{ code: 'secret-code' }]);
  assert.deepEqual(firstLoading.mock.calls.map((call) => call.arguments), [[true]]);
  assert.equal((view.getByRole('button', { name: 'Sending…' }) as HTMLButtonElement).disabled, true);
  view.rerender(createElement(ClaimForm, { ...props, onLoadingChange: latestLoading }));
  await act(async () => request.resolve({ itemsPerBox: 0 }));
  assert.deepEqual(firstLoading.mock.calls.map((call) => call.arguments), [[true]]);
  assert.deepEqual(latestLoading.mock.calls.map((call) => call.arguments), [[false]]);
  assert.ok(view.getByText('Claim submitted successfully! Your binder receipt was transferred.'));
  assert.equal((view.getByRole('button', { name: 'Claim' }) as HTMLButtonElement).disabled, false);
});

test('claim unmount clears loading through the latest callback and suppresses late success', async (t) => {
  const request = deferred<ClaimResult>();
  const firstLoading = t.mock.fn((_loading: boolean) => undefined);
  const latestLoading = t.mock.fn((_loading: boolean) => undefined);
  const onSuccess = t.mock.fn();
  const props = { onClaim: () => request.promise, onSuccess, initialCode: 'secret-code', onLoadingChange: firstLoading };
  const view = render(createElement(ClaimForm, props));
  fireEvent.submit((view.getByPlaceholderText('Code') as HTMLInputElement).form!);
  view.rerender(createElement(ClaimForm, { ...props, onLoadingChange: latestLoading }));
  view.unmount();
  assert.deepEqual(firstLoading.mock.calls.map((call) => call.arguments), [[true]]);
  assert.deepEqual(latestLoading.mock.calls.map((call) => call.arguments), [[false]]);
  await act(async () => request.resolve({ itemsPerBox: 0 }));
  assert.equal(onSuccess.mock.callCount(), 0);
  assert.deepEqual(latestLoading.mock.calls.map((call) => call.arguments), [[false]]);
});

test('deferred claims stop loading without success presentation or callbacks', async (t) => {
  const onSuccess = t.mock.fn();
  const onLoadingChange = t.mock.fn((_loading: boolean) => undefined);
  const props = { initialCode: 'secret-code', onClaim: async () => ({ deferred: true }), onLoadingChange };
  const view = render(createElement(ClaimForm, { ...props, onSuccess }));
  await act(async () => fireEvent.submit((view.getByPlaceholderText('Code') as HTMLInputElement).form!));
  assert.equal(onSuccess.mock.callCount(), 0);
  assert.deepEqual(onLoadingChange.mock.calls.map((call) => call.arguments), [[true], [false]]);
  view.rerender(createElement(ClaimForm, props));
  await act(async () => fireEvent.submit((view.getByPlaceholderText('Code') as HTMLInputElement).form!));
  assert.equal(view.container.querySelector('.success'), null);
  assert.equal((view.getByRole('button', { name: 'Claim' }) as HTMLButtonElement).disabled, false);
});

test('claim failures retain their message and code, clear on retry, and then report success', async (t) => {
  const first = deferred<ClaimResult>();
  const second = deferred<ClaimResult>();
  let attempts = 0;
  const onSuccess = t.mock.fn();
  const view = render(createElement(ClaimForm, {
    initialCode: 'secret-code',
    onClaim: () => ++attempts === 1 ? first.promise : second.promise,
    onSuccess,
  }));
  const input = view.getByPlaceholderText('Code') as HTMLInputElement;
  fireEvent.submit(input.form!);
  await act(async () => first.reject(new Error('Claim is temporarily unavailable')));
  assert.ok(view.getByText('Claim is temporarily unavailable'));
  assert.equal(input.value, 'secret-code');
  fireEvent.submit(input.form!);
  assert.equal(view.queryByText('Claim is temporarily unavailable'), null);
  assert.equal(attempts, 2);
  await act(async () => second.resolve());
  assert.equal(onSuccess.mock.callCount(), 1);
  assert.equal(view.container.querySelector('.success'), null);
});

test('delivery submissions retain native validation and external pending guards', async (t) => {
  const onSubmit = t.mock.fn(async (_payload: { formatted: string; country: string; countryCode: string; email: string }) => undefined);
  const props = { onSubmit, countryCode: 'US' };
  const view = render(createElement(DeliveryForm, props));
  const form = (view.getByRole('textbox', { name: 'Email' }) as HTMLInputElement).form!;
  fireEvent.submit(form);
  assert.ok(view.getByText('Please complete the required fields.'));
  assert.equal(onSubmit.mock.callCount(), 0);
  fillDeliveryAddress(view);
  fireEvent.change(view.getByRole('textbox', { name: 'Email' }), { target: { value: 'invalid' } });
  fireEvent.submit(form);
  assert.equal(onSubmit.mock.callCount(), 0);
  fireEvent.change(view.getByRole('textbox', { name: 'Email' }), { target: { value: 'recipient@example.com' } });

  view.rerender(createElement(DeliveryForm, { ...props, submitDisabled: true }));
  fireEvent.submit(form);
  assert.equal((view.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled, true);
  assert.equal(onSubmit.mock.callCount(), 0);
  view.rerender(createElement(DeliveryForm, { ...props, shipmentPending: true }));
  fireEvent.submit(form);
  assert.equal((view.getByRole('button', { name: 'Shipment pending…' }) as HTMLButtonElement).disabled, true);
  assert.equal(onSubmit.mock.callCount(), 0);
  view.rerender(createElement(DeliveryForm, props));
  await act(async () => fireEvent.submit(form));
  assert.equal(onSubmit.mock.callCount(), 1);
});

test('delivery submissions block duplicates and retain address and errors for retry', async (t) => {
  const first = deferred<void>();
  const second = deferred<void>();
  let attempts = 0;
  const onSubmit = t.mock.fn((_payload: { formatted: string; country: string; countryCode: string; email: string }) => ++attempts === 1 ? first.promise : second.promise);
  const view = render(createElement(DeliveryForm, { onSubmit, countryCode: 'US' }), { reactStrictMode: true });
  fillDeliveryAddress(view);
  const form = (view.getByRole('textbox', { name: 'Email' }) as HTMLInputElement).form!;
  submitTwice(form);
  assert.equal(onSubmit.mock.callCount(), 1);
  assert.deepEqual(onSubmit.mock.calls[0].arguments, [{
    formatted: 'Alex Example\n1 Main Street\nBrooklyn, NY 11201\nUnited States',
    country: 'United States',
    countryCode: 'US',
    email: 'recipient@example.com',
  }]);
  await act(async () => first.reject(new Error('Shipment could not be prepared')));
  assert.ok(view.getByText('Shipment could not be prepared'));
  assert.equal((view.getByRole('textbox', { name: 'Full name' }) as HTMLInputElement).value, 'Alex Example');
  assert.equal((view.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled, false);
  fireEvent.submit(form);
  assert.equal(view.queryByText('Shipment could not be prepared'), null);
  assert.equal(onSubmit.mock.callCount(), 2);
  await act(async () => second.resolve());
  assert.equal((view.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled, false);
});
