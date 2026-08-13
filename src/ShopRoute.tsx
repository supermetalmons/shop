import React from 'react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import App from './App';
import { BackgroundBlurPortal } from './components/BackgroundBlurLayer';
import { ModalFocusScope } from './components/ModalFocusScope';
import { WalletContextProvider } from './wallet/WalletContext';
import type { SolanaCluster } from './config/deployment';
import { navigate } from './navigation';

const PackWipApp = React.lazy(() => import('./WipApp'));
const ClearCardWipApp = React.lazy(() => import('./ClearCardWipApp'));
type PackWipExperience = 'card_nft_2' | 'little_swag_boxes' | 'poncho_drifella';
type ShopWipExperience = PackWipExperience | 'clear_cards';

type WipRouteShellProps = {
  experience: ShopWipExperience;
  status: 'loading' | 'error';
};

function WipRouteShell({ experience, status }: WipRouteShellProps) {
  const clearCard = experience === 'clear_cards';
  const handleClose = () => navigate('/');

  return (
    <ModalFocusScope
      ariaLabel={clearCard ? 'Clear card sample' : 'Card pack preview'}
      onEscape={handleClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1110,
        overflow: 'hidden',
        touchAction: 'none',
        outline: 'none',
      }}
    >
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
        onClick={handleClose}
        aria-label={clearCard ? 'Close clear card viewer' : 'Close card pack preview'}
      >
        Close
      </button>
    </ModalFocusScope>
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

function WipForeground({
  children,
}: {
  children: React.ReactNode;
}) {
  const { visible, setVisible } = useWalletModal();

  React.useLayoutEffect(() => {
    if (visible) setVisible(false);
  }, [setVisible, visible]);

  return (
    <BackgroundBlurPortal open active>
      {visible ? null : children}
    </BackgroundBlurPortal>
  );
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
    <App
      currentPath={isWipRoute ? '/' : currentPath}
      claimDeepLinkCode={claimDeepLinkCode}
      suspended={isWipRoute}
    />
  );
  const wip = wipExperience ? (
    <WipRouteErrorBoundary key={wipExperience} experience={wipExperience}>
      <React.Suspense fallback={<WipRouteShell experience={wipExperience} status="loading" />}>
        {wipExperience === 'clear_cards' ? (
          <ClearCardWipApp />
        ) : (
          <PackWipApp dropId={wipExperience} />
        )}
      </React.Suspense>
    </WipRouteErrorBoundary>
  ) : null;

  return (
    <WalletContextProvider cluster={cluster}>
      {app}
      {wip ? <WipForeground>{wip}</WipForeground> : null}
    </WalletContextProvider>
  );
}
