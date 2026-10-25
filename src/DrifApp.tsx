import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { NotifySubscription } from './components/NotifySubscription';
import { ShopHeader } from './components/ShopHeader';
import DrifEffectCard from './components/DrifEffectCard';
import { DRIF_SHOWCASE_CARDS } from './drifCards';
import { useSolanaAuth } from './hooks/useSolanaAuth';
import { useHeaderWallet } from './shop/account/useHeaderWallet';
import { useShopSignIn } from './shop/account/useShopSignIn';
import { isUserRejectedError } from './shop/commerce/transactionSupport';
import { ShopWalletControl } from './shop/ui/ShopWalletControl';
import { ShopStatus } from './shop/ui/ShopStatus';
import { useShopFeedback } from './shop/ui/useShopFeedback';

const DRIF_SHOWCASE_PRELOAD_WINDOW = 6;

export default function DrifApp() {
  const [cardIndex, setCardIndex] = useState(() => Math.floor(Math.random() * DRIF_SHOWCASE_CARDS.length));
  const [notifyOpen, setNotifyOpen] = useState(false);
  const wallet = useWallet();
  const { visible: walletModalVisible, setVisible } = useWalletModal();
  const auth = useSolanaAuth();
  const headerSuspended = notifyOpen || walletModalVisible;
  const feedback = useShopFeedback(walletModalVisible);
  const signIn = useShopSignIn({
    auth,
    connectedWallet: wallet.connected ? wallet.publicKey?.toBase58() : undefined,
    publicKey: wallet.publicKey,
    wallet,
    walletModalVisible,
    setVisible,
    showToast: feedback.showToast,
    isUserRejectedError,
  });
  const walletControl = useHeaderWallet({
    auth,
    wallet,
    signIn: signIn.ensureSignedIn,
    joinPendingSignIn: signIn.joinPendingSignIn,
    suspended: notifyOpen,
    walletModalVisible,
    scopeKey: 'notify',
    onBeforeDisconnect: () => setVisible(false),
    showToast: feedback.showToast,
  });
  const currentCard = DRIF_SHOWCASE_CARDS[cardIndex];
  const preloadCards = useMemo(
    () =>
      Array.from(
        { length: Math.min(DRIF_SHOWCASE_PRELOAD_WINDOW, DRIF_SHOWCASE_CARDS.length) },
        (_, offset) => DRIF_SHOWCASE_CARDS[(cardIndex + offset) % DRIF_SHOWCASE_CARDS.length],
      ),
    [cardIndex],
  );

  const handleCardClick = useCallback(() => {
    setCardIndex((prevIndex) => (prevIndex + 1) % DRIF_SHOWCASE_CARDS.length);
  }, []);

  useEffect(() => {
    const body = document.body;
    body.classList.add('drif-body');
    return () => {
      body.classList.remove('drif-body');
    };
  }, []);

  return (
    <div className="drif-page">
      <ShopStatus
        feedback={feedback}
        suspended={headerSuspended}
        toastAboveModal={false}
        successHudClassName="success-hud--drif"
      />
      <NotifySubscription open={notifyOpen} onOpenChange={setNotifyOpen} onSubscribed={feedback.showSuccessHud} />
      <ShopHeader
        scrollHomeToTop
        variant="drif"
        renderRight={({ interactive }) => <ShopWalletControl interactive={interactive} model={walletControl} />}
      />
      <main className="drif-main">
        <div className="drif-card-showcase">
          <DrifEffectCard
            card={currentCard}
            ariaLabel="Expand the Pokemon Card; Custom Card."
            onClick={handleCardClick}
            preserveTransformOnCardChange
            preloadCards={preloadCards}
            disableGlow
          />
        </div>
      </main>
      <button type="button" className="drif-notify-btn" onClick={() => setNotifyOpen(true)}>
        Notify me
      </button>
    </div>
  );
}
