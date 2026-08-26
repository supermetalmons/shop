import { IRL_CLAIM_CODE_NAMESPACE } from '../../cloud/workers/api/src/claimCodes.ts';
import {
  PACK_STATUS_SUPPORTED_DROP_IDS,
  buildPackStatusBreakdown,
  buildPackStatusCountersFromRebuildInputs,
  deliveryOrderBoxAssetIds,
  isPackStatusSupportedDropId,
  shouldTrackPackStatusForDrop,
} from '../../shared/packStatus.ts';
import type {
  PackStatusCounters,
  PackStatusDeliveryOrderRecord,
  PackStatusDropRuntime,
} from '../../shared/packStatus.ts';

export {
  PACK_STATUS_SUPPORTED_DROP_IDS,
  buildPackStatusBreakdown,
  buildPackStatusCountersFromRebuildInputs,
  deliveryOrderBoxAssetIds,
  isPackStatusSupportedDropId,
  shouldTrackPackStatusForDrop,
};
export type {
  PackStatusCounters,
  PackStatusDeliveryOrderRecord,
  PackStatusDropRuntime,
};

export function assignmentHasNormalInFlightPackStatusClaim(assignment: any): boolean {
  return assignment?.irlClaim?.namespace !== IRL_CLAIM_CODE_NAMESPACE;
}
