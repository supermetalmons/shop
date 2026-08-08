import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { canRestoreFocus, focusFirstControl } from '../lib/focusTrap';
import {
  combineBackgroundBlurStates,
  DEFAULT_BACKGROUND_BLUR_RADIUS,
  normalizeBackgroundBlurState,
  sameBackgroundBlurState,
  shouldRestoreBackgroundFocus,
  supportsMozElementCapture,
  type BackgroundBlurState,
  type ResolvedBackgroundBlurState,
} from '../lib/backgroundBlur';

export type { BackgroundBlurState } from '../lib/backgroundBlur';

type BackgroundBlurContextValue = {
  update: (token: symbol, state: ResolvedBackgroundBlurState) => void;
  remove: (token: symbol) => void;
  leadingPortalHost: HTMLElement | null;
  trailingPortalHost: HTMLElement | null;
};

const BackgroundBlurContext = createContext<BackgroundBlurContextValue | null>(null);
const BACKGROUND_BLUR_VIEWPORT_HEIGHT =
  'calc(100dvh - var(--page-padding-top) - var(--page-padding-bottom))';

export function useBackgroundBlur(
  request: BackgroundBlurState,
): ResolvedBackgroundBlurState {
  const context = useContext(BackgroundBlurContext);
  const update = context?.update;
  const remove = context?.remove;
  const tokenRef = useRef(Symbol('background-blur'));
  const state = normalizeBackgroundBlurState(request);

  useLayoutEffect(() => {
    if (!remove) return undefined;
    const token = tokenRef.current;
    return () => remove(token);
  }, [remove]);

  useLayoutEffect(() => {
    update?.(tokenRef.current, state);
  }, [state.active, state.open, state.radius, update]);

  return state;
}

export function BackgroundBlurProvider({ children }: { children: ReactNode }) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const lastFocusedElementRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const requestsRef = useRef(new Map<symbol, ResolvedBackgroundBlurState>());
  const stateRef = useRef<ResolvedBackgroundBlurState>({
    open: false,
    active: false,
    radius: DEFAULT_BACKGROUND_BLUR_RADIUS,
  });
  const wasOpenRef = useRef(false);
  const [state, setState] = useState<ResolvedBackgroundBlurState>(stateRef.current);
  const [metrics, setMetrics] = useState({ scrollY: 0, containerHeight: 0 });
  const [leadingPortalHost, setLeadingPortalHost] = useState<HTMLElement | null>(null);
  const [trailingPortalHost, setTrailingPortalHost] = useState<HTMLElement | null>(null);

  const commitRequests = useCallback(() => {
    const next = combineBackgroundBlurStates(requestsRef.current.values());
    const previous = stateRef.current;
    if (sameBackgroundBlurState(previous, next)) return;

    if (next.open && !previous.open) {
      const activeElement = document.activeElement;
      returnFocusRef.current =
        activeElement instanceof HTMLElement && layerRef.current?.contains(activeElement)
          ? activeElement
          : lastFocusedElementRef.current;
      setMetrics({
        scrollY: window.scrollY,
        containerHeight: layerRef.current?.getBoundingClientRect().height ?? 0,
      });
    }

    stateRef.current = next;
    setState(next);
  }, []);

  const update = useCallback(
    (token: symbol, request: ResolvedBackgroundBlurState) => {
      requestsRef.current.set(token, request);
      commitRequests();
    },
    [commitRequests],
  );

  const remove = useCallback(
    (token: symbol) => {
      if (!requestsRef.current.delete(token)) return;
      commitRequests();
    },
    [commitRequests],
  );

  const contextValue = useMemo(
    () => ({ update, remove, leadingPortalHost, trailingPortalHost }),
    [leadingPortalHost, remove, trailingPortalHost, update],
  );

  useEffect(() => {
    const rememberFocusedElement = (event: FocusEvent) => {
      if (!(event.target instanceof HTMLElement) || event.target === document.body) return;
      if (!layerRef.current?.contains(event.target)) return;
      lastFocusedElementRef.current = event.target;
    };

    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLElement &&
      activeElement !== document.body &&
      layerRef.current?.contains(activeElement)
    ) {
      lastFocusedElementRef.current = activeElement;
    }

    document.addEventListener('focusin', rememberFocusedElement);
    return () => document.removeEventListener('focusin', rememberFocusedElement);
  }, []);

  useLayoutEffect(() => {
    if (
      !supportsMozElementCapture(typeof CSS === 'undefined' ? undefined : CSS)
    ) {
      return undefined;
    }

    let frameId = 0;
    let lastScrollY: number | undefined;
    const applyScrollPosition = () => {
      frameId = 0;
      const scrollY = window.scrollY;
      if (scrollY === lastScrollY) return;
      lastScrollY = scrollY;
      document.documentElement.style.setProperty(
        '--background-blur-source-scroll-y',
        `${scrollY}px`,
      );
    };
    const scheduleScrollPosition = () => {
      if (frameId) return;
      frameId = window.requestAnimationFrame(applyScrollPosition);
    };

    applyScrollPosition();
    window.addEventListener('scroll', scheduleScrollPosition, { passive: true });
    window.visualViewport?.addEventListener('scroll', scheduleScrollPosition, { passive: true });
    return () => {
      if (frameId) window.cancelAnimationFrame(frameId);
      window.removeEventListener('scroll', scheduleScrollPosition);
      window.visualViewport?.removeEventListener('scroll', scheduleScrollPosition);
      document.documentElement.style.removeProperty('--background-blur-source-scroll-y');
    };
  }, []);

  useLayoutEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = state.open;
    if (!wasOpen || state.open) return;

    const preferredTarget = returnFocusRef.current;
    returnFocusRef.current = null;
    const activeElement = document.activeElement;
    const activeElementIsRestorable =
      activeElement instanceof HTMLElement &&
      activeElement !== document.body &&
      canRestoreFocus(activeElement);
    if (
      !shouldRestoreBackgroundFocus({
        activeElementIsRestorable,
        activeElementIsInBackground:
          activeElement instanceof HTMLElement &&
          Boolean(layerRef.current?.contains(activeElement)),
      })
    ) {
      return;
    }
    if (preferredTarget && canRestoreFocus(preferredTarget)) {
      preferredTarget.focus({ preventScroll: true });
      if (document.activeElement === preferredTarget) return;
    }
    const layer = layerRef.current;
    if (!layer) return;
    const fallbackTarget = layer.querySelector<HTMLElement>(
      '[data-background-blur-focus-fallback]',
    );
    if (fallbackTarget && canRestoreFocus(fallbackTarget)) {
      fallbackTarget.focus({ preventScroll: true });
      if (document.activeElement === fallbackTarget) return;
    }
    focusFirstControl(layer);
  }, [state.open]);

  const layerStyle = state.open
    ? ({
        '--background-blur-container-height': metrics.containerHeight
          ? `${metrics.containerHeight}px`
          : BACKGROUND_BLUR_VIEWPORT_HEIGHT,
        '--background-blur-scroll-y': `${metrics.scrollY}px`,
        '--background-blur-radius': `${state.radius}px`,
      } as CSSProperties)
    : undefined;

  return (
    <BackgroundBlurContext.Provider value={contextValue}>
      <div
        ref={layerRef}
        className={`background-blur-layer${state.open ? ' background-blur-layer--open' : ''}`}
        style={layerStyle}
        inert={state.open || undefined}
        aria-hidden={state.open ? 'true' : undefined}
      >
        <div
          className={`background-blur-layer__viewport${
            state.active ? ' background-blur-layer__viewport--active' : ''
          }`}
        >
          <div
            id="background-blur-leading-portals-source"
            ref={setLeadingPortalHost}
            className="background-blur-layer__portals"
          />
          <div id="background-blur-source" className="background-blur-layer__stage">
            {children}
          </div>
          <div
            id="background-blur-portals-source"
            ref={setTrailingPortalHost}
            className="background-blur-layer__portals"
          />
        </div>
      </div>
    </BackgroundBlurContext.Provider>
  );
}

type BackgroundBlurPortalProps = BackgroundBlurState & {
  children: ReactNode;
};

export function BackgroundBlurPortal({
  open,
  active,
  radius = DEFAULT_BACKGROUND_BLUR_RADIUS,
  children,
}: BackgroundBlurPortalProps) {
  const state = useBackgroundBlur({ open, active, radius });
  if (!state.open) return null;
  if (typeof document === 'undefined') return <>{children}</>;
  return createPortal(children, document.body);
}

export function BackgroundLayerPortal({
  children,
  placement = 'trailing',
}: {
  children: ReactNode;
  placement?: 'leading' | 'trailing';
}) {
  const context = useContext(BackgroundBlurContext);
  if (typeof document === 'undefined') return <>{children}</>;
  const portalHost = context
    ? placement === 'leading'
      ? context.leadingPortalHost
      : context.trailingPortalHost
    : document.body;
  if (!portalHost) return null;
  return createPortal(children, portalHost);
}

export function BodyPortal({ children }: { children: ReactNode }) {
  if (typeof document === 'undefined') return <>{children}</>;
  return createPortal(children, document.body);
}
