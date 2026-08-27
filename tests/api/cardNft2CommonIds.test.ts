import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { CARD_NFT_2_MAX_CARD_ID } from '../../shared/cardNft2AssetCore.ts';
import { CARD_NFT_2_COMMON_CARD_ID_VALUES } from '../../shared/cardNft2CommonIds.ts';
import {
  CARD_NFT_2_COMMON_CARD_IDS,
  CARD_NFT_2_COMMON_CARD_ID_SET,
} from '../../shared/cardNft2RevealIds.ts';

const EXPECTED_SHA256 = 'fb8354b3f0cf919a620bc7b8e086b825f80a1d213b63aa07ce433d10218c99df';

test('card_nft_2 common ids retain their exact mainnet assignment set and order', () => {
  assert.equal(CARD_NFT_2_COMMON_CARD_IDS, CARD_NFT_2_COMMON_CARD_ID_VALUES);
  assert.equal(Object.isFrozen(CARD_NFT_2_COMMON_CARD_IDS), true);
  assert.equal(CARD_NFT_2_COMMON_CARD_IDS.length, 4_983);
  assert.equal(CARD_NFT_2_COMMON_CARD_ID_SET.size, CARD_NFT_2_COMMON_CARD_IDS.length);
  assert.equal(
    createHash('sha256').update(CARD_NFT_2_COMMON_CARD_IDS.join(',')).digest('hex'),
    EXPECTED_SHA256,
  );
  for (const cardId of CARD_NFT_2_COMMON_CARD_IDS) {
    assert.equal(Number.isInteger(cardId), true);
    assert.equal(cardId >= 1 && cardId <= CARD_NFT_2_MAX_CARD_ID, true);
  }
});
