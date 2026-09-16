import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { afterEach, beforeEach } from 'node:test';
import { createElement } from 'react';
import miNoteCollections from '../mi_note_eth.json';
import {
  MI_NOTE_CONTRACT_ADDRESSES,
  MI_NOTE_CONTRACT_ADDRESS,
  type MiNoteCardsResponse,
} from '../shared/miNoteCards.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

let { dom } = setupFrontendDom();
const { act, cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const cssImports = registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith('.css')
      ? { format: 'module', source: '', shortCircuit: true }
      : nextLoad(url, context);
  },
});
const { default: MiNoteCardsGallery } = await import('../src/components/MiNoteCardsGallery.tsx');
cssImports.deregister();
dom.window.close();

const ADDRESS = '0x000533f50ddd7f2fc4EfD06137b0c1A12CfB7Bb9';
const OTHER_ADDRESS = '0x1111111111111111111111111111111111111111';
const CARD = miNoteCollections.find(({ contractAddress }) => contractAddress === MI_NOTE_CONTRACT_ADDRESSES[0])!.tokens[0];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  ({ dom } = setupFrontendDom());
  window.history.replaceState(null, '', '/mi_note_cards');
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  dom.window.close();
});

function provider(accounts = [ADDRESS]) {
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  const calls: string[] = [];
  return {
    calls,
    request: async ({ method }: { method: string }) => {
      calls.push(method);
      return accounts;
    },
    on: (name: string, listener: (value: unknown) => void) => {
      const group = listeners.get(name) ?? new Set();
      group.add(listener);
      listeners.set(name, group);
    },
    removeListener: (name: string, listener: (value: unknown) => void) => listeners.get(name)?.delete(listener),
    emit: (name: string, value: unknown) => {
      if (name === 'accountsChanged') accounts = value as string[];
      listeners.get(name)?.forEach((listener) => listener(value));
    },
  };
}

function captureRequests() {
  const requests: Array<{ url: string; signal: AbortSignal; resolve: (response: Response) => void }> = [];
  globalThis.fetch = ((input, init) => new Promise<Response>((resolve) => {
    requests.push({ url: String(input), signal: init!.signal!, resolve });
  })) as typeof fetch;
  return requests;
}

function holdings(withCard = true): MiNoteCardsResponse {
  return {
    ok: true,
    tokenIdsByContract: Object.fromEntries(MI_NOTE_CONTRACT_ADDRESSES.map((contract, index) => [contract, index === 0 && withCard ? [CARD.id] : []])),
    resultsByContract: Object.fromEntries(MI_NOTE_CONTRACT_ADDRESSES.map((contract) => [contract, {
      status: 'success',
      provider: contract === MI_NOTE_CONTRACT_ADDRESS ? 'opensea' : 'alchemy',
      visibilityLimited: contract === MI_NOTE_CONTRACT_ADDRESS,
    }])),
  } as MiNoteCardsResponse;
}

function gallery() {
  return render(createElement(MiNoteCardsGallery, { onNotify: () => {} }));
}

async function connect(view: ReturnType<typeof gallery>) {
  fireEvent.click(view.getByRole('tab', { name: 'Your' }));
  fireEvent.click(view.getByRole('button', { name: 'Connect Ethereum Wallet' }));
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Disconnect' })));
}

test('connecting in Your loads holdings, account changes discard old cards, and All retains its sample', async () => {
  const wallet = provider();
  Object.assign(window, { ethereum: wallet });
  const requests = captureRequests();
  const view = gallery();
  const sample = view.getAllByRole('img').map((image) => image.getAttribute('src'));
  assert.equal(requests.length, 0);
  await connect(view);
  assert.deepEqual(wallet.calls, ['eth_requestAccounts']);
  assert.equal(requests[0].url, `https://api.mons.shop/mi-note-cards?address=${ADDRESS.toLowerCase()}`);
  assert.match(view.getByRole('status').textContent!, /Loading your cards/);
  await act(async () => requests[0].resolve(Response.json(holdings())));
  assert.equal(view.getAllByRole('img').length, 1);
  assert.equal(view.getByRole('img').getAttribute('alt'), CARD.name);

  act(() => wallet.emit('accountsChanged', [OTHER_ADDRESS]));
  assert.equal(view.queryAllByRole('img').length, 0);
  assert.equal(requests[1].url, `https://api.mons.shop/mi-note-cards?address=${OTHER_ADDRESS}`);
  fireEvent.click(view.getByRole('tab', { name: 'All' }));
  assert.equal(requests[1].signal.aborted, true);
  await act(async () => requests[1].resolve(Response.json(holdings())));
  assert.deepEqual(view.getAllByRole('img').map((image) => image.getAttribute('src')), sample);
  fireEvent.click(view.getByRole('tab', { name: 'Your' }));
  assert.deepEqual(wallet.calls, ['eth_requestAccounts']);
  assert.equal(requests.length, 3);
  fireEvent.click(view.getByRole('button', { name: 'Disconnect' }));
  assert.equal(requests[2].signal.aborted, true);
  assert.ok(view.getByRole('button', { name: 'Connect Ethereum Wallet' }));
  assert.equal(window.localStorage.length, 0);
});

test('ownership errors are retryable and an empty successful response shows the empty state', async () => {
  Object.assign(window, { ethereum: provider() });
  const requests = captureRequests();
  const view = gallery();
  await connect(view);
  await act(async () => requests[0].resolve(Response.json({ ok: false, error: 'provider-unavailable' }, { status: 502 })));
  assert.equal(view.getByRole('alert').textContent, 'Couldn’t load your cards.');
  fireEvent.click(view.getByRole('button', { name: 'Try again' }));
  assert.equal(requests.length, 2);
  assert.equal(view.queryByRole('alert'), null);
  await act(async () => requests[1].resolve(Response.json(holdings(false))));
  assert.equal(view.getByRole('status').textContent, 'No Mi Note cards found.');
});

for (const withCard of [false, true]) {
  test(`partial ownership ${withCard ? 'retains available cards' : 'does not report an empty wallet'} and can be retried`, async () => {
    Object.assign(window, { ethereum: provider() });
    const requests = captureRequests();
    const view = gallery();
    await connect(view);
    const partial = holdings(withCard);
    partial.resultsByContract[MI_NOTE_CONTRACT_ADDRESSES[1]] = { status: 'error', error: 'provider-timeout' };
    if (!withCard) partial.resultsByContract[MI_NOTE_CONTRACT_ADDRESSES[0]] = { status: 'error', error: 'provider-unavailable' };
    await act(async () => requests[0].resolve(Response.json(partial)));
    assert.equal(view.getByRole('alert').textContent, 'Some cards couldn’t be loaded.');
    assert.equal(view.queryByText('No Mi Note cards found.'), null);
    assert.deepEqual(view.queryAllByRole('img').map((image) => image.getAttribute('alt')), withCard ? [CARD.name] : []);
    fireEvent.click(view.getByRole('button', { name: 'Try again' }));
    assert.equal(requests.length, 2);
    await act(async () => requests[1].resolve(Response.json(holdings(withCard))));
    assert.equal(view.queryByRole('alert'), null);
    assert.equal(view.queryByRole('button', { name: 'Try again' }), null);
    assert.deepEqual(view.queryAllByRole('img').map((image) => image.getAttribute('alt')), withCard ? [CARD.name] : []);
    if (!withCard) assert.equal(view.getByRole('status').textContent, 'No Mi Note cards found.');
  });
}

test('a remembered wallet restores only on entering Your and disconnect prevents later restoration', async () => {
  const wallet = provider();
  Object.assign(window, { ethereum: wallet });
  const requests = captureRequests();
  const first = gallery();
  await connect(first);
  first.unmount();
  const second = gallery();
  assert.equal(second.getByRole('tab', { name: 'All' }).getAttribute('aria-selected'), 'true');
  assert.deepEqual(wallet.calls, ['eth_requestAccounts']);
  assert.equal(requests.length, 1);
  fireEvent.click(second.getByRole('tab', { name: 'Your' }));
  await waitFor(() => assert.ok(second.getByRole('button', { name: 'Disconnect' })));
  assert.deepEqual(wallet.calls, ['eth_requestAccounts', 'eth_accounts']);
  assert.equal(requests.length, 2);
  fireEvent.click(second.getByRole('button', { name: 'Disconnect' }));
  second.unmount();
  const third = gallery();
  fireEvent.click(third.getByRole('tab', { name: 'Your' }));
  assert.ok(third.getByRole('button', { name: 'Connect Ethereum Wallet' }));
  assert.deepEqual(wallet.calls, ['eth_requestAccounts', 'eth_accounts']);
});

test('multiple wallets are selected inline with cancel and keyboard focus restoration', async () => {
  const first = provider();
  const second = provider([OTHER_ADDRESS]);
  window.addEventListener('eip6963:requestProvider', () => {
    for (const [index, wallet] of [first, second].entries()) {
      window.dispatchEvent(new dom.window.CustomEvent('eip6963:announceProvider', { detail: {
        info: { uuid: `wallet-${index}`, name: `Wallet ${index + 1}`, rdns: `wallet.${index}`, icon: 'data:image/png;base64,' },
        provider: wallet,
      } }));
    }
  });
  const requests = captureRequests();
  const view = gallery();
  fireEvent.keyDown(view.getByRole('tab', { name: 'All' }), { key: 'ArrowRight' });
  const yourTab = view.getByRole('tab', { name: 'Your' });
  assert.equal(yourTab.getAttribute('aria-selected'), 'true');
  assert.equal(document.activeElement, yourTab);
  fireEvent.click(view.getByRole('button', { name: 'Connect Ethereum Wallet' }));
  await waitFor(() => assert.ok(view.getByRole('group', { name: 'Select Ethereum wallet' })));
  assert.equal(document.activeElement, view.getByRole('button', { name: 'Wallet 1' }));
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  assert.equal(view.queryByRole('group'), null);
  assert.equal(document.activeElement, view.getByRole('button', { name: 'Connect Ethereum Wallet' }));
  assert.equal(first.calls.length + second.calls.length, 0);
  fireEvent.click(view.getByRole('button', { name: 'Connect Ethereum Wallet' }));
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Wallet 2' })));
  fireEvent.click(view.getByRole('button', { name: 'Wallet 2' }));
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Disconnect' })));
  assert.deepEqual(first.calls, []);
  assert.deepEqual(second.calls, ['eth_requestAccounts']);
  assert.equal(requests[0].url, `https://api.mons.shop/mi-note-cards?address=${OTHER_ADDRESS}`);
});

test('address links bypass wallet restoration and preserve the gallery without tabs', async () => {
  const wallet = provider();
  Object.assign(window, { ethereum: wallet });
  const requests = captureRequests();
  const first = gallery();
  await connect(first);
  first.unmount();
  window.history.replaceState(null, '', `/mi_note_cards?address=${OTHER_ADDRESS}`);
  const linked = gallery();
  assert.equal(linked.queryByRole('tablist'), null);
  assert.equal(linked.queryByRole('button', { name: 'Connect Ethereum Wallet' }), null);
  assert.equal(linked.queryByRole('status'), null);
  assert.deepEqual(wallet.calls, ['eth_requestAccounts']);
  assert.equal(requests[1].url, `https://api.mons.shop/mi-note-cards?address=${OTHER_ADDRESS}`);
  const partial = holdings();
  partial.resultsByContract[MI_NOTE_CONTRACT_ADDRESSES[1]] = { status: 'error', error: 'provider-timeout' };
  await act(async () => requests[1].resolve(Response.json(partial)));
  assert.equal(linked.getByRole('img').getAttribute('alt'), CARD.name);
  assert.equal(linked.queryByRole('alert'), null);
  assert.equal(linked.queryByRole('status'), null);
  assert.equal(linked.queryByRole('button', { name: 'Try again' }), null);
});
