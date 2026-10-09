import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach, mock } from 'node:test';
import { Connection, PublicKey } from '@solana/web3.js';
import { getFrontendDrop } from '../src/config/deployment.ts';
import { resolveDropContent } from '../src/lib/dropContent.ts';
import type { ShopRevealOptions } from '../src/shop/reveal/contracts.ts';
import type { InventoryItem } from '../src/types.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { MPL_CORE_PROGRAM_ADDRESS } from '../shared/solanaProgramAddresses.ts';

const { dom } = setupFrontendDom();
Object.defineProperty(globalThis, 'DOMRect', { configurable: true, value: dom.window.DOMRect });
const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react');
const owner = new PublicKey(new Uint8Array(32).fill(21));
const assetId = new PublicKey(new Uint8Array(32).fill(22)).toBase58();
let revealCalls: Array<{ owner: string; assetId: string; dropId: string }> = [];
const bridgeKey = '__miNoteShopRevealTest';
Object.defineProperty(globalThis, bridgeKey, { configurable: true, value: {
  fetchBoxMinterConfig: async () => ({}),
  buildStartOpenBoxTxWithPending: async () => ({ tx: {}, pendingPda: owner }),
  revealDudes: async (owner: string, assetId: string, dropId: string) => {
    revealCalls.push({ owner, assetId, dropId });
    return { signature: 'confirmed-reveal', dudeIds: [1401, 1430] };
  },
} });
const imports = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('/shop/reveal/useShopReveal.ts')) {
      if (specifier === '../../lib/boxMinter') return { url: 'test:mi-note-box-minter', shortCircuit: true };
      if (specifier === '../../api/commerce') return { url: 'test:mi-note-commerce', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'test:mi-note-box-minter') return { format: 'module', shortCircuit: true,
      source: `export const { fetchBoxMinterConfig, buildStartOpenBoxTxWithPending } = globalThis.${bridgeKey};` };
    if (url === 'test:mi-note-commerce') return { format: 'module', shortCircuit: true,
      source: `export const { revealDudes } = globalThis.${bridgeKey}; export const revealDudesSubmissionUnknownDetails = () => null;` };
    return nextLoad(url, context);
  },
});
const { useShopReveal } = await import('../src/shop/reveal/useShopReveal.ts');
imports.deregister();
const { soundPlayer } = await import('../src/lib/SoundPlayer.ts');
mock.method(soundPlayer, 'initializeOnUserInteraction', async () => {});
mock.method(soundPlayer, 'preloadSound', async () => {});
afterEach(() => { cleanup(); revealCalls = []; });
after(() => { mock.restoreAll(); Reflect.deleteProperty(globalThis, bridgeKey); dom.window.close(); });

function fixture(dropId: string) {
  const confirmation = Promise.withResolvers<string>();
  const reconciled: number[][] = [];
  const pack: InventoryItem = { id: assetId, dropId, name: 'Pack 704', kind: 'box', boxId: '704' };
  const options: ShopRevealOptions = {
    connectedWallet: owner.toBase58(), publicKey: owner, owner: owner.toBase58(), localAccountWallet: owner.toBase58(),
    isViewerMode: false, suspended: false, walletModalVisible: false, receiptTransferOpen: false,
    routeDrop: getFrontendDrop(dropId)!, inventory: [pack], pendingOpenBoxes: [], figureMetadataByKey: {},
    getDropConfig: getFrontendDrop, getDropContent: resolveDropContent,
    requireKnownDropConfig: id => { const drop = getFrontendDrop(id); assert.ok(drop); return drop; },
    getDropConnection: () => new Connection('https://rpc.invalid'),
    boxLabelForDropId: () => 'pack', figureLabelForDropId: () => 'cards', figureReferenceForDropId: (_id, ref) => `Card ${ref}`,
    openGerundForDropId: () => 'Opening', canOpenBoxesForDropId: () => true,
    addLocalPendingReveal: () => {}, removeLocalPendingReveal: () => {}, rememberRecentReveal: () => {},
    addLocalRevealedDudes: ids => reconciled.push(ids), markAssetsHidden: () => {}, refetchInventory: async () => {},
    refetchPendingOpenBoxes: async () => {}, ensureSignedIn: async () => true, openWalletModal: () => {},
    blockViewerModeAction: () => false, sendAndConfirmViaConnection: () => confirmation.promise,
    retryAfterBlockhashExpiry: sendOnce => sendOnce(), clearSelection: () => {}, showToast: () => {},
  };
  return { options, confirmation, reconciled, pack };
}

function packAccount(dropId: string) {
  const drop = getFrontendDrop(dropId)!;
  const uri = Buffer.from(`${drop.paths.boxesJsonBase}9.json`);
  const data = Buffer.alloc(75 + uri.length);
  data[0] = 1;
  data.fill(99, 1, 33);
  data[33] = 2;
  data.set(new PublicKey(drop.collectionMint).toBytes(), 34);
  data.writeUInt32LE(uri.length, 70);
  data.set(uri, 74);
  return { data, owner: new PublicKey(MPL_CORE_PROGRAM_ADDRESS), executable: false, lamports: 1 };
}

for (const dropId of ['mi_note_cards', 'mi_note_cards_devnet']) {
  test(`${dropId} resumes a pending pack with no owned inventory or saved numeric ID`, async t => {
    const read = t.mock.method(Connection.prototype, 'getAccountInfo', async () => packAccount(dropId));
    const f = fixture(dropId);
    f.options.inventory = [];
    f.options.pendingOpenBoxes = [{ dropId, pendingPda: 'pending', boxAssetId: assetId, dudeAssetIds: ['left', 'right'] }];
    const { result } = renderHook(useShopReveal, { initialProps: f.options });
    await act(async () => { await result.current.openPendingReveal({ ...f.pack, boxId: undefined }, new DOMRect(0, 0, 100, 140)); });
    await waitFor(() => assert.equal(result.current.revealOverlay?.packMediaId, 9));
    assert.equal(read.mock.callCount(), 1);
    assert.equal(read.mock.calls[0].arguments[0].toBase58(), assetId);
    assert.equal(result.current.revealOverlay?.image, 'https://cdn.lil.org/nft/mi_note_cards/packs/clean/9.webp');
    await act(async () => { await result.current.handlePonchoOverlayRequestReveal(); });
    assert.deepEqual(revealCalls, [{ owner: owner.toBase58(), assetId, dropId }]);
    assert.deepEqual(result.current.revealOverlay?.revealedIds, [1401, 1430]);
  });

  test(`${dropId} queues the first reveal tap behind wallet confirmation and keeps actual cards in the 3D session`, async () => {
    const f = fixture(dropId);
    const { result } = renderHook(useShopReveal, { initialProps: f.options });
    let opening!: Promise<void>;
    act(() => { opening = result.current.openSelectedBox(f.pack); });
    await waitFor(() => assert.equal(result.current.revealOverlay?.phase, 'ready'));
    assert.equal(result.current.startOpenLoading, assetId);
    assert.equal(result.current.revealOverlay?.packMediaId, 2);
    assert.equal(result.current.presentation.revealOverlayCanRenderMiNotePack3d, true);
    let revealing!: ReturnType<typeof result.current.handlePonchoOverlayRequestReveal>;
    act(() => { revealing = result.current.handlePonchoOverlayRequestReveal(); });
    await act(async () => {});
    assert.deepEqual(revealCalls, []);
    await act(async () => { f.confirmation.resolve('confirmed-open'); await opening; await revealing; });
    assert.deepEqual(revealCalls, [{ owner: owner.toBase58(), assetId, dropId }]);
    assert.deepEqual(result.current.revealOverlay?.revealedIds, [1401, 1430]);
    assert.equal(result.current.revealOverlay?.phase, 'ready');
    assert.deepEqual(result.current.presentation.revealMediaItems, []);
    assert.deepEqual(f.reconciled, []);
    act(() => result.current.handleRevealOverlayDismiss());
    assert.ok(result.current.revealOverlay);
    act(() => {
      result.current.updateAssetGatedRevealComplete(true);
      result.current.updateClearCardDismissReady(true);
      result.current.handleRevealOverlayDismiss();
    });
    await waitFor(() => assert.equal(result.current.revealOverlay, null));
    assert.deepEqual(f.reconciled, [[1401, 1430]]);
  });
}

test('pending pack identity retries a transient RPC failure and stops once resolved', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  t.mock.method(Connection.prototype, 'getAccountInfo', async () => {
    if (++attempts === 1) throw new Error('Temporary RPC failure');
    return packAccount('mi_note_cards');
  });
  const f = fixture('mi_note_cards');
  f.options.inventory = [];
  const { result } = renderHook(useShopReveal, { initialProps: f.options });
  await act(async () => { await result.current.openPendingReveal({ ...f.pack, boxId: undefined }, new DOMRect(0, 0, 100, 140)); });
  assert.equal(attempts, 1);
  assert.equal(result.current.revealOverlay?.packMediaId, undefined);
  await act(async () => { t.mock.timers.tick(3000); });
  assert.equal(attempts, 2);
  assert.equal(result.current.revealOverlay?.packMediaId, 9);
  await act(async () => { t.mock.timers.tick(9000); });
  assert.equal(attempts, 2);
});

test('a late pack identity response cannot update a replacement card viewer', async t => {
  const pending = Promise.withResolvers<ReturnType<typeof packAccount>>();
  const read = t.mock.method(Connection.prototype, 'getAccountInfo', () => pending.promise);
  const f = fixture('mi_note_cards');
  f.options.inventory = [];
  const { result } = renderHook(useShopReveal, { initialProps: f.options });
  await act(async () => { await result.current.openPendingReveal({ ...f.pack, boxId: undefined }, new DOMRect(0, 0, 100, 140)); });
  act(() => result.current.discardRevealOverlay());
  act(() => result.current.viewItem({ id: 'card', dropId: f.pack.dropId, kind: 'dude', dudeId: 9, name: 'Card 9' }));
  await act(async () => { pending.resolve(packAccount(f.pack.dropId)); await pending.promise; });
  assert.equal(result.current.revealOverlay?.id, 'card');
  assert.equal(result.current.revealOverlay?.packMediaId, undefined);
  assert.equal(read.mock.callCount(), 1);
});

test('rejecting the opening transaction cancels a queued Mi Note reveal without assigning cards', async t => {
  t.mock.method(console, 'error', () => {});
  const f = fixture('mi_note_cards_devnet');
  const { result } = renderHook(useShopReveal, { initialProps: f.options });
  let opening!: Promise<void>;
  act(() => { opening = result.current.openSelectedBox(f.pack); });
  await waitFor(() => assert.equal(result.current.revealOverlay?.phase, 'ready'));
  const revealing = result.current.handlePonchoOverlayRequestReveal();
  await act(async () => {
    f.confirmation.reject(Object.assign(new Error('User rejected'), { code: 4001 }));
    await opening;
    await revealing;
  });
  assert.deepEqual(revealCalls, []);
  assert.equal(result.current.revealOverlay, null);
  assert.deepEqual(f.reconciled, []);
});

test('switching wallets makes a queued Mi Note reveal stale even if the original opening later confirms', async () => {
  const f = fixture('mi_note_cards');
  const { result, rerender } = renderHook(useShopReveal, { initialProps: f.options });
  let opening!: Promise<void>;
  act(() => { opening = result.current.openSelectedBox(f.pack); });
  await waitFor(() => assert.equal(result.current.revealOverlay?.phase, 'ready'));
  const revealing = result.current.handlePonchoOverlayRequestReveal();
  const nextOwner = new PublicKey(new Uint8Array(32).fill(23));
  rerender({ ...f.options, connectedWallet: nextOwner.toBase58(), publicKey: nextOwner, owner: nextOwner.toBase58(), localAccountWallet: nextOwner.toBase58() });
  await act(async () => { f.confirmation.resolve('confirmed-open'); await opening; await revealing; });
  assert.deepEqual(revealCalls, []);
  assert.equal(result.current.revealOverlay, null);
});
