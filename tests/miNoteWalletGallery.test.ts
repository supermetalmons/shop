import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { afterEach, beforeEach } from 'node:test';
import { createElement, Profiler } from 'react';
import { getPreorderConfig, type PreorderAvailabilityResponse } from '../shared/preorders.ts';
import type { createPreorderApi } from '../src/lib/preorderApi.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

let { dom } = setupFrontendDom();
const { act, cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const cssImports = registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context);
} });
const { default: MiNoteCardsGallery } = await import('../src/components/MiNoteCardsGallery.tsx');
const { useMiNoteEthereumWallet } = await import('../src/hooks/useMiNoteEthereumWallet.ts');
const { useMiNoteVerification } = await import('../src/hooks/useMiNoteVerification.ts');
const { usePreorderCheckout } = await import('../src/hooks/usePreorderCheckout.ts');
const { listInjectedEthereumProviders } = await import('../src/wallet/injectedEthereumProviders.ts');
cssImports.deregister();
dom.window.close();

const ADDRESS = '0xe26067c76fdbe877f48b0a8400cf5db8b47af0fe';
const OTHER_ADDRESS = '0x5bfce4149f520fe0823dc8c0afaf979121e824ec';
const DISPLAY_ADDRESS = '0xE26067c76fdbe877F48b0a8400cf5Db8B47aF0fE';
const OTHER_DISPLAY_ADDRESS = '0x5BFce4149F520FE0823Dc8C0aFaF979121e824EC';
const ADMIN = 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz';
const SIGNATURE = `0x${'12'.repeat(65)}`;
const config = getPreorderConfig('mi_note_cards_devnet')!;
const originalFetch = globalThis.fetch;
beforeEach(() => { ({ dom } = setupFrontendDom()); });
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function provider(initialAddress = ADDRESS) {
  let address = initialAddress;
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const calls: string[] = [];
  const responses: Partial<Record<string, () => Promise<unknown>>> = {};
  return {
    calls, responses,
    request: async ({ method }: { method: string }) => {
      calls.push(method);
      if (responses[method]) return responses[method]();
      if (method === 'eth_chainId') return '0x1';
      if (method === 'personal_sign') return SIGNATURE;
      return [address];
    },
    on(name: string, listener: (...args: unknown[]) => void) {
      const group = listeners.get(name) ?? new Set(); group.add(listener); listeners.set(name, group);
    },
    removeListener(name: string, listener: (...args: unknown[]) => void) { listeners.get(name)?.delete(listener); },
    change(next: string) { address = next; listeners.get('accountsChanged')?.forEach(listener => listener([next])); },
  };
}

function rig() {
  let challenged = ADDRESS;
  let challengedPreorder = config.preorderId;
  let ownershipStatus: 'success' | 'partial' = 'success';
  let lookupCount = 0;
  let logoutCount = 0;
  const authCalls: string[] = [];
  const responses: Partial<Record<string, (response: Response) => Promise<Response>>> = {};
  globalThis.fetch = async (input, init) => {
    assert.equal(new Headers(init?.headers).get('X-Mons-CSRF'), '1');
    const action = String(input).split('/').at(-1)!;
    authCalls.push(action);
    let response: Response;
    if (action === 'challenge') {
      const body = JSON.parse(String(init?.body));
      challenged = body.address;
      challengedPreorder = body.preorderId;
      response = Response.json({ challengeId: 'challenge', message: 'Verify Mi Note ownership', expiresAtMs: Date.now() + 300_000 });
    } else if (action === 'verify') {
      response = Response.json({ token: `verified-${challenged}`, address: challenged,
        preorderId: challengedPreorder, expiresAtMs: Date.now() + 3_600_000 });
    } else {
      logoutCount += 1;
      response = Response.json({ ok: true });
    }
    return responses[action] ? responses[action](response) : response;
  };
  const forbidden = async (): Promise<never> => { throw new Error('Viewing must not start a purchase'); };
  const api: ReturnType<typeof createPreorderApi> = {
    availability: async (preorderId, session, signedIn) => {
      lookupCount += 1;
      const start = session.address === ADDRESS ? 1 : 11;
      return { preorderId, ethereumAddress: session.address, ownershipStatus, requiresAdminSignIn: !signedIn,
        items: signedIn ? Array.from({ length: 10 }, (_, index) => ({ id: start + index, status: 'available' })) : [],
      } satisfies PreorderAvailabilityResponse;
    },
    prepare: forbidden, submit: forbidden, cancel: forbidden, status: async () => ({ order: null }),
  };
  function Harness({ admin = false, preorderId = config.preorderId }: { admin?: boolean; preorderId?: string }) {
    const collection = getPreorderConfig(preorderId)!;
    const wallet = useMiNoteEthereumWallet(true);
    const verification = useMiNoteVerification(true, collection.preorderId, wallet);
    const preorder = usePreorderCheckout({ config: collection, active: true, buyer: admin ? ADMIN : undefined, signedIn: admin,
      ethereumSession: verification.session, onEthereumSessionInvalid: verification.invalidate,
      signTransaction: undefined, ensureSignedIn: async () => false, onSucceeded: () => {},
    }, api);
    return createElement(MiNoteCardsGallery, { preorder, wallet, verification, onAdminSignIn: async () => {} });
  }
  return { Harness, authCalls, responses, get lookupCount() { return lookupCount; }, get logoutCount() { return logoutCount; },
    partial: () => { ownershipStatus = 'partial'; }, complete: () => { ownershipStatus = 'success'; } };
}

async function connectAndVerify(view: ReturnType<typeof render>) {
  fireEvent.click(view.getByRole('button', { name: 'Connect Ethereum Wallet' }));
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Disconnect' })));
  assertIntroduction(view, false);
}

function assertIntroduction(view: ReturnType<typeof render>, visible: boolean) {
  assert.equal(Boolean(view.queryByRole('heading', { name: 'Preorder Mi Note Cards' })), visible);
  for (const text of [
    'One unique card for each Mi Note.',
    'Preorders are open until October 8.',
    'Cards reveal and public mint for the remaining cards on October 9.',
  ]) assert.equal(Boolean(view.queryByText(text)), visible);
}

function assertUnsigned(view: ReturnType<typeof render>) {
  assert.equal(view.queryByRole('button', { name: 'Disconnect' }), null);
  assert.equal(view.container.querySelector('.mi-note-cards__address'), null);
  assert.equal(view.queryByRole('alert'), null);
  assert.equal(view.queryByText(/Sign a message|Check your wallet|Reconnecting wallet|Verify Ethereum Wallet/), null);
}

function assertConnecting(view: ReturnType<typeof render>) {
  assert.equal((view.getByRole('button', { name: 'Connecting...' }) as HTMLButtonElement).disabled, true);
  assertIntroduction(view, true);
  assert.equal(view.queryByRole('status'), null);
  assertUnsigned(view);
}

function installPicker(...wallets: ReturnType<typeof provider>[]) {
  window.addEventListener('eip6963:requestProvider', () => {
    for (const [index, wallet] of wallets.entries()) window.dispatchEvent(new dom.window.CustomEvent('eip6963:announceProvider', {
      detail: { provider: wallet, info: { uuid: String(index), name: `Wallet ${index}`, rdns: `wallet.${index}`, icon: '' } },
    }));
  });
}

test('Ethereum verifies before listings; admin sign-in refreshes test IDs and changing ETH clears cards', async () => {
  const wallet = provider(); Object.assign(window, { ethereum: wallet });
  const context = rig();
  const view = render(createElement(context.Harness));
  assert.equal(view.queryByRole('img'), null);
  assert.equal(context.lookupCount, 0);
  await connectAndVerify(view);
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Sign in with Solana' })));
  assert.deepEqual(context.authCalls, ['challenge', 'verify']);
  assert.deepEqual(wallet.calls, ['eth_requestAccounts', 'eth_chainId', 'personal_sign', 'eth_accounts']);
  assert.equal(view.queryByRole('img'), null);
  view.rerender(createElement(context.Harness, { admin: true }));
  await waitFor(() => assert.equal(view.getAllByRole('img').length, 10));
  assert.ok(view.getByRole('button', { name: /Select preorder #1:/ }));
  act(() => wallet.change(OTHER_ADDRESS));
  assert.equal(view.queryByRole('img'), null);
  assertUnsigned(view);
  assert.equal(wallet.calls.filter(call => call === 'personal_sign').length, 1);
  fireEvent.click(view.getByRole('button', { name: 'Connect Ethereum Wallet' }));
  await waitFor(() => assert.ok(view.getByRole('button', { name: /Select preorder #11:/ })));
  assert.equal(view.queryByRole('button', { name: /Select preorder #1:/ }), null);
});

test('partial ownership keeps eligible cards and retry replaces the partial status', async () => {
  const wallet = provider(); Object.assign(window, { ethereum: wallet });
  const context = rig(); context.partial();
  const view = render(createElement(context.Harness, { admin: true }));
  await connectAndVerify(view);
  await waitFor(() => assert.ok(view.getByText('Some cards couldn’t be loaded.')));
  assert.equal(view.getAllByRole('img').length, 10);
  context.complete(); fireEvent.click(view.getByRole('button', { name: 'Try again' }));
  await waitFor(() => assert.ok(!view.queryByText('Some cards couldn’t be loaded.')));
});

test('reload restores a matching verified wallet quietly and disconnect prevents future restoration', async () => {
  const wallet = provider(); Object.assign(window, { ethereum: wallet });
  const context = rig();
  const first = render(createElement(context.Harness, { admin: true }));
  await connectAndVerify(first);
  await waitFor(() => assert.equal(first.getAllByRole('img').length, 10));
  first.unmount();
  const restored = render(createElement(context.Harness, { admin: true }), { reactStrictMode: true });
  await waitFor(() => assert.equal(restored.getAllByRole('img').length, 10));
  assertIntroduction(restored, false);
  assert.equal(wallet.calls.filter(call => call === 'personal_sign').length, 1);
  await act(async () => fireEvent.click(restored.getByRole('button', { name: 'Disconnect' })));
  assert.equal(restored.queryByRole('img'), null);
  assertIntroduction(restored, true);
  await waitFor(() => assert.equal(context.logoutCount, 1));
  restored.unmount();
  const disconnected = await act(async () => render(createElement(context.Harness, { admin: true })));
  assert.ok(disconnected.getByRole('button', { name: 'Connect Ethereum Wallet' }));
  assertIntroduction(disconnected, true);
});

test('wallet picker remains inline and supports cancellation and provider selection', async () => {
  const one = provider(); const two = provider(OTHER_ADDRESS);
  const context = rig();
  installPicker(one, two);
  const view = render(createElement(context.Harness, { admin: true }));
  fireEvent.click(view.getByRole('button', { name: 'Connect Ethereum Wallet' }));
  await waitFor(() => assert.ok(document.activeElement === view.getByRole('button', { name: 'Wallet 0' })));
  assertIntroduction(view, false);
  fireEvent.keyDown(view.getByRole('button', { name: 'Wallet 0' }), { key: 'Escape' });
  assert.ok(view.getByRole('button', { name: 'Connect Ethereum Wallet' }));
  assertIntroduction(view, true);
  assert.deepEqual(context.authCalls, []);
  assert.equal(one.calls.length + two.calls.length, 0);
  fireEvent.click(view.getByRole('button', { name: 'Connect Ethereum Wallet' }));
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Wallet 1' })));
  assertIntroduction(view, false);
  fireEvent.click(view.getByRole('button', { name: 'Wallet 1' }));
  await waitFor(() => assert.ok(view.getByRole('button', { name: /Select preorder #11:/ })));
  assert.equal(one.calls.length, 0);
  assert.equal(two.calls.filter(call => call === 'personal_sign').length, 1);
});

test('a rejected wallet selected from the picker restores focus to Connect', async () => {
  const one = provider(); const two = provider();
  one.responses.eth_requestAccounts = async () => { throw { code: 4001 }; };
  installPicker(one, two);
  const context = rig();
  const view = render(createElement(context.Harness));
  fireEvent.click(view.getByRole('button', { name: 'Connect Ethereum Wallet' }));
  await waitFor(() => assert.ok(document.activeElement === view.getByRole('button', { name: 'Wallet 0' })));
  fireEvent.click(view.getByRole('button', { name: 'Wallet 0' }));
  await waitFor(() => assert.ok(document.activeElement === view.getByRole('button', { name: 'Connect Ethereum Wallet' })));
  assertIntroduction(view, true);
  assertUnsigned(view);
});

for (const preorderId of ['mi_note_cards', 'mi_note_cards_devnet']) {
  test(`${preorderId} keeps one Connecting button through every authentication phase`, async () => {
    const accounts = deferred<unknown>(); const signature = deferred<unknown>();
    const challenge = deferred<void>(); const verification = deferred<void>();
    const wallet = provider(); Object.assign(window, { ethereum: wallet });
    wallet.responses.eth_requestAccounts = () => accounts.promise;
    wallet.responses.personal_sign = () => signature.promise;
    const context = rig();
    context.responses.challenge = async response => { await challenge.promise; return response; };
    context.responses.verify = async response => { await verification.promise; return response; };
    const view = render(createElement(context.Harness, { admin: true, preorderId }));
    assertIntroduction(view, true);
    fireEvent.click(view.getByRole('button', { name: 'Connect Ethereum Wallet' }));
    assertConnecting(view);
    await waitFor(() => assert.deepEqual(wallet.calls, ['eth_requestAccounts']));
    assertConnecting(view);
    await act(async () => accounts.resolve([ADDRESS]));
    await waitFor(() => assert.deepEqual(context.authCalls, ['challenge']));
    assertConnecting(view);
    await act(async () => challenge.resolve());
    await waitFor(() => assert.ok(wallet.calls.includes('personal_sign')));
    assertConnecting(view);
    await act(async () => signature.resolve(SIGNATURE));
    await waitFor(() => assert.deepEqual(context.authCalls, ['challenge', 'verify']));
    assertConnecting(view);
    assert.equal(context.lookupCount, 0);
    await act(async () => verification.resolve());
    await waitFor(() => assert.equal(view.getAllByRole('img').length, 10));
    assert.ok(view.getByRole('button', { name: 'Disconnect' }));
    assert.ok(view.getByTitle(DISPLAY_ADDRESS));
    assert.equal(view.queryByRole('button', { name: /Connect/ }), null);
    assertIntroduction(view, false);
    assert.deepEqual(wallet.calls, ['eth_requestAccounts', 'eth_chainId', 'personal_sign', 'eth_accounts']);
  });
}

for (const failure of ['connection', 'network', 'signature rejected', 'signature already pending', 'challenge', 'verification'] as const) {
  test(`${failure} fails silently and Connect retries the extension's current account`, async () => {
    const wallet = provider(); Object.assign(window, { ethereum: wallet });
    const context = rig();
    if (failure === 'connection') wallet.responses.eth_requestAccounts = async () => { throw { code: 4001 }; };
    if (failure === 'network') wallet.responses.eth_chainId = async () => null;
    if (failure.startsWith('signature')) wallet.responses.personal_sign = async () => {
      throw { code: failure === 'signature rejected' ? 4001 : -32002 };
    };
    if (failure === 'challenge' || failure === 'verification') {
      context.responses[failure === 'challenge' ? 'challenge' : 'verify'] = async () => Response.json({
        error: { code: 'unavailable', message: 'Authentication service unavailable' },
      }, { status: 503 });
    }
    const view = render(createElement(context.Harness, { admin: true }));
    fireEvent.click(view.getByRole('button', { name: 'Connect Ethereum Wallet' }));
    await waitFor(() => assert.equal((view.getByRole('button', { name: 'Connect Ethereum Wallet' }) as HTMLButtonElement).disabled, false));
    assertUnsigned(view);
    assert.equal(context.lookupCount, 0);
    const signCount = wallet.calls.filter(call => call === 'personal_sign').length;
    act(() => wallet.change(OTHER_ADDRESS));
    assert.equal(wallet.calls.filter(call => call === 'personal_sign').length, signCount);
    assertUnsigned(view);
    for (const method of Object.keys(wallet.responses)) delete wallet.responses[method];
    for (const action of Object.keys(context.responses)) delete context.responses[action];
    await connectAndVerify(view);
    await waitFor(() => assert.ok(view.getByRole('button', { name: /Select preorder #11:/ })));
    assert.equal(wallet.calls.filter(call => call === 'eth_requestAccounts').length, failure === 'connection' ? 2 : 1);
    assert.ok(view.getByTitle(OTHER_DISPLAY_ADDRESS));
  });
}

test('an immediate retry after connection rejection keeps its sign-in intent', async () => {
  const wallet = provider(); Object.assign(window, { ethereum: wallet });
  wallet.responses.eth_requestAccounts = async () => { throw { code: 4001 }; };
  const context = rig();
  let retried = false;
  const view = render(createElement(Profiler, { id: 'connection-retry', onRender: () => {
    if (retried || wallet.calls.length !== 1) return;
    const button = Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Connect Ethereum Wallet');
    if (!button || button.disabled) return;
    retried = true;
    delete wallet.responses.eth_requestAccounts;
    button.click();
  } }, createElement(context.Harness, { admin: true })));
  fireEvent.click(view.getByRole('button', { name: 'Connect Ethereum Wallet' }));
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Disconnect' })));
  assert.equal(retried, true);
  assert.deepEqual(wallet.calls, ['eth_requestAccounts', 'eth_requestAccounts', 'eth_chainId', 'personal_sign', 'eth_accounts']);
  assert.deepEqual(context.authCalls, ['challenge', 'verify']);
});

test('Connect refreshes a request-only provider after rejection and signs its newly selected account', async () => {
  const wallet = provider(); Object.assign(window, { ethereum: { request: wallet.request } });
  wallet.responses.personal_sign = async () => { throw { code: 4001 }; };
  const context = rig();
  const view = render(createElement(context.Harness, { admin: true }));
  fireEvent.click(view.getByRole('button', { name: 'Connect Ethereum Wallet' }));
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Connect Ethereum Wallet' })));
  assertUnsigned(view);
  assert.deepEqual(wallet.calls, ['eth_requestAccounts', 'eth_chainId', 'personal_sign']);
  delete wallet.responses.personal_sign;
  wallet.change(OTHER_ADDRESS);
  await connectAndVerify(view);
  await waitFor(() => assert.ok(view.getByRole('button', { name: /Select preorder #11:/ })));
  assert.ok(view.getByTitle(OTHER_DISPLAY_ADDRESS));
  assert.deepEqual(wallet.calls.slice(3), ['eth_accounts', 'eth_chainId', 'personal_sign', 'eth_accounts']);
});

test('missing wallet returns silently to the enabled Connect button', async () => {
  const context = rig();
  const view = render(createElement(context.Harness));
  fireEvent.click(view.getByRole('button', { name: 'Connect Ethereum Wallet' }));
  await waitFor(() => assert.equal((view.getByRole('button', { name: 'Connect Ethereum Wallet' }) as HTMLButtonElement).disabled, false));
  assertUnsigned(view);
  assert.deepEqual(context.authCalls, []);
});

for (const savedSession of ['missing', 'expired', 'different collection']) {
  test(`passive restoration with ${savedSession} verification waits for an explicit Connect click`, async () => {
    const wallet = provider(); Object.assign(window, { ethereum: wallet });
    window.localStorage.setItem('mons.shop.mi-note.ethereum-wallet', JSON.stringify({ type: 'legacy' }));
    if (savedSession !== 'missing') window.sessionStorage.setItem('mons.shop.mi-note.ethereum-session', JSON.stringify({
      token: 'saved-session', address: ADDRESS,
      preorderId: savedSession === 'different collection' ? 'mi_note_cards' : config.preorderId,
      expiresAtMs: Date.now() + (savedSession === 'expired' ? -1 : 3_600_000),
    }));
    const context = rig();
    const view = render(createElement(context.Harness, { admin: true }), { reactStrictMode: true });
    assertConnecting(view);
    await waitFor(() => assert.equal((view.getByRole('button', { name: 'Connect Ethereum Wallet' }) as HTMLButtonElement).disabled, false));
    assertUnsigned(view);
    assert.deepEqual(wallet.calls, ['eth_accounts']);
    assert.deepEqual(context.authCalls, []);
    await connectAndVerify(view);
    assert.equal(wallet.calls.filter(call => call === 'eth_requestAccounts').length, 0);
    assert.equal(wallet.calls.filter(call => call === 'personal_sign').length, 1);
  });
}

test('Connect reuses stored verification after passive wallet restoration fails', async () => {
  const wallet = provider(); Object.assign(window, { ethereum: wallet });
  wallet.responses.eth_accounts = async () => { throw new Error('Wallet locked'); };
  const session = { token: 'saved-session', address: ADDRESS, preorderId: config.preorderId, expiresAtMs: Date.now() + 3_600_000 };
  window.localStorage.setItem('mons.shop.mi-note.ethereum-wallet', JSON.stringify({ type: 'legacy' }));
  window.sessionStorage.setItem('mons.shop.mi-note.ethereum-session', JSON.stringify(session));
  const context = rig();
  const view = render(createElement(context.Harness, { admin: true }));
  await waitFor(() => assert.equal((view.getByRole('button', { name: 'Connect Ethereum Wallet' }) as HTMLButtonElement).disabled, false));
  assertUnsigned(view);
  assert.deepEqual(JSON.parse(window.sessionStorage.getItem('mons.shop.mi-note.ethereum-session')!), session);
  delete wallet.responses.eth_accounts;
  await connectAndVerify(view);
  await waitFor(() => assert.equal(view.getAllByRole('img').length, 10));
  assert.deepEqual(wallet.calls, ['eth_accounts', 'eth_requestAccounts']);
  assert.deepEqual(context.authCalls, []);
  assert.deepEqual(JSON.parse(window.sessionStorage.getItem('mons.shop.mi-note.ethereum-session')!), session);
});

test('StrictMode and repeated clicks still run a single connection and signature', async () => {
  const signed = deferred<unknown>();
  const wallet = provider(); Object.assign(window, { ethereum: wallet });
  wallet.responses.personal_sign = () => signed.promise;
  const context = rig();
  const view = render(createElement(context.Harness, { admin: true }), { reactStrictMode: true });
  const connect = view.getByRole('button', { name: 'Connect Ethereum Wallet' });
  act(() => { fireEvent.click(connect); fireEvent.click(connect); });
  await waitFor(() => assert.ok(wallet.calls.includes('personal_sign')));
  assertConnecting(view);
  fireEvent.click(view.getByRole('button', { name: 'Connecting...' }));
  await act(async () => signed.resolve(SIGNATURE));
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Disconnect' })));
  assert.deepEqual(wallet.calls, ['eth_requestAccounts', 'eth_chainId', 'personal_sign', 'eth_accounts']);
  assert.deepEqual(context.authCalls, ['challenge', 'verify']);
});

for (const stage of ['discovery', 'picker'] as const) {
  test(`changing collections during ${stage} cancels the previous connection intent`, async () => {
    const one = provider(); const two = provider(OTHER_ADDRESS);
    installPicker(one, two);
    const context = rig();
    const view = render(createElement(context.Harness, { admin: true }));
    fireEvent.click(view.getByRole('button', { name: 'Connect Ethereum Wallet' }));
    if (stage === 'picker') await waitFor(() => assert.ok(view.getByRole('button', { name: 'Wallet 0' })));
    view.rerender(createElement(context.Harness, { admin: true, preorderId: 'mi_note_cards' }));
    await act(async () => { await listInjectedEthereumProviders(); });
    assert.ok(view.getByRole('button', { name: 'Connect Ethereum Wallet' }));
    assert.equal(view.queryByRole('group', { name: 'Select Ethereum wallet' }), null);
    assert.equal(one.calls.length + two.calls.length, 0);
    assert.deepEqual(context.authCalls, []);
    fireEvent.click(view.getByRole('button', { name: 'Connect Ethereum Wallet' }));
    await waitFor(() => assert.ok(view.getByRole('button', { name: 'Wallet 1' })));
    fireEvent.click(view.getByRole('button', { name: 'Wallet 1' }));
    await waitFor(() => assert.ok(view.getByRole('button', { name: /Select preorder #11:/ })));
    assert.equal(one.calls.length, 0);
    assert.equal(two.calls.filter(call => call === 'personal_sign').length, 1);
  });
}

test('cancelled account refresh preserves the established wallet and saved verification', async () => {
  const wallet = provider(); Object.assign(window, { ethereum: wallet });
  const context = rig();
  const view = render(createElement(context.Harness, { admin: true }));
  await connectAndVerify(view);
  const session = window.sessionStorage.getItem('mons.shop.mi-note.ethereum-session');
  view.rerender(createElement(context.Harness, { admin: true, preorderId: 'mi_note_cards' }));
  const accounts = deferred<unknown>();
  wallet.responses.eth_accounts = () => accounts.promise;
  fireEvent.click(view.getByRole('button', { name: 'Connect Ethereum Wallet' }));
  assertConnecting(view);
  view.rerender(createElement(context.Harness, { admin: true }));
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Disconnect' })));
  await waitFor(() => assert.equal(view.getAllByRole('img').length, 10));
  assert.ok(view.getByTitle(DISPLAY_ADDRESS));
  await act(async () => accounts.resolve([OTHER_ADDRESS]));
  assert.ok(view.getByTitle(DISPLAY_ADDRESS));
  assert.equal(window.sessionStorage.getItem('mons.shop.mi-note.ethereum-session'), session);
  assert.deepEqual(context.authCalls, ['challenge', 'verify']);
  await act(async () => wallet.change(OTHER_ADDRESS));
  assertUnsigned(view);
  assert.equal(view.queryByRole('img'), null);
  assert.equal(context.logoutCount, 1);
  assert.equal(wallet.calls.filter(call => call === 'personal_sign').length, 1);
});

for (const stage of ['accounts', 'signature', 'verification'] as const) {
  test(`changing collections during ${stage} ignores the old result and waits for Connect`, async () => {
    const pending = deferred<unknown>();
    const wallet = provider(); Object.assign(window, { ethereum: wallet });
    const context = rig();
    if (stage === 'accounts') wallet.responses.eth_requestAccounts = () => pending.promise;
    else if (stage === 'signature') wallet.responses.personal_sign = () => pending.promise;
    else context.responses.verify = async response => { await pending.promise; return response; };
    const view = render(createElement(context.Harness, { admin: true }));
    fireEvent.click(view.getByRole('button', { name: 'Connect Ethereum Wallet' }));
    await waitFor(() => assert.ok(stage === 'verification' ? context.authCalls.includes('verify')
      : wallet.calls.includes(stage === 'accounts' ? 'eth_requestAccounts' : 'personal_sign')));
    view.rerender(createElement(context.Harness, { admin: true, preorderId: 'mi_note_cards' }));
    assert.equal((view.getByRole('button', { name: 'Connect Ethereum Wallet' }) as HTMLButtonElement).disabled, false);
    assertUnsigned(view);
    await act(async () => pending.resolve(stage === 'accounts' ? [ADDRESS] : SIGNATURE));
    if (stage === 'verification') await waitFor(() => assert.equal(context.logoutCount, 1));
    assertUnsigned(view);
    assert.equal(context.lookupCount, 0);
    assert.equal(context.authCalls.filter(action => action === 'verify').length, stage === 'verification' ? 1 : 0);
    for (const method of Object.keys(wallet.responses)) delete wallet.responses[method];
    delete context.responses.verify;
    await connectAndVerify(view);
    await waitFor(() => assert.equal(view.getAllByRole('img').length, 10));
    assert.equal(wallet.calls.filter(call => call === 'eth_requestAccounts').length, stage === 'accounts' ? 2 : 1);
    assert.equal(wallet.calls.filter(call => call === 'personal_sign').length, stage === 'accounts' ? 1 : 2);
  });
}
