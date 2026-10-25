import assert from 'node:assert/strict';
import test, { after, afterEach } from 'node:test';
import { createElement, useCallback, useState } from 'react';
import type { HeaderWallet } from '../src/shop/account/useHeaderWallet.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const { ShopWalletControl } = await import('../src/shop/ui/ShopWalletControl.tsx');

afterEach(cleanup);
after(() => dom.window.close());

const ADDRESS = 'ExampleWalletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function wallet(overrides: Partial<HeaderWallet> = {}): HeaderWallet {
  return {
    address: ADDRESS,
    open: false,
    status: 'account',
    loadingError: null,
    buttonDisabled: false,
    disconnectDisabled: false,
    disconnecting: false,
    disconnectError: null,
    balanceLamports: 1_234_567_890,
    balanceLoading: false,
    balanceError: false,
    activate: async () => undefined,
    close: () => undefined,
    disconnect: async () => undefined,
    retryBalance: () => undefined,
    retryLoading: () => undefined,
    ...overrides,
  };
}

test('wallet icon stays present and only suppresses suspended or passive clicks', () => {
  let activations = 0;
  const model = wallet({ address: undefined, activate: async () => { activations += 1; } });
  const view = render(createElement(ShopWalletControl, { interactive: true, model }));
  const button = view.getByRole('button', { name: 'Wallet' });
  fireEvent.click(button);
  assert.equal(activations, 1);
  view.rerender(createElement(ShopWalletControl, { interactive: true, model: { ...model, buttonDisabled: true } }));
  assert.equal((view.getByRole('button', { name: 'Wallet' }) as HTMLButtonElement).disabled, true);
  fireEvent.click(button);
  assert.equal(activations, 1);
  view.rerender(createElement(ShopWalletControl, { interactive: false, model: { ...model, open: true } }));
  const passive = view.container.querySelector('button')!;
  assert.equal(passive.tabIndex, -1);
  assert.equal(passive.disabled, true);
  assert.equal(view.queryByRole('dialog'), null);
  fireEvent.click(passive);
  assert.equal(activations, 1);
});

for (const [status, label] of [
  ['loading', 'Loading wallet…'],
  ['connecting', 'Connecting wallet…'],
  ['signing-in', 'Signing in…'],
] as const) test(`${status} opens a clear status popup without disabling the wallet icon`, () => {
  let activations = 0;
  const model = wallet({ open: true, status, activate: async () => { activations += 1; } });
  const view = render(createElement(ShopWalletControl, { interactive: true, model }));
  const trigger = view.getByRole('button', { name: 'Wallet' }) as HTMLButtonElement;
  assert.equal(trigger.disabled, false);
  assert.equal(view.getByRole('status').textContent, label);
  assert.equal(view.getByRole('status').getAttribute('aria-live'), 'polite');
  assert.equal(view.queryByText('Mainnet balance'), null);
  assert.equal(view.queryByLabelText(`Solana wallet ${ADDRESS}`), null);
  assert.equal(view.queryByRole('button', { name: 'Disconnect' }), null);
  fireEvent.click(trigger);
  assert.equal(activations, 1);
});

test('loading becomes account content in the same dialog without moving focus', () => {
  const model = wallet({ open: true, address: undefined, status: 'loading' });
  const tree = (current: HeaderWallet) => createElement('div', null,
    createElement(ShopWalletControl, { interactive: true, model: current }),
    createElement('button', null, 'Another control'),
  );
  const view = render(tree(model));
  const popup = view.getByRole('dialog', { name: 'Wallet' });
  assert.equal(document.activeElement, popup);
  view.rerender(tree({ ...model, status: 'connecting' }));
  assert.equal(view.getByRole('dialog', { name: 'Wallet' }), popup);
  assert.equal(document.activeElement, popup);
  const other = view.getByRole('button', { name: 'Another control' });
  other.focus();
  view.rerender(tree({ ...model, status: 'account', address: ADDRESS }));
  assert.equal(view.getByRole('dialog', { name: 'Wallet' }), popup);
  assert.equal(document.activeElement, other);
  assert.ok(view.getByText('1.2346 SOL'));
  assert.equal(view.queryByRole('status'), null);
});

test('loading failures expose retry and preserve popup focus when retry starts', () => {
  let retries = 0;
  const model = wallet({
    open: true, status: 'error', address: undefined, loadingError: 'Unable to reach the shop. Please try again.',
    retryLoading: () => { retries += 1; },
  });
  const view = render(createElement(ShopWalletControl, { interactive: true, model }));
  const popup = view.getByRole('dialog', { name: 'Wallet' });
  assert.equal(view.getByRole('alert').textContent, model.loadingError);
  assert.equal(view.queryByRole('button', { name: 'Disconnect' }), null);
  const retry = view.getByRole('button', { name: 'Retry loading wallet' });
  retry.focus();
  fireEvent.click(retry);
  assert.equal(retries, 1);
  assert.equal(document.activeElement, popup);
  view.rerender(createElement(ShopWalletControl, { interactive: true, model: { ...model, status: 'loading', loadingError: null } }));
  assert.equal(view.getByRole('dialog', { name: 'Wallet' }), popup);
  assert.equal(document.activeElement, popup);
  assert.equal(view.getByRole('status').textContent, 'Loading wallet…');
});

test('sign-in cancellation restores focus from the removed popup to the wallet button', async () => {
  const model = wallet({ open: true, status: 'signing-in', address: undefined });
  const view = render(createElement(ShopWalletControl, { interactive: true, model }));
  assert.equal(document.activeElement, view.getByRole('dialog', { name: 'Wallet' }));
  await act(async () => {
    await Promise.resolve();
    view.rerender(createElement(ShopWalletControl, { interactive: true, model: { ...model, open: false } }));
  });
  assert.equal(view.queryByRole('dialog'), null);
  assert.ok(document.activeElement === view.getByRole('button', { name: 'Wallet' }), 'cancelled sign-in restores wallet focus');
});

test('automatic recovery preserves focus when Retry disappears and Escape still closes the popup', () => {
  let closed = 0;
  const model = wallet({ open: true, status: 'error', address: undefined, close: () => { closed += 1; } });
  const view = render(createElement(ShopWalletControl, { interactive: true, model }));
  const popup = view.getByRole('dialog', { name: 'Wallet' });
  view.getByRole('button', { name: 'Retry loading wallet' }).focus();
  view.rerender(createElement(ShopWalletControl, { interactive: true, model: { ...model, status: 'account', address: ADDRESS } }));
  assert.ok(document.activeElement === popup, 'automatic recovery keeps focus in the popup');
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(closed, 1);
  assert.ok(document.activeElement === view.getByRole('button', { name: 'Wallet' }), 'Escape restores wallet focus');
});

for (const recovery of [false, true]) for (const keepFocus of [true, false]) test(`${recovery ? 'automatic recovery' : 'sign-in cancellation'} preserves focus moved outside${keepFocus ? '' : ' and then cleared'}`, () => {
  const model = wallet({ open: true, status: recovery ? 'error' : 'signing-in', address: undefined });
  const tree = (current: HeaderWallet) => createElement('div', null,
    createElement(ShopWalletControl, { interactive: true, model: current }),
    createElement('button', null, 'Another control'),
  );
  const view = render(tree(model));
  if (recovery) view.getByRole('button', { name: 'Retry loading wallet' }).focus();
  const other = view.getByRole('button', { name: 'Another control' });
  other.focus();
  if (!keepFocus) other.blur();
  view.rerender(tree(recovery
    ? { ...model, status: 'account', address: ADDRESS }
    : { ...model, open: false }));
  assert.ok(document.activeElement === (keepFocus ? other : document.body), 'outside focus is preserved');
});

test('wallet popup shows the account address, mainnet SOL balance, and disconnect', () => {
  let disconnects = 0;
  const model = wallet({ open: true, disconnect: async () => { disconnects += 1; } });
  const view = render(createElement(ShopWalletControl, { interactive: true, model }));
  assert.ok(view.getByRole('dialog', { name: 'Wallet' }));
  assert.equal(view.getByLabelText(`Solana wallet ${ADDRESS}`).textContent, 'Exampl…AAAA');
  assert.ok(view.getByText('Mainnet balance'));
  assert.ok(view.getByText('1.2346 SOL'));
  fireEvent.click(view.getByRole('button', { name: 'Disconnect' }));
  assert.equal(disconnects, 1);
  view.rerender(createElement(ShopWalletControl, { interactive: true, model: { ...model, balanceLamports: 1 } }));
  assert.ok(view.getByText('<0.0001 SOL'));
  view.rerender(createElement(ShopWalletControl, { interactive: true, model: { ...model, balanceLamports: 0 } }));
  assert.ok(view.getByText('0 SOL'));
});

test('balance loading and retry do not replace or disable disconnect', () => {
  let retries = 0;
  const model = wallet({ open: true, balanceLamports: undefined, balanceLoading: true, retryBalance: () => { retries += 1; } });
  const view = render(createElement(ShopWalletControl, { interactive: true, model }));
  assert.ok(view.getByText('Loading balance…'));
  assert.equal((view.getByRole('button', { name: 'Disconnect' }) as HTMLButtonElement).disabled, false);
  view.rerender(createElement(ShopWalletControl, { interactive: true, model: { ...model, balanceLoading: false, balanceError: true } }));
  assert.ok(view.getByText('Balance unavailable'));
  fireEvent.click(view.getByRole('button', { name: 'Retry balance' }));
  assert.equal(retries, 1);
  assert.equal((view.getByRole('button', { name: 'Disconnect' }) as HTMLButtonElement).disabled, false);
});

test('disconnect pending and failures have explicit controls', () => {
  let disconnects = 0;
  const model = wallet({ open: true, disconnecting: true, disconnect: async () => { disconnects += 1; } });
  const view = render(createElement(ShopWalletControl, { interactive: true, model }));
  const pending = view.getByRole('button', { name: 'Disconnecting…' }) as HTMLButtonElement;
  assert.equal((view.getByRole('button', { name: 'Wallet' }) as HTMLButtonElement).disabled, false);
  assert.equal(pending.disabled, true);
  fireEvent.click(pending);
  assert.equal(disconnects, 0);
  view.rerender(createElement(ShopWalletControl, { interactive: true, model: { ...model, disconnecting: false, disconnectError: 'Unable to end the session.' } }));
  assert.equal(view.getByRole('alert').textContent, 'Unable to end the session.');
  fireEvent.click(view.getByRole('button', { name: 'Retry disconnect' }));
  assert.equal(disconnects, 1);
});

test('successful disconnect restores focus once the Wallet trigger becomes usable', () => {
  const model = wallet({ open: true });
  const view = render(createElement(ShopWalletControl, { interactive: true, model }));
  const disconnect = view.getByRole('button', { name: 'Disconnect' });
  disconnect.focus();
  fireEvent.click(disconnect);
  view.rerender(createElement(ShopWalletControl, {
    interactive: true, model: { ...model, disconnecting: true, buttonDisabled: true },
  }));
  view.rerender(createElement(ShopWalletControl, {
    interactive: true, model: { ...model, address: undefined, open: false, buttonDisabled: true },
  }));
  assert.equal(document.activeElement, document.body);
  view.rerender(createElement(ShopWalletControl, {
    interactive: true, model: { ...model, address: undefined, open: false },
  }));
  assert.equal(document.activeElement, view.getByRole('button', { name: 'Wallet' }));
});

for (const failed of [false, true]) for (const keepFocus of [true, false]) test(`${failed ? 'failed' : 'successful'} disconnect respects focus moved to another control${keepFocus ? '' : ' and then cleared'}`, () => {
  const model = wallet({ open: true });
  const tree = (current: HeaderWallet) => createElement('div', null,
    createElement(ShopWalletControl, { interactive: true, model: current }),
    createElement('button', null, 'Another control'),
  );
  const view = render(tree(model));
  const disconnect = view.getByRole('button', { name: 'Disconnect' });
  disconnect.focus();
  fireEvent.click(disconnect);
  view.rerender(tree({ ...model, disconnecting: true, buttonDisabled: true }));
  const other = view.getByRole('button', { name: 'Another control' });
  other.focus();
  if (!keepFocus) other.blur();
  view.rerender(tree(failed
    ? { ...model, disconnectError: 'Disconnect failed.' }
    : { ...model, address: undefined, open: false }));
  assert.equal(document.activeElement, keepFocus ? other : document.body);
});

test('failed disconnect restores focus lost when the pending button is disabled', () => {
  let closed = 0;
  const model = wallet({ open: true, close: () => { closed += 1; } });
  const view = render(createElement(ShopWalletControl, { interactive: true, model }));
  const disconnect = view.getByRole('button', { name: 'Disconnect' });
  disconnect.focus();
  fireEvent.click(disconnect);
  disconnect.blur();
  view.rerender(createElement(ShopWalletControl, {
    interactive: true, model: { ...model, disconnecting: true, buttonDisabled: true },
  }));
  assert.ok(document.activeElement === document.body);
  view.rerender(createElement(ShopWalletControl, {
    interactive: true, model: { ...model, disconnectError: 'Disconnect failed.' },
  }));
  const popup = view.getByRole('dialog', { name: 'Wallet' });
  assert.ok(document.activeElement === popup);
  fireEvent.keyDown(popup, { key: 'Escape' });
  assert.equal(closed, 1);
  assert.equal(document.activeElement, view.getByRole('button', { name: 'Wallet' }));
});

function DismissalHarness() {
  const [open, setOpen] = useState(true);
  const close = useCallback(() => setOpen(false), []);
  return createElement('div', null,
    createElement(ShopWalletControl, { interactive: true, model: wallet({ open, close, activate: async () => setOpen(true) }) }),
    createElement('div', { 'data-testid': 'outside' }, 'Outside'),
    createElement('button', { type: 'button' }, 'Another control'),
  );
}

test('wallet popup focuses on open and Escape returns focus to its trigger', () => {
  const view = render(createElement(DismissalHarness));
  assert.ok(document.activeElement === view.getByRole('dialog', { name: 'Wallet' }), 'popup receives focus');
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(view.queryByRole('dialog'), null);
  assert.ok(document.activeElement === view.getByRole('button', { name: 'Wallet' }), 'Escape restores trigger focus');
});

test('wallet popup leaves Escape alone outside its controls', () => {
  const view = render(createElement(DismissalHarness));
  const other = view.getByRole('button', { name: 'Another control' });
  other.focus();
  assert.equal(fireEvent.keyDown(other, { key: 'Escape' }), true);
  assert.ok(view.getByRole('dialog', { name: 'Wallet' }));
  assert.equal(document.activeElement, other);

  const trigger = view.getByRole('button', { name: 'Wallet' });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Escape' });
  assert.equal(view.queryByRole('dialog'), null);
  assert.equal(document.activeElement, trigger);
});

test('outside dismissal restores abandoned focus but preserves another control focus', async () => {
  const view = render(createElement(DismissalHarness));
  fireEvent.pointerDown(view.getByTestId('outside'));
  assert.equal(view.queryByRole('dialog'), null);
  await waitFor(() => assert.ok(document.activeElement === view.getByRole('button', { name: 'Wallet' }), 'outside dismissal restores trigger focus'));
  fireEvent.click(view.getByRole('button', { name: 'Wallet' }));
  const other = view.getByRole('button', { name: 'Another control' });
  fireEvent.pointerDown(other);
  other.focus();
  assert.equal(view.queryByRole('dialog'), null);
  assert.ok(document.activeElement === other, 'outside controls retain their focus');
});
