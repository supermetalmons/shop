import assert from 'node:assert/strict';
import test, { after, afterEach, mock } from 'node:test';
import { createElement, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { PublicKey } from '@solana/web3.js';
import type { WalletContextState } from '@solana/wallet-adapter-react';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom, setMediaQueryMatches } = setupFrontendDom();
Object.defineProperty(globalThis, 'Event', { configurable: true, value: dom.window.Event });

const { act, cleanup, fireEvent, render } = await import('@testing-library/react');
const { WalletContext } = await import('@solana/wallet-adapter-react');
const { WalletModalContext, WalletModalProvider, useWalletModal } = await import('@solana/wallet-adapter-react-ui');
const { BackgroundBlurProvider } = await import('../src/components/BackgroundBlurLayer.tsx');
const { NfcClaimOverlay } = await import('../src/components/NfcClaimOverlay.tsx');
const { getNormalizedPathname, navigate, subscribeToNavigation } = await import('../src/navigation.ts');

const walletKey = new PublicKey(new Uint8Array(32).fill(1));
const destinationKey = new PublicKey(new Uint8Array(32).fill(2));

afterEach(() => {
  cleanup();
  mock.restoreAll();
  window.history.replaceState(null, '', '/');
  document.body.style.overflow = '';
  setMediaQueryMatches('(pointer: coarse)', false);
});
after(() => dom.window.close());

function walletState(publicKey: PublicKey | null = null): WalletContextState {
  return {
    publicKey,
    autoConnect: false,
    wallets: [],
    wallet: null,
    connecting: false,
    connected: Boolean(publicKey),
    disconnecting: false,
    select: mock.fn(),
    connect: mock.fn(async () => undefined),
    disconnect: mock.fn(async () => undefined),
    sendTransaction: mock.fn(async () => ''),
    signTransaction: mock.fn(async (transaction) => transaction),
    signAllTransactions: mock.fn(async (transactions) => transactions),
    signMessage: mock.fn(async () => new Uint8Array()),
    signIn: undefined,
  };
}

function Fixture({
  wallet,
  walletModalVisible = false,
  onWalletModalChange,
}: {
  wallet: WalletContextState;
  walletModalVisible?: boolean;
  onWalletModalChange?: (visible: boolean) => void;
}) {
  const pathname = useSyncExternalStore(subscribeToNavigation, getNormalizedPathname);
  const [visible, updateVisible] = useState(walletModalVisible);
  const setVisible = useCallback((next: boolean) => {
    onWalletModalChange?.(next);
    updateVisible(next);
  }, [onWalletModalChange]);

  return createElement(WalletContext.Provider, { value: wallet },
    createElement(WalletModalContext.Provider, { value: { visible, setVisible } },
      createElement(BackgroundBlurProvider, null,
        createElement('button', { type: 'button', 'data-background-blur-focus-fallback': '' }, 'Home action'),
        pathname === '/nfc' ? createElement(NfcClaimOverlay) : null,
      ),
    ),
  );
}

function renderOverlay(wallet = walletState(), url = '/nfc/?code=STUB-SECRET-CODE') {
  window.history.replaceState(null, '', url);
  return render(createElement(Fixture, { wallet }), { reactStrictMode: true });
}

function renderWithWalletModal(url: string) {
  let setWalletVisible!: (visible: boolean) => void;
  function Contents() {
    const pathname = useSyncExternalStore(subscribeToNavigation, getNormalizedPathname);
    const { setVisible } = useWalletModal();
    useEffect(() => { setWalletVisible = setVisible; }, [setVisible]);
    return createElement(BackgroundBlurProvider, null,
      createElement('button', { type: 'button' }, 'Home action'),
      pathname === '/nfc' ? createElement(NfcClaimOverlay) : null,
    );
  }
  window.history.replaceState(null, '', url);
  const view = render(createElement(WalletContext.Provider, { value: walletState() },
    createElement(WalletModalProvider, null, createElement(Contents)),
  ), { reactStrictMode: true });
  return { ...view, showWallet: () => act(() => setWalletVisible(true)) };
}

test('NFC always shows the address and claim controls without a secret-code field', () => {
  for (const url of ['/nfc', '/nfc/', '/nfc/?code=', '/nfc/?code=STUB-SECRET-CODE', '/nfc/?code=secret%20code']) {
    const view = renderOverlay(walletState(), url);
    const input = view.getByRole('textbox', { name: 'Receiver Solana address' }) as HTMLInputElement;
    assert.equal(input.value, '');
    assert.equal(input.required, true);
    assert.equal(input.form!.noValidate, true);
    assert.equal(view.getAllByRole('textbox').length, 1);
    assert.ok(view.getByRole('button', { name: 'Claim' }));
    assert.ok(view.getByRole('dialog', { name: 'NFC claim' }));
    assert.equal(view.queryByPlaceholderText('Code'), null);
    assert.equal(view.queryByRole('button', { name: 'Close' }), null);
    assert.equal(window.location.pathname + window.location.search, url);
    view.unmount();
  }
});

test('NFC prefills a connected wallet and preserves a manually cleared or edited address', () => {
  const wallet = walletState(walletKey);
  const view = renderOverlay(wallet);
  const input = view.getByRole('textbox', { name: 'Receiver Solana address' }) as HTMLInputElement;
  assert.equal(input.value, walletKey.toBase58());

  fireEvent.change(input, { target: { value: destinationKey.toBase58() } });
  view.rerender(createElement(Fixture, { wallet: { ...wallet, publicKey: null } }));
  view.rerender(createElement(Fixture, { wallet }));
  assert.equal(input.value, destinationKey.toBase58());

  fireEvent.change(input, { target: { value: '' } });
  view.rerender(createElement(Fixture, { wallet: { ...wallet, publicKey: destinationKey } }));
  assert.equal(input.value, '');
});

test('NFC accepts a delayed wallet prefill only while the address remains untouched', () => {
  const wallet = walletState();
  const view = renderOverlay(wallet);
  const input = view.getByRole('textbox', { name: 'Receiver Solana address' }) as HTMLInputElement;
  view.rerender(createElement(Fixture, { wallet: { ...wallet, publicKey: walletKey } }));
  assert.equal(input.value, walletKey.toBase58());
  view.rerender(createElement(Fixture, { wallet: { ...wallet, publicKey: destinationKey } }));
  assert.equal(input.value, walletKey.toBase58());
  view.unmount();

  const editedView = renderOverlay(wallet);
  const editedInput = editedView.getByRole('textbox', { name: 'Receiver Solana address' }) as HTMLInputElement;
  fireEvent.change(editedInput, { target: { value: 'user entry' } });
  editedView.rerender(createElement(Fixture, { wallet: { ...wallet, publicKey: walletKey } }));
  assert.equal(editedInput.value, 'user entry');
});

test('NFC validates locally and synchronously opens only the video without claiming or signing', (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({}));
  const open = t.mock.method(window, 'open', () => null);
  const wallet = walletState();
  const walletCalls = [wallet.connect, wallet.sendTransaction, wallet.signTransaction!, wallet.signAllTransactions!, wallet.signMessage!]
    .map((method) => method as ReturnType<typeof mock.fn>);
  const view = renderOverlay(wallet);
  const input = view.getByRole('textbox', { name: 'Receiver Solana address' }) as HTMLInputElement;

  for (const value of ['', '   ', 'invalid-solana-address']) {
    fireEvent.change(input, { target: { value } });
    fireEvent.submit(input.form!);
    assert.equal(view.getByRole('alert').textContent, 'Enter a valid Solana address.');
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    assert.equal(open.mock.callCount(), 0);
  }

  fireEvent.change(input, { target: { value: `  ${destinationKey.toBase58()}  ` } });
  fireEvent.click(view.getByRole('button', { name: 'Claim' }));
  assert.deepEqual(open.mock.calls.map((call) => call.arguments), [
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', '_blank', 'noopener,noreferrer'],
  ]);
  assert.equal(input.value, destinationKey.toBase58());
  assert.equal(view.queryByRole('alert'), null);
  assert.equal(input.getAttribute('aria-invalid'), 'false');
  assert.ok(view.getByRole('dialog', { name: 'NFC claim' }));
  assert.equal((view.getByRole('button', { name: 'Claim' }) as HTMLButtonElement).disabled, false);
  assert.equal(window.location.pathname + window.location.search, '/nfc/?code=STUB-SECRET-CODE');
  assert.equal(fetch.mock.callCount(), 0);
  for (const method of walletCalls) assert.equal(method.mock.callCount(), 0);
});

test('NFC dismisses an existing wallet dialog before presenting its address form', (t) => {
  window.history.replaceState(null, '', '/nfc/');
  const onWalletModalChange = t.mock.fn();
  const view = render(createElement(Fixture, { wallet: walletState(), walletModalVisible: true, onWalletModalChange }));
  assert.deepEqual(onWalletModalChange.mock.calls.map((call) => call.arguments), [[false]]);
  assert.ok(view.getByRole('textbox', { name: 'Receiver Solana address' }));
});

test('NFC restores scrolling after suppressing a wallet modal opened while NFC is active', () => {
  document.body.style.overflow = 'auto';
  const view = renderWithWalletModal('/nfc/?code=STUB-SECRET-CODE');
  const input = view.getByRole('textbox', { name: 'Receiver Solana address' }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: destinationKey.toBase58() } });
  assert.equal(document.body.style.overflow, 'hidden');

  view.showWallet();
  assert.equal(document.querySelector('.wallet-adapter-modal'), null);
  assert.equal(document.body.style.overflow, 'hidden');
  assert.equal(input.value, destinationKey.toBase58());
  assert.ok(view.getByRole('dialog', { name: 'NFC claim' }));

  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(window.location.pathname, '/');
  assert.equal(view.queryByRole('dialog'), null);
  assert.equal(document.body.style.overflow, 'auto');
  assert.equal(document.querySelector('.background-blur-layer')?.hasAttribute('inert'), false);
});

test('NFC restores the original scrolling state when entered over an already-visible wallet modal', () => {
  document.body.style.overflow = 'auto';
  const view = renderWithWalletModal('/');
  view.showWallet();
  assert.ok(document.querySelector('.wallet-adapter-modal'));
  assert.equal(document.body.style.overflow, 'hidden');

  act(() => navigate('/nfc'));
  assert.equal(document.querySelector('.wallet-adapter-modal'), null);
  const dialog = view.getByRole('dialog', { name: 'NFC claim' });
  assert.equal(document.body.style.overflow, 'hidden');

  fireEvent.click(dialog.parentElement!);
  assert.equal(window.location.pathname, '/');
  assert.equal(view.queryByRole('dialog'), null);
  assert.equal(document.body.style.overflow, 'auto');
  assert.equal(document.querySelector('.background-blur-layer')?.hasAttribute('inert'), false);
});

test('inside taps preserve NFC while an outside tap replaces its URL and releases blur and scrolling', (t) => {
  document.body.style.overflow = 'auto';
  const view = renderOverlay();
  const replaceState = t.mock.method(window.history, 'replaceState');
  const pushState = t.mock.method(window.history, 'pushState');
  const dialog = view.getByRole('dialog', { name: 'NFC claim' });
  const background = document.querySelector('.background-blur-layer')!;
  assert.equal(background.hasAttribute('inert'), true);
  assert.equal(background.getAttribute('aria-hidden'), 'true');
  assert.ok(document.querySelector('.background-blur-layer__viewport--active'));
  assert.equal(document.body.style.overflow, 'hidden');

  fireEvent.click(dialog);
  fireEvent.click(view.getByRole('textbox', { name: 'Receiver Solana address' }));
  assert.equal(replaceState.mock.callCount(), 0);
  fireEvent.click(dialog.parentElement!);

  assert.equal(view.queryByRole('dialog'), null);
  assert.deepEqual(replaceState.mock.calls.map((call) => call.arguments), [[null, '', '/']]);
  assert.equal(pushState.mock.callCount(), 0);
  assert.equal(window.location.pathname + window.location.search, '/');
  assert.equal(background.hasAttribute('inert'), false);
  assert.equal(background.hasAttribute('aria-hidden'), false);
  assert.equal(document.querySelector('.background-blur-layer__viewport--active'), null);
  assert.equal(document.body.style.overflow, 'auto');
});

test('NFC traps keyboard focus and Escape restores focus to the home shop', () => {
  const view = render(createElement(Fixture, { wallet: walletState() }));
  const home = view.getByRole('button', { name: 'Home action' });
  home.focus();
  act(() => navigate('/nfc'));
  const input = view.getByRole('textbox', { name: 'Receiver Solana address' });
  const claim = view.getByRole('button', { name: 'Claim' });
  assert.equal(document.activeElement, input);
  fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
  assert.equal(document.activeElement, claim);
  fireEvent.keyDown(document, { key: 'Tab' });
  assert.equal(document.activeElement, input);
  home.focus();
  assert.equal(document.activeElement, input);

  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(view.queryByRole('dialog'), null);
  assert.equal(window.location.pathname, '/');
  assert.equal(document.activeElement, home);
});

test('NFC focuses the dialog on touch devices without automatically focusing the address input', () => {
  setMediaQueryMatches('(pointer: coarse)', true);
  const view = renderOverlay();
  const dialog = view.getByRole('dialog', { name: 'NFC claim' });
  assert.equal(document.activeElement, dialog);
  fireEvent.keyDown(document, { key: 'Tab' });
  assert.equal(document.activeElement, view.getByRole('textbox', { name: 'Receiver Solana address' }));
});

test('browser navigation unmounts and remounts NFC without retaining blur on the home route', () => {
  const view = renderOverlay();
  act(() => {
    window.history.replaceState(null, '', '/');
    window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
  });
  assert.equal(view.queryByRole('dialog'), null);
  assert.equal(document.body.style.overflow, '');
  assert.equal(document.querySelector('.background-blur-layer')?.hasAttribute('inert'), false);

  act(() => {
    window.history.replaceState(null, '', '/nfc/?code=returned-code');
    window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
  });
  assert.ok(view.getByRole('dialog', { name: 'NFC claim' }));
  assert.ok(view.getByRole('textbox', { name: 'Receiver Solana address' }));
  assert.equal(document.body.style.overflow, 'hidden');
});
