import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import DrifEffectCard from './components/DrifEffectCard';
import { DRIF_CARDS } from './drifCards';
import { navigate } from './navigation';

export default function DrifApp() {
  const [cardIndex, setCardIndex] = useState(() => Math.floor(Math.random() * DRIF_CARDS.length));
  const currentCard = DRIF_CARDS[cardIndex];
  const signupRef = useRef<HTMLDivElement | null>(null);
  const [showForm, setShowForm] = useState(false);

  const handleCardClick = useCallback(() => {
    setCardIndex((prevIndex) => (prevIndex + 1) % DRIF_CARDS.length);
  }, []);

  useEffect(() => {
    const body = document.body;
    body.classList.add('drif-body');
    return () => {
      body.classList.remove('drif-body');
    };
  }, []);

  useLayoutEffect(() => {
    const container = signupRef.current;
    if (!container) return;
    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://eomail5.com/form/578237fe-8fb4-11f0-8bba-a35988c2be69.js';
    script.dataset.form = '578237fe-8fb4-11f0-8bba-a35988c2be69';
    container.appendChild(script);
    return () => {
      if (script.parentNode === container) {
        container.removeChild(script);
      }
    };
  }, []);

  return (
    <div className="drif-page">
      <header className="top drif-top">
        <div className="brand">
          <a
            href="/"
            className="brand__home-link"
            aria-label="Go to mons.shop home"
            draggable={false}
            onClick={(evt) => {
              evt.preventDefault();
              navigate('/');
            }}
            onDragStart={(evt) => {
              evt.preventDefault();
            }}
          >
            <h1>
              <img src="https://assets.mons.link/shop/logo.webp" alt="" className="brand-icon" draggable={false} />
              <span>mons.shop</span>
            </h1>
          </a>
        </div>
      </header>
      <main className="drif-main">
        <div className="drif-card-showcase">
          <DrifEffectCard
            card={currentCard}
            ariaLabel="Expand the Pokemon Card; Custom Card."
            onClick={handleCardClick}
            preserveTransformOnCardChange
            preloadCards={DRIF_CARDS}
          />
        </div>
      </main>
      <div className="drif-notify-area">
        {!showForm && (
          <button type="button" className="drif-notify-btn" onClick={() => setShowForm(true)}>
            notify me
          </button>
        )}
        <div id="signup" ref={signupRef} className={`drif-signup${showForm ? ' drif-signup--visible' : ''}`} />
      </div>
    </div>
  );
}
