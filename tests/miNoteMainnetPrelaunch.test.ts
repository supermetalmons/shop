import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { after, afterEach } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PublicKey } from '@solana/web3.js';
import { DEPLOYMENT_DROPS, type DeploymentRegistryDrop } from '../shared/deploymentRegistry.ts';
import { dasAssetKind } from '../shared/dasAsset.ts';
import { getPreorderConfig, PREORDER_PAYMENT_RECIPIENTS, preorderMetadataUri } from '../shared/preorders.ts';
import { canDeliverItemKind } from '../shared/shipping.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { miNoteDropFixture } from './helpers/miNoteDropFixture.ts';

const preorder = getPreorderConfig('mi_note_cards')!;
const programId = new PublicKey(DEPLOYMENT_DROPS.clear_cards.boxMinterProgramId);
const configPda = (id: string) => PublicKey.findProgramAddressSync([
  Buffer.from('config'), createHash('sha256').update(id).digest(),
], programId)[0].toBase58();
const { treasury: _treasury, paymentRouting: _paymentRouting, ...dropFixture } = miNoteDropFixture();
const mainnetDrop: DeploymentRegistryDrop = {
  ...dropFixture,
  dropId: preorder.preorderId,
  solanaCluster: preorder.cluster,
  collectionMint: preorder.collection,
  metadataBase: 'https://cdn.lil.org/nft/mi_note_cards/json',
  paymentRouting: {
    mintProceeds: [
      { address: PREORDER_PAYMENT_RECIPIENTS[0], percentage: 50 },
      { address: PREORDER_PAYMENT_RECIPIENTS[1], percentage: 50 },
    ],
    deliveryPaymentReceiver: PREORDER_PAYMENT_RECIPIENTS[1],
  },
  boxMinterProgramId: programId.toBase58(),
  boxMinterConfigPda: configPda(preorder.preorderId),
  operationsConfig: {
    configId: 'mi_note_cards_operations',
    boxMinterConfigPda: configPda('mi_note_cards_operations'),
    maxSupply: 715,
  },
  maxSupply: 627,
  priceSol: 0.5,
  discountPriceSol: 0.5,
  inventoryManifest: { sha256: 'a'.repeat(64), cardIds: Array.from({ length: 1254 }, (_, index) => index + 177) },
};
DEPLOYMENT_DROPS[mainnetDrop.dropId] = mainnetDrop;

const { dom } = setupFrontendDom();
const { cleanup, renderHook, within } = await import('@testing-library/react');
const { resolveAppRoute } = await import('../src/routes.ts');
const { resolveFrontendDropByPath } = await import('../src/lib/dropConfig.ts');
const { getFrontendDrop } = await import('../src/config/deployment.ts');
const { getApiDrop } = await import('../cloud/workers/api/src/dropConfig.ts');
const { transformShopInventoryItem } = await import('../shared/shopDomain.ts');
const { resolveClaimedPreorderAsset } = await import('../shared/preorderAssetIdentity.ts');
const { useShopDrop } = await import('../src/shop/useShopDrop.ts');
const { shouldFetchMintProgress } = await import('../src/hooks/useMintProgress.ts');
const { ShopPurchaseSection } = await import('../src/shop/ui/ShopPurchaseSection.tsx');

afterEach(cleanup);
after(() => dom.window.close());

test('registered mainnet remains an announcement while backend and inventory retain its config', () => {
  assert.equal(getFrontendDrop(mainnetDrop.dropId)?.maxSupply, 627);
  assert.equal(getApiDrop(mainnetDrop.dropId)?.operationsConfig?.maxSupply, 715);
  for (const pathname of ['/mi_note_cards', '/mi_note_cards/', '/mi_note_cards///']) {
    const route = resolveAppRoute({ pathname, search: '?from=drop', hash: '#preview' });
    assert.equal(route.kind, 'upcoming');
    assert.equal(route.path, '/mi_note_cards');
    assert.equal(route.walletCluster, 'mainnet-beta');
    assert.equal(route.drop, null);
    assert.equal(route.upcoming?.dropFamily, 'mi_note_cards');
    assert.equal(route.preorderId, null);
    assert.equal(route.replacementHref, null);
    assert.equal(resolveFrontendDropByPath(pathname, { drops: [getFrontendDrop(mainnetDrop.dropId)!] }), null);
  }
  assert.equal(resolveAppRoute({ pathname: '/mi_note_cards_devnet' }).kind, 'drop');
  assert.equal(resolveAppRoute({ pathname: '/mi_note_cards/wip' }).kind, 'wip');
  assert.equal(resolveAppRoute({ pathname: '/clear_cards' }).kind, 'drop');
});

for (const [label, wallet] of [
  ['disconnected', undefined],
  ['ordinary', new PublicKey(new Uint8Array(32).fill(71)).toBase58()],
  ['admin', 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz'],
] as const) {
  test(`registered mainnet exposes Soon without purchase controls for ${label} wallets`, () => {
    const route = resolveAppRoute({ pathname: '/mi_note_cards' });
    const { result } = renderHook(() => useShopDrop(route));
    const drop = result.current;
    assert.equal(drop.routeDrop, null);
    assert.equal(drop.routeConnection, null);
    assert.equal(shouldFetchMintProgress(drop.routeDrop), false);
    assert.equal(drop.routeStripePaymentVisible, false);
    assert.equal(drop.requireKnownDropConfig(mainnetDrop.dropId, 'inventory').dropId, mainnetDrop.dropId);
    for (const action of ['mint', 'discount mint', 'Stripe payment']) {
      assert.throws(() => drop.requireRouteDrop(action), /requires an explicit drop route/);
    }
    const unexpectedPurchase = () => { throw new Error('Prelaunch purchase must stay unavailable'); };
    const markup = renderToStaticMarkup(createElement(ShopPurchaseSection, {
      ...drop,
      minting: false,
      discountMinting: false,
      stripePaymentLoading: false,
      successfulMintToken: 0,
      discountAvailable: true,
      discountRemainingCount: 1,
      handleMint: unexpectedPurchase,
      handleDiscountMint: unexpectedPurchase,
      handleStripePayment: unexpectedPurchase,
      packStatusDropId: null,
      packStatusBreakdown: undefined,
      packStatusDisplayLabels: undefined,
      effectiveMintStats: undefined,
      connectedWallet: wallet,
      publicKey: wallet ? new PublicKey(wallet) : null,
      walletBusy: false,
      showToast: unexpectedPurchase,
      handleOpenNotify: () => undefined,
    }));
    const container = document.createElement('div');
    container.innerHTML = markup;
    const view = within(container);
    assert.ok(view.getByText('Soon'));
    assert.ok(view.getByRole('button', { name: 'Notify Me' }));
    assert.equal(container.querySelector('form'), null);
    assert.equal(view.queryByRole('slider'), null);
    assert.equal(view.queryByRole('button', { name: /Mint|Checkout|Pay|Discount/i }), null);
  });
}

test('registering mainnet preserves original preorders and rejects shipping them', () => {
  const owner = new PublicKey(new Uint8Array(32).fill(72)).toBase58();
  const address = new PublicKey(new Uint8Array(32).fill(73)).toBase58();
  const original = { address, collection: preorder.collection, name: 'Preorder #1', uri: preorderMetadataUri(preorder, 1) };
  const asset = {
    id: address,
    interface: 'MplCoreAsset',
    burnt: false,
    ownership: { owner },
    grouping: [{ group_key: 'collection', group_value: preorder.collection }],
    content: { json_uri: original.uri, metadata: { name: original.name } },
  };
  const item = transformShopInventoryItem(asset, 'mainnet-beta');
  assert.equal(item?.kind, 'preorder');
  assert.equal(item?.preorderId, 1);
  assert.equal(item?.dropId, mainnetDrop.dropId);
  assert.equal(canDeliverItemKind(mainnetDrop.dropFamily, item!.kind), false);
  assert.deepEqual(resolveClaimedPreorderAsset({
    config: preorder, cluster: 'mainnet-beta', claim: { id: 1, address }, actual: original, publicDrop: mainnetDrop,
  }), { kind: 'preorder', id: 1 });
  assert.equal(dasAssetKind(asset, { metadataNameMode: 'string-only' }), null);
  assert.equal(preorder.enabled, true);
  assert.equal(preorder.checkoutEnabled, false);
});
