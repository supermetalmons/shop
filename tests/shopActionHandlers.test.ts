import assert from 'node:assert/strict';
import test, { after, afterEach } from 'node:test';
import { useMemo, useRef } from 'react';
import { PublicKey } from '@solana/web3.js';
import type { WalletContextState } from '@solana/wallet-adapter-react';
import type { InventoryItem } from '../src/types.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react');
const { useShopActionContinuation } = await import('../src/shop/account/useShopActionContinuation.ts');
const { useShopActionHandlers } = await import('../src/shop/useShopActionHandlers.ts');
const { useShopInventorySelectionState } = await import('../src/shop/inventory/useShopInventorySelection.ts');
const { useCommerceModals } = await import('../src/shop/commerce/useCommerceModals.ts');

afterEach(cleanup);
after(() => dom.window.close());

const owner = new PublicKey(new Uint8Array(32).fill(1)).toBase58();
const otherOwner = new PublicKey(new Uint8Array(32).fill(2)).toBase58();
const pack: InventoryItem = { id: 'pack', name: 'Pack', dropId: 'card_nft_2', kind: 'box', boxId: '1' };
const receipt: InventoryItem = { id: 'receipt', name: 'Receipt', dropId: 'card_nft_2', kind: 'certificate', dudeId: 1 };
type HandlerOptions = Parameters<typeof useShopActionHandlers>[0];
type GateOptions = Parameters<Parameters<typeof useShopActionContinuation>[0]['ensureSignedIn']>[0];
type Call = { action: string; wallet: string | undefined; payload: unknown; selection: string[] };
type RigProps = {
  connectedWallet: string | undefined;
  owner: string | undefined;
  fetched: boolean;
  inventory: InventoryItem[];
  receipts: InventoryItem[];
  recoveryReady: boolean;
  availability: { id: number; status: string }[];
  availabilityError: string | null;
  pendingCardIds: number[] | null;
  routeDropId: string;
  preorderId: string;
  scopeKey: string;
  overlay: { id: string; dropId: string; hasRevealAttempted?: boolean; revealedIds?: number[] } | null;
  revealClosing: boolean;
};
type RigRuntime = {
  openBox?: () => Promise<void>;
  reveal?: () => Promise<void> | void;
  ponchoReveal?: () => Promise<'resolved' | 'retry'> | 'resolved' | 'retry';
  run?: (request: Parameters<HandlerOptions['continuation']['run']>[0]) => Promise<unknown>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function rig(overrides: Partial<RigProps> = {}, runtime: RigRuntime = {}) {
  const signIn = deferred<boolean>();
  const walletConnection = deferred<string | null>();
  const signInRequests: GateOptions[] = [];
  const walletRequests: GateOptions[] = [];
  const calls: Call[] = [];
  const messages: string[] = [];
  const initial: RigProps = {
    connectedWallet: undefined, owner, fetched: true, inventory: [pack], receipts: [receipt],
    recoveryReady: true, availability: [{ id: 1, status: 'available' }, { id: 2, status: 'available' }],
    availabilityError: null, pendingCardIds: null,
    routeDropId: 'card_nft_2', preorderId: 'mi_note_cards_devnet', scopeKey: '/shop', overlay: null, revealClosing: false,
    ...overrides,
  };
  const view = renderHook((props: RigProps) => {
    const connectedWalletRef = useRef<string | null>(props.connectedWallet ?? null);
    const wallet = useMemo(() => {
      const publicKey = props.connectedWallet ? new PublicKey(props.connectedWallet) : null;
      return {
        publicKey,
        wallet: publicKey ? { adapter: { publicKey, supportedTransactionVersions: new Set([0]) } } : null,
        signTransaction: publicKey ? async (transaction: unknown) => transaction : undefined,
      } as unknown as WalletContextState;
    }, [props.connectedWallet]);
    const modals = useCommerceModals({
      wallet, connectedWallet: props.connectedWallet, connectedWalletRef,
      rebaseReceiptOperations: () => {}, claimDeepLinkCode: null, navigate: () => {},
    });
    const selectionState = useShopInventorySelectionState({ connectedWallet: props.connectedWallet, owner: props.owner });
    const selected = selectionState.selected;
    const inventoryIndex = new Map(props.inventory.map((item) => [item.id, item]));
    const deliverableItems = [...selected].flatMap((id) => inventoryIndex.get(id) ?? []);
    const continuation = useShopActionContinuation({
      connectedWallet: props.connectedWallet, scopeKey: props.scopeKey,
      ensureSignedIn: (request) => { signInRequests.push(request); return signIn.promise; },
      ensureWalletConnected: (request) => { walletRequests.push(request); return walletConnection.promise; },
      showToast: (message) => { messages.push(message); },
    });
    const record = (action: string, payload?: unknown) => {
      calls.push({ action, wallet: props.connectedWallet, payload, selection: [...selected] });
    };
    const source = {
      continuation: runtime.run ? { ...continuation, run: runtime.run } : continuation,
      owner: props.owner, routeDropId: props.routeDropId,
      blockViewerModeAction: () => false,
      showToast: (message: string) => { messages.push(message); },
      selectionState,
      selection: { selected, deliverableItems, canShipSelected: selected.size > 0 && selected.size === deliverableItems.length },
      inventory: { inventoryIndex, receiptItems: props.receipts },
      queries: { inventoryFetched: props.fetched, inventory: [...props.inventory, ...props.receipts] },
      modals,
      preorder: {
        config: { preorderId: props.preorderId }, recoveryReady: props.recoveryReady,
        availability: { items: props.availability }, availabilityError: props.availabilityError,
        pending: props.pendingCardIds ? { cardIds: props.pendingCardIds } : null,
        purchase: async (ids: number[]) => { record('preorder', [...ids]); },
      },
      purchase: {
        handleMint: async (quantity: number, variantKey?: string) => { record('mint', { quantity, variantKey }); },
        handleDiscountMint: async (quantity: number, variantKey?: string) => { record('discount', { quantity, variantKey }); },
      },
      delivery: {
        handleOpenShip: async () => { record('open-ship'); modals.openDelivery(); },
        handleShip: async (payload: unknown) => { record('ship', payload); },
      },
      claim: { handleClaim: async (payload: unknown) => { record('claim', payload); return { deferred: true }; } },
      receipts: {
        handleAdminIrlRedeem: async (item?: InventoryItem) => { record('admin-redeem', item); },
        handleReceiptTransfer: async (destination: string) => { record('transfer', destination); },
      },
      reveal: {
        getSessionGeneration: () => 1,
        isClosing: () => props.revealClosing,
        getCurrentOverlay: () => props.overlay,
        openSelectedBox: async (item: InventoryItem) => { record('open-box', item); await runtime.openBox?.(); },
        handleRevealOverlayClick: () => { record('reveal'); return runtime.reveal?.(); },
        handlePonchoOverlayRequestReveal: () => { record('poncho-reveal'); return runtime.ponchoReveal?.() ?? 'resolved'; },
        openPendingReveal: async (item: InventoryItem, rect: DOMRect) => { record('pending-reveal', { item, rect }); },
      },
    } as unknown as HandlerOptions;
    const handlers = useShopActionHandlers(source);
    return { handlers, continuation, modals, selectionState };
  }, { initialProps: initial });
  return { ...view, initial, signIn, walletConnection, signInRequests, walletRequests, calls, messages };
}

test('disconnected preorder retains card IDs through connection and waits for recovered checkout state', async () => {
  const context = rig();
  const ids = [1, 2];
  let completion!: Promise<void>;
  act(() => { completion = context.result.current.handlers.handlePreorder(ids); });
  ids.splice(0, ids.length, 9);
  assert.equal(context.signInRequests.length, 1);
  context.rerender({ ...context.initial, connectedWallet: owner, recoveryReady: false });
  await act(async () => { context.signIn.resolve(true); });
  assert.deepEqual(context.calls, []);
  context.rerender({ ...context.initial, connectedWallet: owner, recoveryReady: true });
  await waitFor(() => assert.equal(context.calls.length, 1));
  await completion;
  assert.deepEqual(context.calls[0], { action: 'preorder', wallet: owner, payload: [1, 2], selection: [] });
  assert.deepEqual(context.messages, []);
});

test('restored conflicting preorder stops the captured purchase instead of buying different cards', async () => {
  const context = rig();
  let completion!: Promise<void>;
  act(() => { completion = context.result.current.handlers.handlePreorder([1]); });
  context.rerender({ ...context.initial, connectedWallet: owner, pendingCardIds: [2] });
  await act(async () => { context.signIn.resolve(true); });
  await waitFor(() => assert.equal(context.result.current.continuation.pendingAction, null));
  await completion;
  assert.deepEqual(context.calls, []);
  assert.deepEqual(context.messages, ['Another preorder is active. Continue to resolve it.']);
});

test('matching recovered preorder may continue when its cards are already reserved', async () => {
  const context = rig();
  let completion!: Promise<void>;
  act(() => { completion = context.result.current.handlers.handlePreorder([1]); });
  context.rerender({ ...context.initial, connectedWallet: owner, pendingCardIds: [1], availability: [{ id: 1, status: 'reserved' }] });
  await act(async () => { context.signIn.resolve(true); });
  await waitFor(() => assert.equal(context.calls.length, 1));
  await completion;
  assert.equal(context.calls[0].action, 'preorder');
  assert.deepEqual(context.messages, []);
});

test('cards that become unavailable during sign-in are revalidated before purchase', async () => {
  const context = rig();
  let completion!: Promise<void>;
  act(() => { completion = context.result.current.handlers.handlePreorder([1]); });
  context.rerender({ ...context.initial, connectedWallet: owner, availability: [{ id: 1, status: 'sold' }] });
  await act(async () => { context.signIn.resolve(true); });
  await waitFor(() => assert.equal(context.result.current.continuation.pendingAction, null));
  await completion;
  assert.deepEqual(context.calls, []);
  assert.deepEqual(context.messages, ['Some selected cards are no longer available.']);
});

test('numeric claim keeps its original code and survives wallet-driven modal generation resets', async () => {
  const context = rig();
  act(() => context.result.current.modals.openClaim());
  const initialTransactionGeneration = context.result.current.modals.claimModalGenerationRef.current;
  const initialIntentGeneration = context.result.current.modals.claimIntentGenerationRef.current;
  const payload = { code: '123456' };
  let completion!: ReturnType<typeof context.result.current.handlers.handleClaim>;
  act(() => { completion = context.result.current.handlers.handleClaim(payload); });
  payload.code = '654321';
  context.rerender({ ...context.initial, connectedWallet: owner });
  assert.ok(context.result.current.modals.claimModalGenerationRef.current > initialTransactionGeneration);
  assert.equal(context.result.current.modals.claimIntentGenerationRef.current, initialIntentGeneration);
  await act(async () => { context.signIn.resolve(true); });
  await waitFor(() => assert.equal(context.calls.length, 1));
  await completion;
  assert.deepEqual(context.calls[0], { action: 'claim', wallet: owner, payload: { code: '123456' }, selection: [] });
});

test('closing and reopening the claim form cancels its previous code even when open stays true', async () => {
  const context = rig();
  act(() => context.result.current.modals.openClaim());
  let completion!: ReturnType<typeof context.result.current.handlers.handleClaim>;
  act(() => { completion = context.result.current.handlers.handleClaim({ code: '123456' }); });
  act(() => {
    context.result.current.modals.closeClaimModal();
    context.result.current.modals.openClaim();
  });
  context.rerender({ ...context.initial, connectedWallet: owner });
  await act(async () => { context.signIn.resolve(true); });
  await waitFor(() => assert.equal(context.result.current.continuation.pendingAction, null));
  assert.deepEqual(await completion, { deferred: true });
  assert.deepEqual(context.calls, []);
});

test('opening shipping preserves captured selection through connection and waits for inventory fetch', async () => {
  const context = rig();
  act(() => context.result.current.selectionState.replaceSelection([pack.id]));
  let completion!: Promise<void>;
  act(() => { completion = context.result.current.handlers.handleOpenShip(); });
  context.rerender({ ...context.initial, connectedWallet: owner, fetched: false });
  assert.deepEqual([...context.result.current.selectionState.selected], [pack.id]);
  await act(async () => { context.signIn.resolve(true); });
  assert.deepEqual(context.calls, []);
  context.rerender({ ...context.initial, connectedWallet: owner, fetched: true });
  await waitFor(() => assert.equal(context.calls.length, 1));
  await completion;
  assert.deepEqual(context.calls[0], { action: 'open-ship', wallet: owner, payload: undefined, selection: [pack.id] });
  assert.equal(context.result.current.modals.deliveryOpen, true);
});

test('an inventory intent never changes owner when another wallet is selected', async () => {
  const context = rig();
  act(() => context.result.current.selectionState.replaceSelection([pack.id]));
  let completion!: Promise<void>;
  act(() => { completion = context.result.current.handlers.handleOpenShip(); });
  assert.equal(context.signInRequests[0]?.expectedWallet, owner);
  context.rerender({ ...context.initial, connectedWallet: otherOwner, owner: otherOwner });
  await act(async () => { context.signIn.resolve(true); });
  await waitFor(() => assert.equal(context.result.current.continuation.pendingAction, null));
  await completion;
  assert.deepEqual(context.calls, []);
  assert.deepEqual([...context.result.current.selectionState.selected], []);
});

test('missing inventory after sign-in is reported without opening or sending anything', async () => {
  const context = rig();
  let completion!: Promise<void>;
  act(() => { completion = context.result.current.handlers.openSelectedBox(pack); });
  context.rerender({ ...context.initial, connectedWallet: owner, inventory: [] });
  await act(async () => { context.signIn.resolve(true); });
  await waitFor(() => assert.equal(context.result.current.continuation.pendingAction, null));
  await completion;
  assert.deepEqual(context.calls, []);
  assert.deepEqual(context.messages, ['These items are no longer available.']);
});

test('mint continues with the chosen wallet and original quantity without requesting sign-in', async () => {
  const context = rig();
  let completion!: Promise<void>;
  act(() => { completion = context.result.current.handlers.handleMint(3, 'blue'); });
  assert.equal(context.walletRequests.length, 1);
  assert.equal(context.signInRequests.length, 0);
  await act(async () => { context.walletConnection.resolve(owner); });
  assert.deepEqual(context.calls, []);
  context.rerender({ ...context.initial, connectedWallet: owner });
  await waitFor(() => assert.equal(context.calls.length, 1));
  await completion;
  assert.deepEqual(context.calls[0], { action: 'mint', wallet: owner, payload: { quantity: 3, variantKey: 'blue' }, selection: [] });
  assert.equal(context.signInRequests.length, 0);
});

test('receipt Admin IRL Redeem validates against receipt inventory outside the box index', async () => {
  const context = rig({ connectedWallet: owner });
  let completion!: Promise<void>;
  act(() => { completion = context.result.current.handlers.handleAdminIrlRedeem(receipt); });
  await act(async () => { context.signIn.resolve(true); });
  await waitFor(() => assert.equal(context.result.current.continuation.pendingAction, null));
  await completion;
  assert.deepEqual(context.messages, []);
  assert.equal(context.calls.length, 1);
  assert.equal(context.calls[0].action, 'admin-redeem');
  assert.deepEqual(context.calls[0].payload, receipt);
});


test('an explicit receipt disappearing after preparation never falls back to redeeming selected packs', async () => {
  const waiting = deferred<unknown>();
  let staged!: Parameters<HandlerOptions['continuation']['run']>[0];
  const context = rig({ connectedWallet: owner }, {
    run: (request) => { staged = request; return waiting.promise; },
  });
  act(() => context.result.current.selectionState.replaceSelection([pack.id]));
  let completion!: Promise<void>;
  act(() => { completion = context.result.current.handlers.handleAdminIrlRedeem(receipt); });
  assert.equal(staged.prepare?.(), true);
  context.rerender({ ...context.initial, receipts: [] });
  assert.throws(() => staged.execute(), /This item is no longer available/);
  assert.deepEqual(context.calls, []);
  await act(async () => { waiting.resolve(undefined); await completion; });
});

test('visual-only default reveal taps stay synchronous and do not request authentication', () => {
  const context = rig({ connectedWallet: owner, overlay: { id: pack.id, dropId: pack.dropId, hasRevealAttempted: true } });
  act(() => { context.result.current.handlers.handleRevealOverlayClick(); });
  assert.equal(context.calls.length, 1);
  assert.equal(context.calls[0].action, 'reveal');
  assert.equal(context.signInRequests.length, 0);
  assert.equal(context.result.current.continuation.pendingAction, null);
  context.rerender({ ...context.initial, overlay: { id: pack.id, dropId: pack.dropId, revealedIds: [1] } });
  act(() => { context.result.current.handlers.handleRevealOverlayClick(); });
  assert.equal(context.calls.length, 2);
  assert.equal(context.signInRequests.length, 0);
});

test('the first default reveal holds the action lock through its request while later visual taps still work', async () => {
  const reveal = deferred<void>();
  const context = rig({ connectedWallet: owner, overlay: { id: pack.id, dropId: pack.dropId } }, {
    reveal: () => reveal.promise,
  });
  let completion!: void | Promise<void>;
  act(() => { completion = context.result.current.handlers.handleRevealOverlayClick(); });
  assert.equal(context.signInRequests.length, 1);
  await act(async () => { context.signIn.resolve(true); });
  await waitFor(() => assert.equal(context.calls.length, 1));
  assert.deepEqual(context.result.current.continuation.pendingAction, { key: 'reveal', phase: 'running' });
  await act(async () => { await context.result.current.handlers.handleMint(1); });
  assert.equal(context.walletRequests.length, 0);
  assert.equal(context.calls.length, 1);
  context.rerender({ ...context.initial, overlay: { id: pack.id, dropId: pack.dropId, hasRevealAttempted: true } });
  act(() => { void context.result.current.handlers.handleRevealOverlayClick(); });
  assert.equal(context.calls.length, 2);
  assert.equal(context.signInRequests.length, 1);
  assert.equal(context.result.current.continuation.pendingAction?.key, 'reveal');
  await act(async () => { reveal.resolve(); await completion; });
  await waitFor(() => assert.equal(context.result.current.continuation.pendingAction, null));
});

test('an early reveal for the opening pack waits for confirmation once and stays in the same action', async () => {
  const confirmation = deferred<void>();
  const reveal = deferred<'resolved'>();
  let revealApiCalls = 0;
  const context = rig({ connectedWallet: owner }, {
    openBox: () => confirmation.promise,
    ponchoReveal: async () => {
      await confirmation.promise;
      revealApiCalls += 1;
      return reveal.promise;
    },
  });
  let opening!: Promise<void>;
  act(() => { opening = context.result.current.handlers.openSelectedBox(pack); });
  await act(async () => { context.signIn.resolve(true); });
  await waitFor(() => assert.equal(context.calls.length, 1));
  assert.deepEqual(context.result.current.continuation.pendingAction, { key: 'open-box', phase: 'running' });

  for (const overlay of [
    { id: 'other-pack', dropId: pack.dropId },
    { id: pack.id, dropId: 'other-drop' },
  ]) {
    context.rerender({ ...context.initial, overlay });
    await act(async () => { assert.equal(await context.result.current.handlers.handlePonchoOverlayRequestReveal(), 'retry'); });
    assert.equal(context.calls.length, 1);
  }
  context.rerender({ ...context.initial, overlay: { id: pack.id, dropId: pack.dropId }, revealClosing: true });
  await act(async () => { assert.equal(await context.result.current.handlers.handlePonchoOverlayRequestReveal(), 'retry'); });
  assert.equal(context.calls.length, 1);
  context.rerender({ ...context.initial, overlay: { id: pack.id, dropId: pack.dropId } });
  let first!: ReturnType<typeof context.result.current.handlers.handlePonchoOverlayRequestReveal>;
  let second!: ReturnType<typeof context.result.current.handlers.handlePonchoOverlayRequestReveal>;
  act(() => {
    first = context.result.current.handlers.handlePonchoOverlayRequestReveal();
    second = context.result.current.handlers.handlePonchoOverlayRequestReveal();
  });
  assert.equal(first, second);
  assert.equal(context.calls.length, 2);
  assert.equal(context.calls[1].action, 'poncho-reveal');
  assert.equal(context.signInRequests.length, 1);
  assert.equal(revealApiCalls, 0);
  await act(async () => { confirmation.resolve(); });
  assert.equal(revealApiCalls, 1);
  assert.equal(context.result.current.continuation.pendingAction?.key, 'open-box');
  await act(async () => { await context.result.current.handlers.handleMint(1); });
  assert.equal(context.walletRequests.length, 0);
  await act(async () => {
    reveal.resolve('resolved');
    assert.deepEqual(await Promise.all([first, second]), ['resolved', 'resolved']);
    await opening;
  });
  assert.equal(context.result.current.continuation.pendingAction, null);
});
