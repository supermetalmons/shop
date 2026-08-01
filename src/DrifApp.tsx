import { useCallback, useEffect, useMemo, useState } from 'react';
import { NotifySubscription } from './components/NotifySubscription';
import { ShopHeader } from './components/ShopHeader';
import { SuccessHud, useSuccessHud } from './components/SuccessHud';
import DrifEffectCard from './components/DrifEffectCard';
import { DRIF_SHOWCASE_CARDS } from './drifCards';

const DRIF_SHOWCASE_PRELOAD_WINDOW = 6;

export default function DrifApp() {
  const [cardIndex, setCardIndex] = useState(() => Math.floor(Math.random() * DRIF_SHOWCASE_CARDS.length));
  const [notifyOpen, setNotifyOpen] = useState(false);
  const { phase: successHudPhase, announcement: successAnnouncement, show: showSuccessHud } = useSuccessHud();
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
      <SuccessHud phase={successHudPhase} announcement={successAnnouncement} />
      <NotifySubscription open={notifyOpen} onOpenChange={setNotifyOpen} onSubscribed={showSuccessHud} />
      <ShopHeader scrollHomeToTop />
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
