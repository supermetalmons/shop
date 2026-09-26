import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PreorderAvailabilityResponse, PreorderConfig } from '../../shared/preorders';
import type { createPreorderApi } from '../lib/preorderApi';
import type { MiNoteEthereumSession } from '../../shared/miNoteAuth';
import { ProfileApiError } from '../api/transport';

export function usePreorderAvailability(config: PreorderConfig, active: boolean, api: Pick<ReturnType<typeof createPreorderApi>, 'availability'>,
  session: MiNoteEthereumSession | null, signedInBuyer: string | undefined, onSessionInvalid?: () => void) {
  const scope = useMemo(() => ({ preorderId: config.preorderId, session, signedInBuyer }), [config.preorderId, session, signedInBuyer]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const invalidSession = useRef(onSessionInvalid);
  invalidSession.current = onSessionInvalid;
  const [state, setState] = useState<{
    scope: typeof scope;
    availability: PreorderAvailabilityResponse | null;
    error: string | null;
  } | null>(null);
  const request = useRef(0);
  const inFlight = useRef<{ scope: typeof scope; requestId: number } | null>(null);

  const refreshAvailability = useCallback(async () => {
    if (!scope.session || scope.session.expiresAtMs <= Date.now() || currentScope.current !== scope || inFlight.current?.scope === scope) return;
    const requestId = ++request.current;
    inFlight.current = { scope, requestId };
    const isCurrent = () => currentScope.current === scope && request.current === requestId;
    try {
      const availability = await api.availability(scope.preorderId, scope.session, Boolean(scope.signedInBuyer));
      if (availability.preorderId !== scope.preorderId) throw new Error('Preorder collection mismatch.');
      if (isCurrent()) setState({ scope, availability, error: null });
    } catch (cause) {
      if (isCurrent() && cause instanceof ProfileApiError && cause.status === 401) invalidSession.current?.();
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
    if (!active || !session) return;
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
  }, [active, refreshAvailability, session]);

  return {
    availability: state?.scope === scope ? state.availability : null,
    availabilityError: state?.scope === scope ? state.error : null,
    refreshAvailability,
  };
}
