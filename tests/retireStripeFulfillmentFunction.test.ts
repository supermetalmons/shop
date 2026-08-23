import assert from 'node:assert/strict';
import test from 'node:test';
import { retireStripeFulfillmentTestHooks } from '../scripts/retire-stripe-checkout-fulfillment-function.ts';

const VERSION = '839c6586-102c-4daa-9feb-297c21bd2697';

test('Stripe fulfillment retirement requires exact production proof arguments', () => {
  assert.deepEqual(retireStripeFulfillmentTestHooks.parseArgs([
    '--api-version-id', VERSION,
    '--drop-id', 'card_nft_binder_devnet',
    '--session-id', 'cs_test_retirement',
    '--confirm',
  ]), {
    apiVersionId: VERSION,
    dropId: 'card_nft_binder_devnet',
    sessionId: 'cs_test_retirement',
    confirm: true,
  });
  assert.throws(() => retireStripeFulfillmentTestHooks.parseArgs([
    '--api-version-id', VERSION,
    '--drop-id', 'card_nft_binder_devnet',
    '--session-id', 'cs_test_retirement',
  ]), /requires --confirm/);
  assert.throws(() => retireStripeFulfillmentTestHooks.parseArgs([
    '--api-version-id', VERSION,
    '--drop-id', 'card_nft_binder',
    '--session-id', 'cs_test_retirement',
    '--confirm',
  ]), /must use card_nft_binder_devnet/);
});
