import React from 'react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import App, { type ClearCardBackgroundBlurState } from './App';
import { WalletContextProvider } from './wallet/WalletContext';
import type { SolanaCluster } from './config/deployment';
import { navigate } from './navigation';
import { canRestoreFocus, focusFirstControl } from './lib/focusTrap';

const CardNft2WipApp = React.lazy(() => import('./WipApp'));
const ClearCardWipApp = React.lazy(() => import('./ClearCardWipApp'));
const CLEAR_CARD_BLUR_VIEWPORT_HEIGHT =
  'calc(100dvh - var(--page-padding-top) - var(--page-padding-bottom))';

type ShopWipExperience = 'card_nft_2' | 'clear_cards';

type WipRouteShellProps = {
  experience: ShopWipExperience;
  status: 'loading' | 'error';
};

function WipRouteShell({ experience, status }: WipRouteShellProps) {
  const pageRef = React.useRef<HTMLDivElement | null>(null);
  const clearCard = experience === 'clear_cards';

  React.useLayoutEffect(() => {
    pageRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div
      ref={pageRef}
      role="dialog"
      aria-modal="true"
      aria-label={clearCard ? 'Clear card sample' : 'Card pack preview'}
      tabIndex={-1}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1110,
        overflow: 'hidden',
        touchAction: 'none',
        outline: 'none',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          backdropFilter: clearCard ? 'none' : 'blur(18px)',
          WebkitBackdropFilter: clearCard ? 'none' : 'blur(18px)',
        }}
      />
      {status === 'error' || !clearCard ? (
        <div
          role={status === 'error' ? 'alert' : 'status'}
          aria-live="polite"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            color: 'color-mix(in srgb, var(--fg) 52%, transparent)',
            fontSize: 12,
            lineHeight: 1.35,
          }}
        >
          {status === 'error' ? 'Unable to load preview.' : 'Loading…'}
        </div>
      ) : null}
      <button
        type="button"
        className="wip-close-btn"
        onClick={() => navigate('/')}
        aria-label={clearCard ? 'Close clear card viewer' : 'Close card pack preview'}
      >
        Close
      </button>
    </div>
  );
}

type WipRouteErrorBoundaryProps = {
  experience: ShopWipExperience;
  children: React.ReactNode;
};

type WipRouteErrorBoundaryState = {
  failed: boolean;
};

class WipRouteErrorBoundary extends React.Component<
  WipRouteErrorBoundaryProps,
  WipRouteErrorBoundaryState
> {
  state: WipRouteErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): WipRouteErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error('[mons] failed to load a WIP experience', error);
  }

  render() {
    if (this.state.failed) {
      return <WipRouteShell experience={this.props.experience} status="error" />;
    }
    return this.props.children;
  }
}

function WipWalletModalGuard({ active }: { active: boolean }) {
  const { visible, setVisible } = useWalletModal();

  React.useLayoutEffect(() => {
    if (active && visible) {
      setVisible(false);
    }
  }, [active, setVisible, visible]);

  return null;
}

type ShopRouteProps = {
  cluster: SolanaCluster;
  currentPath: string;
  claimDeepLinkCode?: string | null;
  wipExperience?: ShopWipExperience | null;
};

export default function ShopRoute({
  cluster,
  currentPath,
  claimDeepLinkCode = null,
  wipExperience = null,
}: ShopRouteProps) {
  const isWipRoute = wipExperience !== null;
  const isClearCardWipRoute = wipExperience === 'clear_cards';
  const appContainerRef = React.useRef<HTMLDivElement | null>(null);
  const lastFocusedElementRef = React.useRef<HTMLElement | null>(null);
  const clearCardReturnFocusRef = React.useRef<HTMLElement | null>(null);
  const wasWipRouteRef = React.useRef(isWipRoute);
  const wasClearCardBlurOpenRef = React.useRef(false);
  const clearCardBlurStateRef = React.useRef<ClearCardBackgroundBlurState>({
    open: false,
    active: false,
  });
  const [clearCardBlurState, setClearCardBlurState] =
    React.useState<ClearCardBackgroundBlurState>(clearCardBlurStateRef.current);
  const [clearCardBlurMetrics, setClearCardBlurMetrics] = React.useState({
    scrollY: 0,
    containerHeight: 0,
  });

  const restoreAppFocus = React.useCallback((preferredTarget: HTMLElement | null) => {
    if (preferredTarget && canRestoreFocus(preferredTarget)) {
      preferredTarget.focus({ preventScroll: true });
      return;
    }

    const appContainer = appContainerRef.current;
    if (!appContainer) return;
    const appMenuButton = appContainer.querySelector<HTMLElement>('[aria-label="App menu"]');
    if (appMenuButton && canRestoreFocus(appMenuButton)) {
      appMenuButton.focus({ preventScroll: true });
      return;
    }
    focusFirstControl(appContainer);
  }, []);

  const handleClearCardBackgroundBlurChange = React.useCallback(
    (next: ClearCardBackgroundBlurState) => {
      const previous = clearCardBlurStateRef.current;
      if (next.open && !previous.open) {
        const activeElement = document.activeElement;
        clearCardReturnFocusRef.current =
          activeElement instanceof HTMLElement && appContainerRef.current?.contains(activeElement)
            ? activeElement
            : lastFocusedElementRef.current;
        setClearCardBlurMetrics({
          scrollY: window.scrollY,
          containerHeight: appContainerRef.current?.getBoundingClientRect().height ?? 0,
        });
      }
      clearCardBlurStateRef.current = next;
      setClearCardBlurState((current) =>
        current.open === next.open && current.active === next.active ? current : next,
      );
    },
    [],
  );

  React.useEffect(() => {
    if (isWipRoute) return undefined;

    const rememberFocusedElement = (event: FocusEvent) => {
      if (!(event.target instanceof HTMLElement) || event.target === document.body) return;
      if (!appContainerRef.current?.contains(event.target)) return;
      lastFocusedElementRef.current = event.target;
    };
    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLElement &&
      activeElement !== document.body &&
      appContainerRef.current?.contains(activeElement)
    ) {
      lastFocusedElementRef.current = activeElement;
    }
    document.addEventListener('focusin', rememberFocusedElement);
    return () => document.removeEventListener('focusin', rememberFocusedElement);
  }, [isWipRoute]);

  const clearCardBlurOpen =
    isClearCardWipRoute || (!isWipRoute && clearCardBlurState.open);

  React.useLayoutEffect(() => {
    const wasClearCardBlurOpen = wasClearCardBlurOpenRef.current;
    wasClearCardBlurOpenRef.current = clearCardBlurOpen;

    if (isWipRoute) {
      clearCardReturnFocusRef.current = null;
      return;
    }
    if (!wasClearCardBlurOpen || clearCardBlurOpen) return;

    const previousFocus = clearCardReturnFocusRef.current;
    clearCardReturnFocusRef.current = null;
    restoreAppFocus(previousFocus);
  }, [clearCardBlurOpen, isWipRoute, restoreAppFocus]);

  React.useLayoutEffect(() => {
    const wasWipRoute = wasWipRouteRef.current;
    wasWipRouteRef.current = isWipRoute;
    if (!wasWipRoute || isWipRoute) return;

    restoreAppFocus(lastFocusedElementRef.current);
  }, [isWipRoute, restoreAppFocus]);

  React.useEffect(() => {
    if (!isWipRoute) return undefined;
    const html = document.documentElement;
    const body = document.body;
    html.classList.add('wip-scroll-lock');
    body.classList.add('wip-scroll-lock');
    return () => {
      html.classList.remove('wip-scroll-lock');
      body.classList.remove('wip-scroll-lock');
    };
  }, [isWipRoute]);

  const clearCardBlurActive =
    isClearCardWipRoute || (!isWipRoute && clearCardBlurState.active);
  const backgroundUnavailable = isWipRoute || clearCardBlurOpen;
  const appContainerStyle = clearCardBlurOpen
    ? ({
        '--clear-card-blur-container-height':
          isClearCardWipRoute
            ? CLEAR_CARD_BLUR_VIEWPORT_HEIGHT
            : clearCardBlurMetrics.containerHeight
              ? `${clearCardBlurMetrics.containerHeight}px`
              : CLEAR_CARD_BLUR_VIEWPORT_HEIGHT,
        '--clear-card-blur-scroll-y': `${
          isClearCardWipRoute ? 0 : clearCardBlurMetrics.scrollY
        }px`,
      } as React.CSSProperties)
    : undefined;
  const app = (
    <App
      currentPath={isWipRoute ? '/' : currentPath}
      claimDeepLinkCode={claimDeepLinkCode}
      suspended={isWipRoute}
      onClearCardBackgroundBlurChange={handleClearCardBackgroundBlurChange}
    />
  );

  return (
    <WalletContextProvider cluster={cluster}>
      <WipWalletModalGuard active={isWipRoute} />
      <div
        ref={appContainerRef}
        className={`shop-route__app${
          clearCardBlurOpen ? ' shop-route__app--clear-card-blur-open' : ''
        }`}
        style={appContainerStyle}
        inert={backgroundUnavailable || undefined}
        aria-hidden={backgroundUnavailable ? 'true' : undefined}
      >
        <div
          className={`shop-route__app-viewport${
            clearCardBlurActive ? ' shop-route__app-viewport--clear-card-blur-active' : ''
          }`}
        >
          <div className="shop-route__app-stage">{app}</div>
        </div>
      </div>
      {wipExperience ? (
        <WipRouteErrorBoundary key={wipExperience} experience={wipExperience}>
          <React.Suspense
            fallback={<WipRouteShell experience={wipExperience} status="loading" />}
          >
            {wipExperience === 'card_nft_2' ? <CardNft2WipApp /> : <ClearCardWipApp />}
          </React.Suspense>
        </WipRouteErrorBoundary>
      ) : null}
    </WalletContextProvider>
  );
}
