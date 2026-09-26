import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { afterEach, beforeEach } from 'node:test';
import { createElement } from 'react';
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
cssImports.deregister();
dom.window.close();

const ADDRESS = '0xe26067c76fdbe877f48b0a8400cf5db8b47af0fe';
const OTHER_ADDRESS = '0x5bfce4149f520fe0823dc8c0afaf979121e824ec';
const ADMIN = 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz';
const config = getPreorderConfig('mi_note_cards_devnet')!;
const originalFetch = globalThis.fetch;
beforeEach(() => { ({ dom } = setupFrontendDom()); });
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); });

function provider(initialAddress = ADDRESS) {
  let address = initialAddress;
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const calls: string[] = [];
  return {
    calls,
    request: async ({ method }: { method: string }) => {
      calls.push(method);
      if (method === 'eth_chainId') return '0x1';
      if (method === 'personal_sign') return `0x${'12'.repeat(65)}`;
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
  let ownershipStatus: 'success' | 'partial' = 'success';
  let lookupCount = 0;
  let logoutCount = 0;
  const authCalls: string[] = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(new Headers(init?.headers).get('X-Mons-CSRF'), '1');
    const action = String(input).split('/').at(-1)!;
    authCalls.push(action);
    if (action === 'challenge') {
      challenged = JSON.parse(String(init?.body)).address;
      return Response.json({ challengeId: 'challenge', message: 'Verify Mi Note ownership', expiresAtMs: Date.now() + 300_000 });
    }
    if (action === 'verify') return Response.json({ token: `verified-${challenged}`, address: challenged,
      preorderId: config.preorderId, expiresAtMs: Date.now() + 3_600_000 });
    logoutCount += 1;
    return Response.json({ ok: true });
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
  function Harness({ admin = false }: { admin?: boolean }) {
    const wallet = useMiNoteEthereumWallet(true);
    const verification = useMiNoteVerification(true, config.preorderId, wallet);
    const preorder = usePreorderCheckout({ config, active: true, buyer: admin ? ADMIN : undefined, signedIn: admin,
      ethereumSession: verification.session, onEthereumSessionInvalid: verification.invalidate,
      signTransaction: undefined, ensureSignedIn: async () => false, onSucceeded: () => {},
    }, api);
    return createElement(MiNoteCardsGallery, { preorder, wallet, verification, onAdminSignIn: async () => {} });
  }
  return { Harness, authCalls, get lookupCount() { return lookupCount; }, get logoutCount() { return logoutCount; },
    partial: () => { ownershipStatus = 'partial'; }, complete: () => { ownershipStatus = 'success'; } };
}

async function connectAndVerify(view: ReturnType<typeof render>) {
  fireEvent.click(view.getByRole('button', { name: 'Connect Ethereum Wallet' }));
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Verify Ethereum Wallet' })));
  fireEvent.click(view.getByRole('button', { name: 'Verify Ethereum Wallet' }));
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
  fireEvent.click(view.getByRole('button', { name: 'Verify Ethereum Wallet' }));
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
  const restored = render(createElement(context.Harness, { admin: true }));
  await waitFor(() => assert.equal(restored.getAllByRole('img').length, 10));
  assert.equal(wallet.calls.filter(call => call === 'personal_sign').length, 1);
  fireEvent.click(restored.getByRole('button', { name: 'Disconnect' }));
  assert.equal(restored.queryByRole('img'), null);
  await waitFor(() => assert.equal(context.logoutCount, 1));
  restored.unmount();
  const disconnected = render(createElement(context.Harness, { admin: true }));
  assert.ok(disconnected.getByRole('button', { name: 'Connect Ethereum Wallet' }));
});

test('wallet picker remains inline and supports cancellation and provider selection', async () => {
  const one = provider(); const two = provider(OTHER_ADDRESS);
  const context = rig();
  window.addEventListener('eip6963:requestProvider', () => {
    for (const [index, wallet] of [one, two].entries()) window.dispatchEvent(new dom.window.CustomEvent('eip6963:announceProvider', {
      detail: { provider: wallet, info: { uuid: String(index), name: `Wallet ${index}`, rdns: `wallet.${index}`, icon: '' } },
    }));
  });
  const view = render(createElement(context.Harness, { admin: true }));
  fireEvent.click(view.getByRole('button', { name: 'Connect Ethereum Wallet' }));
  await waitFor(() => assert.ok(document.activeElement === view.getByRole('button', { name: 'Wallet 0' })));
  fireEvent.keyDown(view.getByRole('button', { name: 'Wallet 0' }), { key: 'Escape' });
  assert.ok(view.getByRole('button', { name: 'Connect Ethereum Wallet' }));
  fireEvent.click(view.getByRole('button', { name: 'Connect Ethereum Wallet' }));
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Wallet 1' })));
  fireEvent.click(view.getByRole('button', { name: 'Wallet 1' }));
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Verify Ethereum Wallet' })));
  assert.equal(one.calls.length, 0);
  fireEvent.click(view.getByRole('button', { name: 'Verify Ethereum Wallet' }));
  await waitFor(() => assert.ok(view.getByRole('button', { name: /Select preorder #11:/ })));
});
