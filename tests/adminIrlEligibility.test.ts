import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getAdminIrlRedeemTargetEligibility,
  isAdminIrlRedeemDropFamily,
} from '../functions/src/shared/adminIrlEligibility.ts';

test('Admin IRL drop eligibility is limited to the card_nft_2 family', () => {
  assert.equal(isAdminIrlRedeemDropFamily('card_nft_2'), true);
  assert.equal(isAdminIrlRedeemDropFamily('little_swag_boxes'), false);
  assert.equal(isAdminIrlRedeemDropFamily(undefined), false);
});

test('Admin IRL target eligibility preserves pack and one-card selection rules', () => {
  assert.deepEqual(
    getAdminIrlRedeemTargetEligibility({
      targetKind: 'pack',
      itemCount: 2,
    }),
    { eligible: true, targetKind: 'pack' },
  );
  assert.deepEqual(
    getAdminIrlRedeemTargetEligibility({
      targetKind: 'pack',
      itemCount: 0,
    }),
    { eligible: false, reason: 'empty-pack-selection' },
  );
  assert.deepEqual(
    getAdminIrlRedeemTargetEligibility({
      targetKind: 'card_receipt',
      itemCount: 1,
    }),
    { eligible: true, targetKind: 'card_receipt' },
  );
  [0, 2].forEach((itemCount) => {
    assert.deepEqual(
      getAdminIrlRedeemTargetEligibility({
        targetKind: 'card_receipt',
        itemCount,
      }),
      { eligible: false, reason: 'invalid-card-receipt-count' },
    );
  });
});
