import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, fireEvent, render, within } = await import('@testing-library/react');
const { MintPanel } = await import('../src/components/MintPanel.tsx');
const { mintPanelPreviewQuantity } = await import('../src/components/MintPreview.tsx');
const { shouldFetchMintProgress } = await import('../src/hooks/useMintProgress.ts');
const { resolveDropXProfile } = await import('../src/lib/dropSocialLinks.ts');
type Props = Parameters<typeof MintPanel>[0];

afterEach(cleanup);
after(() => dom.window.close());

function panelProps(overrides: Partial<Props> = {}): Props {
  return {
    stats: { minted: 0, total: 15, remaining: 15, maxPerTx: 5 },
    onMint: () => undefined,
    busy: false,
    boxNamePrefix: 'pack',
    priceSol: 1,
    discountPriceSol: 1,
    maxSupply: 15,
    maxPerTx: 5,
    ...overrides,
  };
}

function stripeOnlyProps(overrides: Partial<Props> = {}): Props {
  return panelProps({
    stats: { minted: 0, total: 15, remaining: 15, maxPerTx: 1 },
    solanaMintVisible: false,
    title: 'Card NFT Binder',
    boxNamePrefix: 'binder',
    dropId: 'card_nft_binder',
    priceSol: 1_000_000,
    discountPriceSol: 1_000_000,
    maxPerTx: 1,
    onStripePaymentClick: () => undefined,
    stripePaymentVisible: true,
    stripePaymentUnitAmountCents: 10_000,
    ...overrides,
  });
}

function sizedPanelProps(overrides: Partial<Props> = {}): Props {
  return panelProps({
    dropId: 'little_swag_hoodies',
    mintSelection: {
      kind: 'size',
      options: [
        { key: 'L', label: 'L', startId: 1, endId: 5 },
        { key: 'XL', label: 'XL', startId: 6, endId: 10 },
        { key: '2XL', label: '2XL', startId: 11, endId: 15 },
      ],
    },
    ...overrides,
  });
}

test('drop X profiles cover every current storefront family and inherit across environments', () => {
  const expectedProfiles = new Map([
    ['little_swag_boxes', ['@supermetalx', 'https://x.com/supermetalx/status/2004991803301548393']],
    ['little_swag_hoodies', ['@supermetalx', 'https://x.com/supermetalx/status/2046959410287669381']],
    ['card_nft_2', ['@bis__cut', 'https://x.com/bis__cut/status/2065174935983595934']],
    ['poncho_drifella', ['@bis__cut', 'https://x.com/bis__cut/status/2039338450969641143']],
    ['drifella_shirt', ['@bis__cut', 'https://x.com/bis__cut/status/2080020123058876494']],
    ['card_nft_binder', ['@bis__cut', 'https://x.com/bis__cut/status/2082471519683326394']],
    ['clear_cards', ['@gucci4mycat', 'https://x.com/gucci4mycat']],
  ]);

  for (const [dropId, [handle, href]] of expectedProfiles) {
    assert.deepEqual(resolveDropXProfile(dropId), { handle, href });
  }

  assert.deepEqual(resolveDropXProfile('little_swag_hoodies_devnet'), {
    handle: '@supermetalx',
    href: 'https://x.com/supermetalx/status/2046959410287669381',
  });
  assert.equal(resolveDropXProfile('future_unassigned_drop'), null);
});

test('clear cards keep a single pack preview as mint quantity changes', () => {
  assert.equal(mintPanelPreviewQuantity('clear_cards', 15, false), 1);
  assert.equal(mintPanelPreviewQuantity('clear_cards_devnet_v2', 8, false), 1);
  assert.equal(mintPanelPreviewQuantity('little_swag_boxes', 3, false), 3);
  assert.equal(mintPanelPreviewQuantity('card_nft_2', 3, true), 1);
});

test('quantity changes update the mint label, price, and submitted quantity', async () => {
  const minted: number[] = [];
  const view = render(createElement(MintPanel, panelProps({ onMint: (quantity) => { minted.push(quantity); } })));
  const quantity = view.getByRole('slider', { name: 'Mint quantity' });
  assert.match(view.getByRole('button', { name: /Mint/ }).textContent!, /1 pack.*1 SOL/);

  fireEvent.change(quantity, { target: { value: '3' } });
  assert.equal((quantity as HTMLInputElement).value, '3');
  const mint = view.getByRole('button', { name: /Mint/ });
  assert.match(mint.textContent!, /3 packs.*3 SOL/);
  await act(async () => { fireEvent.click(mint); });
  assert.deepEqual(minted, [3]);
});

test('minting switches between discounted and regular prices as quantity and allowance change', async () => {
  const discounted: number[] = [];
  const regular: number[] = [];
  const props = panelProps({
    discountAvailable: true,
    discountPriceSol: 0.5,
    discountMaxQuantity: 2,
    onDiscountMint: (quantity) => { discounted.push(quantity); },
    onMint: (quantity) => { regular.push(quantity); },
  });
  const view = render(createElement(MintPanel, props));
  const quantity = view.getByRole('slider', { name: 'Mint quantity' });

  fireEvent.change(quantity, { target: { value: '2' } });
  await act(async () => {
    fireEvent.click(view.getByRole('button', { name: 'Mint with discount for 1 SOL. Regular price 2 SOL.' }));
  });
  fireEvent.change(quantity, { target: { value: '3' } });
  assert.equal(view.queryByRole('button', { name: /Mint with discount/ }), null);
  const regularMint = view.getByRole('button', { name: /Mint/ });
  assert.match(regularMint.textContent!, /3 packs.*3 SOL/);
  await act(async () => { fireEvent.click(regularMint); });

  fireEvent.change(quantity, { target: { value: '1' } });
  assert.ok(view.getByRole('button', { name: /Mint with discount for 0.5 SOL/ }));
  view.rerender(createElement(MintPanel, { ...props, discountMaxQuantity: 0 }));
  assert.equal(view.queryByRole('button', { name: /Mint with discount/ }), null);
  await act(async () => { fireEvent.click(view.getByRole('button', { name: /Mint/ })); });
  assert.deepEqual(discounted, [2]);
  assert.deepEqual(regular, [3, 1]);
});

test('both payment methods require an available size and submit the selected variant', async () => {
  const mints: Array<[number, string | undefined]> = [];
  const payments: Array<[number, string | undefined]> = [];
  const props = sizedPanelProps({
    stats: {
      minted: 5, total: 15, remaining: 10, maxPerTx: 5,
      mintSelectionAvailability: { L: 5, XL: 5, '2XL': 0 },
    },
    onMint: (quantity, size) => { mints.push([quantity, size]); },
    stripePaymentVisible: true,
    stripePaymentUnitAmountCents: 10_000,
    onStripePaymentClick: (quantity, size) => { payments.push([quantity, size]); },
  });
  const view = render(createElement(MintPanel, props));
  assert.equal(view.queryByRole('slider'), null);
  const submitBoth = async () => {
    await act(async () => { fireEvent.click(view.getByRole('button', { name: /Mint/ })); });
    await act(async () => { fireEvent.click(view.getByRole('button', { name: /Checkout/ })); });
  };
  await submitBoth();
  assert.deepEqual(mints, []);
  assert.deepEqual(payments, []);
  const unavailableSize = view.getByRole('radio', { name: '2XL' }) as HTMLButtonElement;
  assert.equal(unavailableSize.disabled, true);
  fireEvent.click(unavailableSize);
  assert.equal(unavailableSize.getAttribute('aria-checked'), 'false');

  fireEvent.click(view.getByRole('radio', { name: 'L', exact: true }));
  fireEvent.click(view.getByRole('radio', { name: 'L', exact: true }));
  assert.equal(view.getByRole('radio', { name: 'L', exact: true }).getAttribute('aria-checked'), 'false');
  fireEvent.click(view.getByRole('radio', { name: 'XL', exact: true }));
  await submitBoth();
  assert.deepEqual(mints, [[1, 'XL']]);
  assert.deepEqual(payments, [[1, 'XL']]);

  view.rerender(createElement(MintPanel, {
    ...props,
    stats: { ...props.stats!, mintSelectionAvailability: { L: 5, XL: 0, '2XL': 0 } },
  }));
  assert.equal(view.getByRole('radio', { name: 'XL', exact: true }).getAttribute('aria-checked'), 'false');
  await submitBoth();
  assert.deepEqual(mints, [[1, 'XL']]);
  assert.deepEqual(payments, [[1, 'XL']]);
});

test('size selection resets after a successful mint or after leaving size selection', () => {
  const props = sizedPanelProps();
  const view = render(createElement(MintPanel, props));
  const large = () => view.getByRole('radio', { name: 'L', exact: true });
  assert.equal((large() as HTMLButtonElement).disabled, false);
  fireEvent.click(large());
  assert.equal(large().getAttribute('aria-checked'), 'true');

  view.rerender(createElement(MintPanel, { ...props, successfulMintToken: 1 }));
  assert.equal(large().getAttribute('aria-checked'), 'false');
  fireEvent.click(large());
  view.rerender(createElement(MintPanel, { ...props, successfulMintToken: 1 }));
  assert.equal(large().getAttribute('aria-checked'), 'true');
  view.rerender(createElement(MintPanel, { ...props, successfulMintToken: 1, mintSelection: undefined }));
  assert.equal(view.queryByRole('radiogroup'), null);
  view.rerender(createElement(MintPanel, { ...props, successfulMintToken: 1 }));
  assert.equal(large().getAttribute('aria-checked'), 'false');
});

test('quantity clamps to refreshed limits and resets only when the successful mint token changes', async () => {
  const minted: number[] = [];
  const props = panelProps({ onMint: (quantity) => { minted.push(quantity); } });
  const view = render(createElement(MintPanel, props));
  const quantity = view.getByRole('slider', { name: 'Mint quantity' }) as HTMLInputElement;
  fireEvent.change(quantity, { target: { value: '5' } });
  const refreshed = { ...props, stats: { minted: 12, total: 15, remaining: 3, maxPerTx: 4 } };
  view.rerender(createElement(MintPanel, refreshed));
  assert.equal(quantity.value, '3');
  assert.equal(quantity.max, '3');
  await act(async () => { fireEvent.click(view.getByRole('button', { name: /Mint/ })); });
  assert.deepEqual(minted, [3]);

  view.rerender(createElement(MintPanel, { ...refreshed, stats: { ...refreshed.stats, maxPerTx: 2 } }));
  assert.equal(quantity.value, '2');
  assert.equal(quantity.max, '2');
  view.rerender(createElement(MintPanel, { ...refreshed, successfulMintToken: 1 }));
  assert.equal(quantity.value, '1');
  fireEvent.change(quantity, { target: { value: '2' } });
  view.rerender(createElement(MintPanel, { ...refreshed, successfulMintToken: 1 }));
  assert.equal(quantity.value, '2');
  view.rerender(createElement(MintPanel, { ...refreshed, successfulMintToken: 2 }));
  assert.equal(quantity.value, '1');
});

test('Stripe displays quantity totals from cents and falls back to the supplied price label', () => {
  const props = panelProps({
    stripePaymentVisible: true,
    onStripePaymentClick: () => undefined,
    stripePaymentUnitAmountCents: 1234,
    stripePaymentPriceLabel: '  from $12  ',
  });
  const view = render(createElement(MintPanel, props));
  const quantity = view.getByRole('slider', { name: 'Mint quantity' });
  fireEvent.change(quantity, { target: { value: '3' } });
  assert.ok(view.getByRole('button', { name: /^Checkout\s*\$37\.02$/ }));
  view.rerender(createElement(MintPanel, { ...props, stripePaymentUnitAmountCents: undefined }));
  assert.ok(view.getByRole('button', { name: /^Checkout\s*from \$12 x 3$/ }));
  fireEvent.change(quantity, { target: { value: '1' } });
  assert.ok(view.getByRole('button', { name: /^Checkout\s*from \$12$/ }));
  view.rerender(createElement(MintPanel, { ...props, stripePaymentUnitAmountCents: 0 }));
  assert.ok(view.getByRole('button', { name: /^Checkout\s*\$0\.00$/ }));
  view.rerender(createElement(MintPanel, {
    ...props, stripePaymentUnitAmountCents: undefined, stripePaymentPriceLabel: ' ',
  }));
  assert.equal(view.queryByRole('button', { name: /Checkout/ }), null);
});

test('pending discount mint blocks both payment methods and releases controls after an error', async () => {
  const errors: string[] = [];
  let discountCalls = 0;
  let rejectMint!: (error: Error) => void;
  const pendingMint = new Promise<void>((_resolve, reject) => { rejectMint = reject; });
  const view = render(createElement(MintPanel, panelProps({
    discountAvailable: true,
    discountPriceSol: 0.5,
    onDiscountMint: () => { discountCalls += 1; return pendingMint; },
    onMint: () => assert.fail('A discounted mint must use the discount action'),
    stripePaymentVisible: true,
    stripePaymentUnitAmountCents: 1000,
    onStripePaymentClick: () => assert.fail('Checkout must stay blocked while minting'),
    onError: (message) => { errors.push(message); },
  })));
  const mint = view.getByRole('button', { name: /Mint with discount/ }) as HTMLButtonElement;
  const checkout = view.getByRole('button', { name: /Checkout/ }) as HTMLButtonElement;
  const quantity = view.getByRole('slider', { name: 'Mint quantity' }) as HTMLInputElement;
  fireEvent.click(mint);
  assert.equal(mint.disabled, true);
  assert.equal(checkout.disabled, true);
  assert.equal(quantity.disabled, true);
  assert.match(mint.textContent!, /Minting…/);
  fireEvent.click(mint);
  fireEvent.click(checkout);
  assert.equal(discountCalls, 1);
  await act(async () => rejectMint(new Error('Wallet declined the mint')));
  assert.deepEqual(errors, ['Wallet declined the mint']);
  assert.equal(mint.disabled, false);
  assert.equal(checkout.disabled, false);
  assert.equal(quantity.disabled, false);
});

test('pending Stripe checkout blocks minting and reports a fallback error before allowing retry', async () => {
  const errors: string[] = [];
  let paymentCalls = 0;
  let rejectPayment!: (error: unknown) => void;
  const pendingPayment = new Promise<void>((_resolve, reject) => { rejectPayment = reject; });
  const view = render(createElement(MintPanel, panelProps({
    onMint: () => assert.fail('Minting must stay blocked while opening Stripe'),
    stripePaymentVisible: true,
    stripePaymentUnitAmountCents: 1000,
    onStripePaymentClick: () => {
      paymentCalls += 1;
      return paymentCalls === 1 ? pendingPayment : Promise.resolve();
    },
    onError: (message) => { errors.push(message); },
  })));
  const mint = view.getByRole('button', { name: /Mint/ }) as HTMLButtonElement;
  const checkout = view.getByRole('button', { name: /Checkout/ }) as HTMLButtonElement;
  const quantity = view.getByRole('slider', { name: 'Mint quantity' }) as HTMLInputElement;
  fireEvent.click(checkout);
  assert.ok(view.getByRole('button', { name: 'Opening Stripe…' }));
  assert.equal(checkout.disabled, true);
  assert.equal(mint.disabled, true);
  assert.equal(quantity.disabled, true);
  fireEvent.click(checkout);
  fireEvent.click(mint);
  assert.equal(paymentCalls, 1);
  await act(async () => rejectPayment({ reason: 'network unavailable' }));
  assert.deepEqual(errors, ['Failed to start Stripe payment']);
  assert.equal(checkout.disabled, false);
  assert.equal(mint.disabled, false);
  assert.equal(quantity.disabled, false);
  await act(async () => { fireEvent.click(checkout); });
  assert.equal(paymentCalls, 2);
  assert.equal(checkout.disabled, false);
});

test('drop title and accessible X profile stay grouped separately from availability', () => {
  const view = render(createElement(MintPanel, stripeOnlyProps()));
  const title = view.getByText('Card NFT Binder');
  const profile = view.getByRole('link', { name: 'Open @bis__cut on X' });
  assert.equal(profile.getAttribute('href'), 'https://x.com/bis__cut/status/2082471519683326394');
  const titleGroup = title.closest('.mint-panel__price');
  assert.ok(titleGroup?.contains(profile));
  assert.equal(titleGroup.contains(view.getByText('15 / 15 left')), false);
});

test('upcoming drops expose their profile and notification action', () => {
  let notifications = 0;
  const view = render(createElement(MintPanel, panelProps({
    stats: undefined,
    title: 'Clear Cards',
    dropId: 'clear_cards',
    terminalAction: {
      statusText: 'Soon',
      buttonText: 'Notify Me',
      onClick: () => { notifications += 1; },
    },
  })));
  assert.ok(view.getByText('Clear Cards'));
  assert.equal(view.getByRole('link', { name: 'Open @gucci4mycat on X' }).getAttribute('href'), 'https://x.com/gucci4mycat');
  assert.ok(view.getByText('Soon'));
  fireEvent.click(view.getByRole('button', { name: 'Notify Me' }));
  assert.equal(notifications, 1);
});

test('Stripe-only single-item panels submit checkout once and block repeat clicks while pending', async () => {
  const payments: number[] = [];
  let finishPayment!: () => void;
  const payment = new Promise<void>((resolve) => { finishPayment = resolve; });
  const view = render(createElement(MintPanel, stripeOnlyProps({
    onStripePaymentClick: (quantity) => { payments.push(quantity); return payment; },
    onMint: () => assert.fail('Stripe-only checkout must not mint with SOL'),
  })));
  const checkout = view.getByRole('button', { name: /Checkout/ }) as HTMLButtonElement;
  assert.match(checkout.textContent!, /\$100\.00/);
  assert.equal(view.queryByRole('slider'), null);
  assert.equal(view.queryByRole('button', { name: /Mint/ }), null);
  assert.equal(checkout.disabled, false);

  fireEvent.click(checkout);
  assert.equal(checkout.disabled, true);
  fireEvent.click(checkout);
  assert.deepEqual(payments, [1]);
  await act(async () => finishPayment());
  assert.equal(checkout.disabled, false);
});

test('Stripe-only drops poll mint progress unless they are forced sold out', () => {
  assert.equal(
    shouldFetchMintProgress({
      salesMode: 'stripe_receipt_only',
      forceSoldOut: false,
    }),
    true,
  );
  assert.equal(
    shouldFetchMintProgress({
      salesMode: 'stripe_receipt_only',
      forceSoldOut: true,
    }),
    false,
  );
  assert.equal(shouldFetchMintProgress(null), false);
});

test('Stripe checkout disappears when refreshed mint progress reaches zero remaining', () => {
  const props = stripeOnlyProps();
  const view = render(createElement(MintPanel, props));
  assert.ok(view.getByRole('button', { name: /Checkout/ }));
  view.rerender(createElement(MintPanel, {
    ...props,
    stats: { minted: 15, total: 15, remaining: 0, maxPerTx: 1 },
  }));
  assert.ok(view.getByText('Minted Out'));
  assert.ok(view.getByRole('link', { name: 'Open @bis__cut on X' }));
  assert.equal(view.queryByRole('button', { name: /Checkout/ }), null);
});

test('sold-out shared receipt-pool drops offer next-drop notifications', () => {
  let notifications = 0;
  const view = render(createElement(MintPanel, stripeOnlyProps({
    stats: { minted: 15, total: 15, remaining: 0, maxPerTx: 1 },
    receiptPoolId: 'mons_shop_receipts',
    onNotifyNextDrops: () => { notifications += 1; },
  })));
  assert.ok(view.getByText('Sold Out'));
  assert.equal(view.queryByText('Minted Out'), null);
  assert.equal(view.queryByRole('link', { name: /Magic Eden|Tensor/ }), null);
  assert.equal(view.queryByRole('button', { name: /Checkout/ }), null);
  fireEvent.click(view.getByRole('button', { name: 'Notify me' }));
  assert.equal(notifications, 1);
});

test('sold-out Card NFT 2 keeps all three marketplaces in its responsive row', () => {
  const view = render(createElement(MintPanel, panelProps({
    stats: { minted: 100, total: 100, remaining: 0, maxPerTx: 1 },
    title: 'Card NFT 2',
    dropId: 'card_nft_2',
    maxSupply: 100,
    maxPerTx: 1,
  })));
  const row = view.getByRole('link', { name: 'Magic Eden' }).closest('.mint-panel__terminal-buttons--triple');
  assert.ok(row);
  assert.deepEqual(within(row as HTMLElement).getAllByRole('link').map((link) => link.textContent), ['Magic Eden', 'Tensor', 'OpenSea']);
  assert.equal(within(row as HTMLElement).getByRole('link', { name: 'OpenSea' }).getAttribute('href'), 'https://opensea.io/collection/cardnft2');
});
