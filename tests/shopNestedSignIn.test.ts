import assert from 'node:assert/strict';
import test, { after, afterEach } from 'node:test';
import { useRef } from 'react';
import { PublicKey, type Connection } from '@solana/web3.js';
import type { WalletContextState } from '@solana/wallet-adapter-react';
import { FULFILLMENT_ADMIN_WALLET_ADDRESSES } from '../shared/fulfillmentAccess.ts';
import { getFrontendDrop } from '../src/config/deployment.ts';
import type { InventoryItem } from '../src/types.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react');
const { useShopSignIn } = await import('../src/shop/account/useShopSignIn.ts');
const { useShopActionContinuation } = await import('../src/shop/account/useShopActionContinuation.ts');
const { useShopActionHandlers } = await import('../src/shop/useShopActionHandlers.ts');
const { useCommerceModals } = await import('../src/shop/commerce/useCommerceModals.ts');
const { useDeliveryActions } = await import('../src/shop/commerce/useDeliveryActions.ts');
const { useReceiptActions } = await import('../src/shop/commerce/useReceiptActions.ts');
const { useReceiptOperationState } = await import('../src/shop/commerce/useReceiptOperationState.ts');

afterEach(() => { cleanup(); window.localStorage.clear(); });
after(() => dom.window.close());

const owner = FULFILLMENT_ADMIN_WALLET_ADDRESSES[0];
const publicKey = new PublicKey(owner);
const drop = getFrontendDrop('card_nft_2')!;
const pack: InventoryItem = { id: 'pack', dropId: drop.dropId, kind: 'box', name: 'Pack' };
type HandlerOptions = Parameters<typeof useShopActionHandlers>[0];
type DeliveryOptions = Parameters<typeof useDeliveryActions>[0];
type RigProps = { scopeKey: string; inventoryFetched: boolean };

function rig() {
  let sessionValid = true;
  let approve!: () => void;
  const approval = new Promise<void>((resolve) => { approve = resolve; });
  const calls = { inventoryChecks: 0, signIn: 0, prepare: 0, send: 0, finalize: 0 };
  const messages: string[] = [];
  const wallet = {
    publicKey,
    wallet: { adapter: { publicKey, supportedTransactionVersions: new Set([0]) } },
    signTransaction: async (transaction: unknown) => transaction,
    connecting: false, disconnecting: false,
  } as unknown as WalletContextState;
  const initial: RigProps = { scopeKey: '/card_nft_2', inventoryFetched: false };
  const view = renderHook((props: RigProps) => {
    const connectedWalletRef = useRef<string | null>(owner);
    const ownerRef = useRef<string | undefined>(owner);
    const receiptState = useReceiptOperationState(owner);
    const modals = useCommerceModals({
      wallet, connectedWallet: owner, connectedWalletRef,
      rebaseReceiptOperations: receiptState.rebaseReceiptOperations,
      claimDeepLinkCode: null, navigate: () => {},
    });
    const showToast = (message: string) => { messages.push(message); };
    const signIn = useShopSignIn({
      auth: {
        loading: false, sessionResolution: 'settled',
        hasAuthenticatedWalletSession: (expectedWallet) => sessionValid && expectedWallet === owner,
        awaitWalletSessionRestoration: async () => 'sign-in-required',
        signIn: async () => {
          calls.signIn += 1;
          await approval;
          sessionValid = true;
          return { wallet: owner };
        },
      },
      connectedWallet: owner, publicKey, wallet,
      walletModalVisible: false, setVisible: () => {},
      isSignedInWallet: sessionValid, hasAuthenticatedAccount: sessionValid,
      showToast, isUserRejectedError: () => false,
    });
    const continuation = useShopActionContinuation({
      connectedWallet: owner, scopeKey: props.scopeKey,
      ensureSignedIn: signIn.ensureSignedIn, ensureWalletConnected: signIn.ensureWalletConnected,
      showToast,
    });
    const delivery = useDeliveryActions({
      connectedWallet: owner, publicKey, connectedWalletRef, ownerRef,
      ensureSignedIn: continuation.ensureActionSignedIn, blockViewerModeAction: () => false,
      prepared: { pendingDeliveryItemIds: new Set() }, modals, recovery: {},
      selected: new Set([pack.id]), deliverableItems: [pack], canShipSelected: true,
      setVisible: () => {}, showToast,
    } as unknown as DeliveryOptions);
    const receipts = useReceiptActions({
      wallet, modals, receiptState, connectedWallet: owner, connectedWalletRef,
      publicKey, owner, ensureSignedIn: continuation.ensureActionSignedIn,
      blockViewerModeAction: () => false, isSignedInWallet: sessionValid,
      getDropConfig: () => drop, requireKnownDropConfig: () => drop,
      getDropConnection: () => ({} as Connection), selectedDropId: drop.dropId,
      adminIrlRedeemSelection: {
        selectedCount: 1, selectedDropIds: [drop.dropId], selectedItems: [pack],
        deliverableItems: [pack], selectionOwner: owner, selectedDropFamily: drop.dropFamily,
      },
      deliverableItems: [pack], clearSelection: () => {},
      getCurrentOverlay: () => null, closeRevealOverlay: () => {},
      setVisible: () => {}, showToast, markAssetsHidden: () => {},
      refetchInventory: async () => ({ data: [] }),
      signAndSendPreparedViaConnection: async () => { throw new Error('Unexpected real submission'); },
    }, {
      prepareAdminIrlRedeemTx: async () => {
        calls.prepare += 1;
        return {
          encodedTx: 'transaction', requestId: 'request-1', dropId: drop.dropId,
          adminWallet: owner, itemCount: 1, targetKind: 'pack', blockhashContextSlot: 1,
        };
      },
      sendReceiptSubmission: async () => { calls.send += 1; return 'signature'; },
      finalizeAdminIrlRedeem: async () => {
        calls.finalize += 1;
        return { processed: true, deliveryId: 7, claimCodes: ['code'] };
      },
    });
    const handlers = useShopActionHandlers({
      continuation, owner, routeDropId: drop.dropId, blockViewerModeAction: () => false, showToast,
      selection: { canShipSelected: true, deliverableItems: [pack], selected: new Set([pack.id]) },
      selectionState: { replaceSelection: () => {} },
      inventory: { inventoryIndex: new Map([[pack.id, pack]]) },
      queries: {
        get inventoryFetched() { calls.inventoryChecks += 1; return props.inventoryFetched; },
        inventory: [pack],
      },
      modals, delivery, receipts,
      reveal: { getSessionGeneration: () => 1, isClosing: () => false },
    } as unknown as HandlerOptions);
    return { handlers, continuation, modals };
  }, { initialProps: initial });
  const expireWhileWaitingForInventory = async () => {
    await waitFor(() => assert.ok(calls.inventoryChecks > 0));
    assert.equal(calls.signIn, 0);
    sessionValid = false;
    view.rerender({ ...initial, inventoryFetched: true });
    await waitFor(() => assert.equal(calls.signIn, 1));
    assert.equal(view.result.current.continuation.pendingAction?.phase, 'running');
  };
  return { ...view, initial, calls, messages, approve, expireWhileWaitingForInventory };
}

test('navigation cancels a shipment opening that needed sign-in again after inventory readiness', async () => {
  const context = rig();
  let completion!: Promise<void>;
  act(() => { completion = context.result.current.handlers.handleOpenShip(); });
  await context.expireWhileWaitingForInventory();
  context.rerender({ ...context.initial, scopeKey: '/other', inventoryFetched: true });
  await act(async () => { await completion; });
  assert.equal(context.result.current.modals.deliveryOpen, false);
  await act(async () => { context.approve(); });
  await waitFor(() => assert.equal(context.result.current.continuation.pendingAction, null));
  assert.equal(context.result.current.modals.deliveryOpen, false);
  assert.deepEqual(context.messages, []);
});

test('closing Shipment cancels Admin IRL Redeem while its second sign-in is waiting', async () => {
  const context = rig();
  act(() => context.result.current.modals.openDelivery());
  let completion!: Promise<void>;
  act(() => { completion = context.result.current.handlers.handleAdminIrlRedeem(); });
  await context.expireWhileWaitingForInventory();
  act(() => context.result.current.modals.closeDelivery());
  await act(async () => { await completion; });
  await act(async () => { context.approve(); });
  await waitFor(() => assert.equal(context.result.current.continuation.pendingAction, null));
  assert.equal(context.calls.prepare, 0);
  assert.equal(context.calls.send, 0);
  assert.equal(context.calls.finalize, 0);
  assert.equal(context.result.current.modals.deliveryOpen, false);
  assert.deepEqual(context.messages, []);
});

test('a current action continues once when sign-in expires while waiting for inventory', async () => {
  const context = rig();
  act(() => context.result.current.modals.openDelivery());
  let completion!: Promise<void>;
  act(() => { completion = context.result.current.handlers.handleAdminIrlRedeem(); });
  await context.expireWhileWaitingForInventory();
  assert.equal(context.calls.prepare, 0);
  await act(async () => { context.approve(); await completion; });
  assert.equal(context.calls.signIn, 1);
  assert.equal(context.calls.prepare, 1);
  assert.equal(context.calls.send, 1);
  assert.equal(context.calls.finalize, 1);
  assert.equal(context.result.current.continuation.pendingAction, null);
});
