import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFulfillmentFiltersHref,
  parseFulfillmentFilters,
} from '../src/fulfillment/filters.ts';

test('fulfillment filters restore drop and status selections from the URL', () => {
  assert.deepEqual(
    parseFulfillmentFilters('?dropId=Card_NFT_2&status=shipped&deliveryId=123'),
    { dropId: 'card_nft_2', status: 'shipped' },
  );
});

test('fulfillment filters fall back safely when URL values are absent or invalid', () => {
  assert.deepEqual(parseFulfillmentFilters('?status=unknown'), {
    dropId: '',
    status: 'not_shipped',
  });
});

test('fulfillment filter URLs preserve unrelated parameters and hashes', () => {
  assert.equal(
    buildFulfillmentFiltersHref(
      {
        pathname: '/fulfillment',
        search: '?deliveryId=123&source=email',
        hash: '#order',
      },
      { dropId: 'card_nft_2', status: 'shipped' },
    ),
    '/fulfillment?deliveryId=123&source=email&dropId=card_nft_2&status=shipped#order',
  );
});

test('fulfillment filter URLs omit default selections without disturbing other state', () => {
  assert.equal(
    buildFulfillmentFiltersHref(
      {
        pathname: '/fulfillment',
        search: '?dropId=card_nft_2&status=all&deliveryId=123',
      },
      { dropId: '', status: 'not_shipped' },
    ),
    '/fulfillment?deliveryId=123',
  );
});
