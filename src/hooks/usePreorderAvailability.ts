import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PreorderAvailabilityResponse, PreorderConfig } from '../../shared/preorders';
import type { createPreorderApi } from '../lib/preorderApi';

export function usePreorderAvailability(config: PreorderConfig, active: boolean, api: Pick<ReturnType<typeof createPreorderApi>, 'availability'>) {
  const scope = useMemo(() => ({ preorderId: config.preorderId }), [config.preorderId]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [state, setState] = useState<{
    scope: typeof scope;
    availability: PreorderAvailabilityResponse | null;
    error: string | null;
  } | null>(null);
  const request = useRef(0);
  const inFlight = useRef<{ scope: typeof scope; requestId: number } | null>(null);

  const refreshAvailability = useCallback(async () => {
    if (currentScope.current !== scope || inFlight.current?.scope === scope) return;
    const requestId = ++request.current;
    inFlight.current = { scope, requestId };
    const isCurrent = () => currentScope.current === scope && request.current === requestId;
    try {
      const availability = await api.availability(scope.preorderId);
      if (availability.preorderId !== scope.preorderId) throw new Error('Preorder collection mismatch.');
      if (isCurrent()) setState({ scope, availability, error: null });
    } catch {
      if (isCurrent()) setState((previous) => ({
        scope,
        availability: previous?.scope === scope ? previous.availability : null,
        error: 'Couldn’t check card availability. Try again.',
      }));
    } finally {
      if (inFlight.current?.requestId === requestId) inFlight.current = null;
    }
  }, [api, scope]);

  useEffect(() => {
    if (!active) return;
    const refresh = () => { if (document.visibilityState !== 'hidden') void refreshAvailability(); };
    refresh();
    const interval = setInterval(refresh, 10_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      request.current += 1;
      inFlight.current = null;
      clearInterval(interval);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [active, refreshAvailability]);

  return {
    availability: state?.scope === scope ? state.availability : null,
    availabilityError: state?.scope === scope ? state.error : null,
    refreshAvailability,
  };
}
