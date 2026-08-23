const ADMIN_IRL_REDEEM_DROP_FAMILY = 'card_nft_2' as const;

export type AdminIrlRedeemTargetKind = 'pack' | 'card_receipt';

export type AdminIrlRedeemTargetEligibility =
  | {
      eligible: true;
      targetKind: AdminIrlRedeemTargetKind;
    }
  | {
      eligible: false;
      reason: 'empty-pack-selection' | 'invalid-card-receipt-count';
    };

export function isAdminIrlRedeemDropFamily(dropFamily: unknown): boolean {
  return dropFamily === ADMIN_IRL_REDEEM_DROP_FAMILY;
}

export function getAdminIrlRedeemTargetEligibility(args: {
  targetKind: AdminIrlRedeemTargetKind;
  itemCount: number;
}): AdminIrlRedeemTargetEligibility {
  if (args.targetKind === 'card_receipt') {
    return args.itemCount === 1
      ? { eligible: true, targetKind: args.targetKind }
      : { eligible: false, reason: 'invalid-card-receipt-count' };
  }
  return args.itemCount > 0
    ? { eligible: true, targetKind: args.targetKind }
    : { eligible: false, reason: 'empty-pack-selection' };
}
