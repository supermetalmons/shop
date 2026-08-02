import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MintPanel } from '../src/components/MintPanel.tsx';
import { shouldFetchMintProgress } from '../src/hooks/useMintProgress.ts';
import { resolveDropXProfile } from '../src/lib/dropSocialLinks.ts';

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

test('drop X profile is grouped with the drop name while availability stays separate', () => {
  const markup = renderToStaticMarkup(
    createElement(MintPanel, {
      stats: {
        minted: 0,
        total: 15,
        remaining: 15,
        maxPerTx: 1,
      },
      onMint: () => undefined,
      busy: false,
      title: 'Card NFT Binder',
      dropId: 'card_nft_binder',
      priceSol: 1,
      discountPriceSol: 1,
      maxSupply: 15,
      maxPerTx: 1,
    }),
  );

  const profilePosition = markup.indexOf('class="mint-panel__social-link"');
  const titlePosition = markup.indexOf('class="mint-panel__price"');
  const remainingPosition = markup.indexOf('class="mint-panel__remaining"');

  assert.ok(profilePosition >= 0);
  assert.ok(titlePosition >= 0);
  assert.ok(remainingPosition >= 0);
  assert.ok(titlePosition < profilePosition);
  assert.ok(profilePosition < remainingPosition);
  assert.match(markup, /href="https:\/\/x\.com\/bis__cut\/status\/2082471519683326394"/);
  assert.match(markup, /<div class="mint-panel__price"><span class="mint-panel__drop-name">Card NFT Binder<\/span><a class="mint-panel__social-link"[^>]*aria-label="Open @bis__cut on X"><svg viewBox="26\.8 48 460\.2 416"[^>]*>/);
  assert.doesNotMatch(markup, />@bis__cut<\/a>/);
  assert.doesNotMatch(markup, /mint-panel__social-separator|•/);
});

test('upcoming drop X profile stays with the drop name instead of the Soon label', () => {
  const markup = renderToStaticMarkup(
    createElement(MintPanel, {
      onMint: () => undefined,
      busy: false,
      title: 'Clear Cards',
      dropId: 'clear_cards',
      priceSol: 0,
      discountPriceSol: 0,
      maxSupply: 1,
      maxPerTx: 1,
      terminalAction: {
        statusText: 'Soon',
        buttonText: 'Notify Me',
        onClick: () => undefined,
      },
    }),
  );

  assert.match(markup, /<span class="mint-panel__drop-name">Clear Cards<\/span><a class="mint-panel__social-link"[^>]*aria-label="Open @gucci4mycat on X"><svg viewBox="26\.8 48 460\.2 416"[^>]*>/);
  assert.match(markup, /<div class="mint-panel__remaining mint-panel__remaining--with-info"><span>Soon<\/span>/);
});

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

  assert.match(markup, /<span class="mint-panel__drop-name">Card NFT Binder<\/span><a class="mint-panel__social-link"[^>]*aria-label="Open @bis__cut on X"><svg viewBox="26\.8 48 460\.2 416"[^>]*>/);
  assert.match(markup, /<div class="mint-panel__remaining mint-panel__remaining--with-info"><span>Minted Out<\/span>/);
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
  assert.doesNotMatch(markup, /Minted Out|Magic Eden|Tensor|>Checkout</);
});
