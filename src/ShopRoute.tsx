import React from 'react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import App from './App';
import { WalletContextProvider } from './wallet/WalletContext';
import type { SolanaCluster } from './config/deployment';
import { navigate } from './navigation';
import { canRestoreFocus, focusFirstControl } from './lib/focusTrap';

const CardNft2WipApp = React.lazy(() => import('./WipApp'));
const ClearCardWipApp = React.lazy(() => import('./ClearCardWipApp'));

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
          backdropFilter: 'blur(18px)',
          WebkitBackdropFilter: 'blur(18px)',
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
  const appContainerRef = React.useRef<HTMLDivElement | null>(null);
  const lastFocusedElementRef = React.useRef<HTMLElement | null>(null);
  const wasWipRouteRef = React.useRef(isWipRoute);

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

  React.useLayoutEffect(() => {
    const wasWipRoute = wasWipRouteRef.current;
    wasWipRouteRef.current = isWipRoute;
    if (!wasWipRoute || isWipRoute) return;

    const previousFocus = lastFocusedElementRef.current;
    if (previousFocus && canRestoreFocus(previousFocus)) {
      previousFocus.focus({ preventScroll: true });
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
  }, [isWipRoute]);

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

  const app = (
    <App currentPath={isWipRoute ? '/' : currentPath} claimDeepLinkCode={claimDeepLinkCode} />
  );

  return (
    <WalletContextProvider cluster={cluster}>
      <WipWalletModalGuard active={isWipRoute} />
      <div
        ref={appContainerRef}
        inert={isWipRoute || undefined}
        aria-hidden={isWipRoute ? 'true' : undefined}
      >
        {app}
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
