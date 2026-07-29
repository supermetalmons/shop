import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MintPanel } from '../src/components/MintPanel.tsx';
import { shouldFetchMintProgress } from '../src/hooks/useMintProgress.ts';

test('Stripe-only single-item mint panels render checkout without a SOL mint action', () => {
  const markup = renderToStaticMarkup(
    createElement(MintPanel, {
      stats: {
        minted: 0,
        total: 15,
        remaining: 15,
        maxPerTx: 1,
      },
      onMint: () => undefined,
      solanaMintVisible: false,
      busy: false,
      title: 'Card NFT Binder',
      boxNamePrefix: 'binder',
      dropId: 'card_nft_binder',
      priceSol: 1_000_000,
      discountPriceSol: 1_000_000,
      maxSupply: 15,
      maxPerTx: 1,
      onStripePaymentClick: () => undefined,
      stripePaymentVisible: true,
      stripePaymentUnitAmountCents: 10_000,
    }),
  );

  assert.match(markup, />Checkout</);
  assert.match(markup, />\$100\.00</);
  assert.doesNotMatch(markup, /type="range"/);
  assert.doesNotMatch(markup, /mint-panel__submit/);
  assert.doesNotMatch(markup, /mint-panel__cta-stack--with-payment/);
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

test('Stripe checkout is hidden when mint progress reports zero remaining', () => {
  const markup = renderToStaticMarkup(
    createElement(MintPanel, {
      stats: {
        minted: 15,
        total: 15,
        remaining: 0,
        maxPerTx: 1,
      },
      onMint: () => undefined,
      solanaMintVisible: false,
      busy: false,
      title: 'Card NFT Binder',
      boxNamePrefix: 'binder',
      dropId: 'card_nft_binder',
      priceSol: 1_000_000,
      discountPriceSol: 1_000_000,
      maxSupply: 15,
      maxPerTx: 1,
      onStripePaymentClick: () => undefined,
      stripePaymentVisible: true,
      stripePaymentUnitAmountCents: 10_000,
    }),
  );

  assert.match(markup, />Minted out</);
  assert.doesNotMatch(markup, />Checkout</);
});

test('sold-out shared receipt-pool drops replace marketplaces with the next-drop notification action', () => {
  const markup = renderToStaticMarkup(
    createElement(MintPanel, {
      stats: {
        minted: 15,
        total: 15,
        remaining: 0,
        maxPerTx: 1,
      },
      onMint: () => undefined,
      solanaMintVisible: false,
      busy: false,
      title: 'Card NFT Binder',
      boxNamePrefix: 'binder',
      dropId: 'card_nft_binder',
      receiptPoolId: 'mons_shop_receipts',
      priceSol: 1_000_000,
      discountPriceSol: 1_000_000,
      maxSupply: 15,
      maxPerTx: 1,
      onStripePaymentClick: () => undefined,
      stripePaymentVisible: true,
      stripePaymentUnitAmountCents: 10_000,
      onNotifyNextDrops: () => undefined,
    }),
  );

  assert.match(markup, />Sold Out</);
  assert.match(markup, />Notify me</);
  assert.doesNotMatch(markup, /Minted out|Magic Eden|Tensor|>Checkout</);
});
