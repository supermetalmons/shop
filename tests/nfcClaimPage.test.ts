import assert from 'node:assert/strict';
import test, { after, afterEach, mock, type TestContext } from 'node:test';
import { createElement, useSyncExternalStore } from 'react';
import { PublicKey } from '@solana/web3.js';
import type { WalletContextState } from '@solana/wallet-adapter-react';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom, setMediaQueryMatches } = setupFrontendDom();
Object.defineProperty(globalThis, 'Event', { configurable: true, value: dom.window.Event });

const { act, cleanup, fireEvent, render, waitFor, within } = await import('@testing-library/react');
const { WalletContext } = await import('@solana/wallet-adapter-react');
const { WalletModalProvider, useWalletModal } = await import('@solana/wallet-adapter-react-ui');
const { BackgroundBlurPortal, BackgroundBlurProvider } = await import('../src/components/BackgroundBlurLayer.tsx');
const { NfcClaimPage } = await import('../src/components/NfcClaimPage.tsx');
const { ShopHeader } = await import('../src/components/ShopHeader.tsx');
const { WalletModalFocusManager } = await import('../src/wallet/WalletModalFocusManager.tsx');
const { useHomePageScrollRestoration } = await import('../src/hooks/useHomePageScrollRestoration.ts');
const { useOverlayScrollLock } = await import('../src/hooks/useOverlayScrollLock.ts');
const { getNormalizedPathname, navigate, subscribeToNavigation } = await import('../src/navigation.ts');

const walletKey = new PublicKey(new Uint8Array(32).fill(1));

afterEach(() => {
  cleanup();
  mock.restoreAll();
  window.history.replaceState(null, '', '/');
  document.body.style.overflow = '';
  setMediaQueryMatches('(pointer: coarse)', false);
});
after(() => dom.window.close());

function walletState(publicKey: PublicKey | null = null) {
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
  } satisfies WalletContextState;
}

function PageContents() {
  const pathname = useSyncExternalStore(subscribeToNavigation, getNormalizedPathname);
  const { setVisible } = useWalletModal();
  return createElement('div', null,
    createElement(ShopHeader, {
      renderRight: ({ interactive }) => createElement('button', {
        type: 'button',
        tabIndex: interactive ? undefined : -1,
        onClick: interactive ? () => setVisible(true) : undefined,
      }, 'Sign In'),
    }),
    pathname === '/nfc' ? createElement(NfcClaimPage) : createElement('main', null, 'Home shop'),
  );
}

function Fixture({ wallet }: { wallet: WalletContextState }) {
  return createElement(WalletContext.Provider, { value: wallet },
    createElement(BackgroundBlurProvider, null,
      createElement(WalletModalProvider, null,
        createElement(WalletModalFocusManager),
        createElement(PageContents),
      ),
    ),
  );
}

function renderPage(wallet = walletState(), url = '/nfc/?code=STUB-SECRET-CODE') {
  window.history.replaceState(null, '', url);
  return render(createElement(Fixture, { wallet }), { reactStrictMode: true });
}

function assertPageIsUnlocked() {
  assert.notEqual(document.body.style.overflow, 'hidden');
  assert.equal(document.querySelector('[inert]'), null);
  assert.equal(document.querySelector('.background-blur-layer--open'), null);
  assert.equal(document.querySelector('.background-blur-layer__viewport--active'), null);
}

test('NFC always shows Claim without an address or secret-code field', () => {
  for (const url of ['/nfc', '/nfc/', '/nfc/?code=', '/nfc/?code=STUB-SECRET-CODE', '/nfc/?code=secret%20code']) {
    const view = renderPage(walletState(), url);
    assert.equal(view.queryByRole('textbox'), null);
    assert.ok(view.getByRole('button', { name: 'Claim' }));
    assert.ok(view.getByRole('main', { name: 'NFC claim' }));
    assert.equal(view.queryByPlaceholderText('Code'), null);
    assert.equal(view.queryByRole('button', { name: 'Close' }), null);
    assert.equal(window.location.pathname + window.location.search, url);
    view.unmount();
  }
});

test('NFC introduces both NFTs in order and reserves each image aspect ratio before loading', () => {
  const view = renderPage();
  const page = view.getByRole('main', { name: 'NFC claim' });
  assert.ok(within(page).getByRole('heading', { level: 1, name: 'You got 2 NFTs:' }));
  const list = within(page).getByRole('list', { name: 'Your NFTs' });
  const rows = within(list).getAllByRole('listitem');
  const expected = [
    {
      title: 'Mutating Card',
      subtitle: "Evolve it and get it physically delivered when you're ready.",
      src: 'https://wip.lil.org/mutating_card_0.webp',
      width: 805,
      height: 1280,
    },
    {
      title: 'NFC Card Receipt',
      subtitle: 'Proves the authenticity of the physical card you just scanned.',
      src: 'https://wip.lil.org/zero10_certificate_2.webp',
      width: 1254,
      height: 1254,
    },
  ];
  assert.equal(rows.length, expected.length);
  for (const [index, nft] of expected.entries()) {
    const row = within(rows[index]);
    assert.ok(row.getByRole('heading', { name: nft.title }));
    assert.ok(row.getByText(nft.subtitle));
    const image = row.getByRole('img', { name: nft.title }) as HTMLImageElement;
    assert.equal(image.getAttribute('src'), nft.src);
    assert.equal(image.width, nft.width);
    assert.equal(image.height, nft.height);
    assert.equal(image.style.aspectRatio, `${nft.width} / ${nft.height}`);
  }
  assert.ok(list.compareDocumentPosition(view.getByRole('button', { name: 'Claim' })) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
});

test('NFC synchronously opens the video with or without a wallet and never claims or signs', (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({}));
  const open = t.mock.method(window, 'open', () => null);
  for (const [index, publicKey] of [null, walletKey].entries()) {
    const wallet = walletState(publicKey);
    const walletCalls = [wallet.connect, wallet.sendTransaction, wallet.signTransaction, wallet.signAllTransactions, wallet.signMessage];
    const view = renderPage(wallet);
    const claim = view.getByRole('button', { name: 'Claim' }) as HTMLButtonElement;
    assert.equal(view.queryByRole('textbox'), null);
    assert.equal(claim.disabled, false);
    fireEvent.click(claim);
    assert.equal(open.mock.callCount(), index + 1);
    assert.deepEqual(open.mock.calls[index].arguments, [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ', '_blank', 'noopener,noreferrer',
    ]);
    assert.equal(view.queryByRole('alert'), null);
    assert.ok(view.getByRole('main', { name: 'NFC claim' }));
    assert.equal(window.location.pathname + window.location.search, '/nfc/?code=STUB-SECRET-CODE');
    for (const method of walletCalls) assert.equal(method.mock.callCount(), 0);
    view.unmount();
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('NFC uses the shared home header and ordinary focus and scrolling on desktop and touch devices', () => {
  for (const coarsePointer of [false, true]) {
    setMediaQueryMatches('(pointer: coarse)', coarsePointer);
    document.body.style.overflow = 'auto';
    const view = renderPage();
    const home = view.getByRole('link', { name: 'Go to mons.shop home' });
    const claim = view.getByRole('button', { name: 'Claim' });
    assert.ok(view.getByRole('banner'));
    assert.ok(view.getByRole('heading', { name: 'mons.shop' }));
    assert.ok(view.getByRole('button', { name: 'Sign In' }));
    assert.equal(view.queryByRole('dialog'), null);
    assert.notEqual(document.activeElement, claim);
    assert.equal(document.body.style.overflow, 'auto');
    assertPageIsUnlocked();

    claim.focus();
    home.focus();
    assert.equal(document.activeElement, home);
    view.unmount();
  }
});

test('outside clicks and Escape keep the NFC page and its URL', (t) => {
  const view = renderPage();
  view.getByRole('button', { name: 'Claim' }).focus();
  const replaceState = t.mock.method(window.history, 'replaceState');
  const pushState = t.mock.method(window.history, 'pushState');

  fireEvent.click(view.getByRole('main', { name: 'NFC claim' }));
  fireEvent.click(document.querySelector('.background-blur-layer')!);
  fireEvent.click(document.body);
  fireEvent.keyDown(document, { key: 'Escape' });

  assert.ok(view.getByRole('main', { name: 'NFC claim' }));
  assert.equal(window.location.pathname + window.location.search, '/nfc/?code=STUB-SECRET-CODE');
  assert.equal(replaceState.mock.callCount(), 0);
  assert.equal(pushState.mock.callCount(), 0);
  assertPageIsUnlocked();
});

test('the standard header navigates home and browser history restores the NFC page and URL', () => {
  const view = renderPage(walletState(), '/nfc/?code=secret%20code');
  fireEvent.click(view.getByRole('link', { name: 'Go to mons.shop home' }));
  assert.equal(window.location.pathname + window.location.search, '/');
  assert.equal(view.queryByRole('main', { name: 'NFC claim' }), null);
  assert.ok(view.getByText('Home shop'));
  assertPageIsUnlocked();

  act(() => {
    window.history.replaceState(null, '', '/nfc/?code=secret%20code');
    window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
  });
  assert.ok(view.getByRole('main', { name: 'NFC claim' }));
  assert.equal(window.location.pathname + window.location.search, '/nfc/?code=secret%20code');
  assertPageIsUnlocked();

  act(() => {
    window.history.replaceState(null, '', '/');
    window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
  });
  assert.equal(view.queryByRole('main', { name: 'NFC claim' }), null);
  assert.ok(view.getByText('Home shop'));
  assertPageIsUnlocked();
});

test('opening and reopening the sign-in picker prepares its accessible title and preserves the NFC page', async (t) => {
  const viewport = controlledViewport(t, 0);
  document.body.style.overflow = 'auto';
  const view = renderPage();
  const claim = view.getByRole('button', { name: 'Claim' });
  const connect = view.getByRole('button', { name: 'Sign In' });
  connect.focus();
  fireEvent.click(connect);

  const dialog = view.getByRole('dialog');
  const close = dialog.querySelector<HTMLButtonElement>('.wallet-adapter-modal-button-close')!;
  close.focus();
  viewport.flushFrame();

  assert.equal(view.getByRole('dialog', { name: 'Sign In' }), dialog);
  assert.ok(within(dialog).getByRole('heading', { name: 'Sign In' }));
  assert.equal(within(dialog).getByRole('button', { name: 'Close sign-in dialog' }), close);
  assert.equal(document.activeElement, close);
  fireEvent.keyDown(close, { key: 'Tab' });
  assert.equal(document.activeElement, close);
  assert.equal(document.body.style.overflow, 'hidden');
  assert.ok(document.querySelector('.background-blur-layer__viewport--active'));
  assert.ok(claim.isConnected);
  assert.equal(window.location.pathname + window.location.search, '/nfc/?code=STUB-SECRET-CODE');

  fireEvent.keyDown(window, { key: 'Escape' });
  await waitFor(() => {
    if (view.queryByRole('dialog')) throw new Error('Wallet picker has not closed yet');
  });
  assert.ok(view.getByRole('main', { name: 'NFC claim' }));
  assert.equal(view.getByRole('button', { name: 'Claim' }), claim);
  assert.equal(window.location.pathname + window.location.search, '/nfc/?code=STUB-SECRET-CODE');
  assert.equal(document.body.style.overflow, 'auto');
  assertPageIsUnlocked();

  fireEvent.click(connect);
  viewport.flushFrame();
  const reopened = view.getByRole('dialog', { name: 'Sign In' });
  assert.notEqual(reopened, dialog);
  assert.ok(within(reopened).getByRole('heading', { name: 'Sign In' }));
  fireEvent.click(within(reopened).getByRole('button', { name: 'Close sign-in dialog' }));
  await waitFor(() => {
    if (view.queryByRole('dialog')) throw new Error('Wallet picker has not closed yet');
  });
  assert.equal(view.getByRole('button', { name: 'Claim' }), claim);
  assertPageIsUnlocked();
});

test('entering NFC waits for an open wallet picker before resetting scroll, and later picker use preserves scroll', async (t) => {
  const viewport = controlledViewport(t, 600);
  document.body.style.overflow = 'auto';
  const view = renderPage(walletState(), '/');
  fireEvent.click(view.getByRole('button', { name: 'Sign In' }));
  assert.ok(view.getByRole('dialog'));

  act(() => navigate('/nfc'));
  viewport.flushFrame();
  assert.ok(view.getByRole('dialog'));
  assert.equal(document.body.style.overflow, 'hidden');
  assert.equal(window.scrollY, 600);

  fireEvent.keyDown(window, { key: 'Escape' });
  await waitFor(() => {
    if (view.queryByRole('dialog')) throw new Error('Wallet picker has not closed yet');
  });
  assert.ok(view.getByRole('main', { name: 'NFC claim' }));
  assert.equal(window.location.pathname, '/nfc');
  assert.equal(document.body.style.overflow, 'auto');
  viewport.flushFrame();
  assert.equal(window.scrollY, 0);
  assertPageIsUnlocked();

  viewport.setScrollY(350);
  fireEvent.click(view.getByRole('button', { name: 'Sign In' }));
  viewport.flushFrame();
  fireEvent.keyDown(window, { key: 'Escape' });
  await waitFor(() => {
    if (view.queryByRole('dialog')) throw new Error('Wallet picker has not closed yet');
  });
  viewport.flushFrame();
  assert.equal(window.scrollY, 350);
  assertPageIsUnlocked();
});

function controlledViewport(t: TestContext, initialScroll: number) {
  let scrollY = initialScroll;
  let frameId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const scrollDescriptor = Object.getOwnPropertyDescriptor(window, 'scrollY')!;
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
  t.after(() => Object.defineProperty(window, 'scrollY', scrollDescriptor));
  t.mock.method(window, 'scrollTo', (options: ScrollToOptions | number, y?: number) => {
    scrollY = typeof options === 'number' ? y ?? 0 : options.top ?? scrollY;
  });
  t.mock.method(window, 'requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  t.mock.method(window, 'cancelAnimationFrame', (id: number) => frames.delete(id));
  return {
    setScrollY(value: number) { scrollY = value; },
    flushFrame() {
      act(() => {
        const pending = [...frames.values()];
        frames.clear();
        for (const callback of pending) callback(0);
      });
    },
  };
}

test('NFC starts at the top after the previous inventory viewer restores its scroll position', (t) => {
  const viewport = controlledViewport(t, 600);
  function Contents({ path }: { path: string }) {
    useHomePageScrollRestoration(path);
    const viewerOpen = path === '/';
    useOverlayScrollLock({ active: viewerOpen });
    return createElement('div', null,
      createElement(ShopHeader),
      viewerOpen ? createElement('main', null, 'Inventory') : createElement(NfcClaimPage),
      createElement(BackgroundBlurPortal, { open: viewerOpen, active: viewerOpen,
        children: createElement('div', { role: 'dialog' }, 'Inventory viewer'),
      }),
    );
  }
  function ScrollFixture({ path }: { path: string }) {
    return createElement(WalletContext.Provider, { value: walletState() },
      createElement(BackgroundBlurProvider, null,
        createElement(WalletModalProvider, null, createElement(Contents, { path })),
      ),
    );
  }
  const view = render(createElement(ScrollFixture, { path: '/' }), { reactStrictMode: true });
  assert.ok(view.getByRole('dialog'));
  assert.equal(window.scrollY, 600);

  view.rerender(createElement(ScrollFixture, { path: '/nfc' }));
  assert.equal(view.queryByRole('dialog'), null);
  assertPageIsUnlocked();
  assert.equal(window.scrollY, 600);
  viewport.flushFrame();
  assert.equal(window.scrollY, 0);
  viewport.flushFrame();
  assert.equal(window.scrollY, 0);
  assert.notEqual(document.activeElement, view.getByRole('button', { name: 'Claim' }));
});

test('leaving NFC before its initial frame cancels the pending scroll reset', (t) => {
  const viewport = controlledViewport(t, 600);
  const view = renderPage();
  act(() => navigate('/'));
  assert.equal(view.queryByRole('main', { name: 'NFC claim' }), null);
  viewport.setScrollY(320);
  viewport.flushFrame();
  assert.equal(window.scrollY, 320);
  assertPageIsUnlocked();
});
