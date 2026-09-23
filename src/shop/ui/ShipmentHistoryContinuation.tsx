import { useEffect, useRef } from 'react';
import type { useShipmentHistory } from '../../hooks/useShipmentHistory';

type ShipmentHistoryContinuationProps = Pick<ReturnType<typeof useShipmentHistory>,
  'hasMore' | 'fetching' | 'loadingMore' | 'error' | 'fetchMore' | 'retry'
>;

export function ShipmentHistoryContinuation({
  hasMore, fetching, loadingMore, error, fetchMore, retry,
}: ShipmentHistoryContinuationProps) {
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!hasMore || fetching || error || !sentinel.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void fetchMore().catch(() => undefined);
    }, { rootMargin: '400px' });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [error, fetchMore, fetching, hasMore]);
  if (!hasMore && !error) return null;
  return (
    <div ref={sentinel} className="muted small" aria-live="polite">
      {error ? (
        <>
          Unable to load shipments.{' '}
          <button type="button" disabled={fetching} onClick={() => { void retry().catch(() => undefined); }}>Retry</button>
        </>
      ) : loadingMore ? 'Loading older shipments…' : (
        <button type="button" disabled={fetching} onClick={() => { void fetchMore().catch(() => undefined); }}>Load older shipments</button>
      )}
    </div>
  );
}
