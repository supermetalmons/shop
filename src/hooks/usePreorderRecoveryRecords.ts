import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { hydratePreorderRecoveries, preorderRecoverySnapshot, subscribePreorderRecoveries, type PreorderRecoveryRecord } from '../lib/preorderRecovery';

export function usePreorderRecoveryRecords(owner?: string): PreorderRecoveryRecord[] {
  const snapshot = useCallback(() => owner ? preorderRecoverySnapshot(owner) : '[]', [owner]);
  const serialized = useSyncExternalStore(subscribePreorderRecoveries, snapshot, () => '[]');
  useEffect(() => {
    if (!owner) return;
    const controller = new AbortController();
    void hydratePreorderRecoveries(owner, controller.signal).catch(() => {});
    return () => controller.abort();
  }, [owner, serialized]);
  return useMemo(() => JSON.parse(serialized) as PreorderRecoveryRecord[], [serialized]);
}
