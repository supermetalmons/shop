import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DogeDay2026RevealOverlay } from './DogeDay2026RevealOverlay';
import { DOGE_DAY_2026_WIP_CONFIG, DOGE_DAY_2026_WIP_SOUNDS, pickDogeDay2026ClickSound } from './starterConfig';
import { getDogeDay2026StarterCard } from './starterCards';
import { soundPlayer } from '../lib/SoundPlayer';
import { isKeyboardShortcutTarget } from '../lib/focusTrap';
import { playMiNoteClosingParticles } from '../lib/miNoteClosingParticles';
import { navigate } from '../navigation';
import { ModalFocusScope } from '../components/ModalFocusScope';
import './wip.css';

type PackSize = 1 | 2 | 3;

function randomCardIds(packSize: PackSize, previousFirst?: number) {
  const count = DOGE_DAY_2026_WIP_CONFIG.cardCount;
  const first = previousFirst === undefined
    ? Math.floor(Math.random() * count) + 1
    : ((previousFirst - 1 + Math.floor(Math.random() * (count - 1)) + 1) % count) + 1;
  const selected = [first];
  const available = Array.from({ length: count }, (_, index) => index + 1).filter((id) => id !== first);
  while (selected.length < packSize) {
    selected.push(available.splice(Math.floor(Math.random() * available.length), 1)[0]);
  }
  return selected;
}

export default function DogeDay2026WipApp() {
  const [round, setRound] = useState(() => ({
    packSize: DOGE_DAY_2026_WIP_CONFIG.itemsPerPack as PackSize,
    cardIds: randomCardIds(DOGE_DAY_2026_WIP_CONFIG.itemsPerPack),
    resetKey: 0,
  }));
  const [cardReady, setCardReady] = useState(false);
  const [focusedMode, setFocusedMode] = useState(false);
  const soundInitPromiseRef = useRef<Promise<void> | null>(null);
  const revealButtonRef = useRef<HTMLButtonElement | null>(null);
  const currentCards = useMemo(
    () => round.cardIds.map((cardId) => getDogeDay2026StarterCard(cardId)!),
    [round.cardIds],
  );

  const ensureSoundReady = useCallback(() => {
    if (soundPlayer.isInitialized) return Promise.resolve();
    if (soundInitPromiseRef.current) return soundInitPromiseRef.current;
    const pending = soundPlayer.initializeOnUserInteraction(true);
    soundInitPromiseRef.current = pending;
    const clearPending = () => {
      if (soundInitPromiseRef.current === pending) soundInitPromiseRef.current = null;
    };
    void pending.then(clearPending, clearPending);
    return pending;
  }, []);

  const playClickSound = useCallback(() => {
    void ensureSoundReady().then(() => soundPlayer.playSound(
      pickDogeDay2026ClickSound(),
      DOGE_DAY_2026_WIP_CONFIG.clickVolume,
    )).catch(() => {});
  }, [ensureSoundReady]);

  const playRevealSound = useCallback(() => {
    const play = () => soundPlayer.playSound(
      DOGE_DAY_2026_WIP_SOUNDS.reveal,
      DOGE_DAY_2026_WIP_CONFIG.revealVolume,
    );
    if (soundPlayer.isInitialized) {
      void play();
    } else if (soundInitPromiseRef.current) {
      void soundInitPromiseRef.current.then(play).catch(() => {});
    }
  }, []);

  const playCardMotionSound = useCallback((url: string) => {
    void ensureSoundReady().then(() => soundPlayer.playSound(
      url,
      DOGE_DAY_2026_WIP_CONFIG.clickVolume,
    )).catch(() => {});
  }, [ensureSoundReady]);
  const playCardSwipeSound = useCallback(() => {
    playCardMotionSound(DOGE_DAY_2026_WIP_SOUNDS.cardSwipe);
  }, [playCardMotionSound]);
  const playCardSpreadSound = useCallback(() => {
    playCardMotionSound(DOGE_DAY_2026_WIP_SOUNDS.cardSpread);
  }, [playCardMotionSound]);

  useEffect(() => {
    void soundPlayer.preloadSound(DOGE_DAY_2026_WIP_SOUNDS.reveal);
    void soundPlayer.preloadSound(DOGE_DAY_2026_WIP_SOUNDS.cardSwipe);
    void soundPlayer.preloadSound(DOGE_DAY_2026_WIP_SOUNDS.cardSpread);
    DOGE_DAY_2026_WIP_SOUNDS.click.forEach((url) => {
      void soundPlayer.preloadSound(url);
    });
  }, []);

  useEffect(() => {
    const { cardReadyMinDelayMs, cardReadyMaxDelayMs } = DOGE_DAY_2026_WIP_CONFIG;
    const delay = cardReadyMinDelayMs + Math.floor(Math.random() * (cardReadyMaxDelayMs - cardReadyMinDelayMs + 1));
    const timeoutId = window.setTimeout(() => setCardReady(true), delay);
    return () => window.clearTimeout(timeoutId);
  }, [round.resetKey]);

  const handleReset = useCallback(() => {
    setCardReady(false);
    setRound((current) => ({
      ...current,
      cardIds: randomCardIds(current.packSize, current.cardIds[0]),
      resetKey: current.resetKey + 1,
    }));
  }, []);
  const handlePackSizeChange = useCallback((packSize: PackSize) => {
    if (packSize === round.packSize) return;
    setCardReady(false);
    setRound((current) => ({
      packSize,
      cardIds: randomCardIds(packSize, current.cardIds[0]),
      resetKey: current.resetKey + 1,
    }));
  }, [round.packSize]);

  const handleClose = useCallback(() => {
    navigate('/');
    playMiNoteClosingParticles();
  }, []);
  const handleBackgroundTap = useCallback(() => setFocusedMode((current) => !current), []);
  const handleSceneError = useCallback(() => setFocusedMode(false), []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey || isKeyboardShortcutTarget(event.target)) return;
      if (event.code === 'KeyR' || event.key === 'r' || event.key === 'R') {
        event.preventDefault();
        handleReset();
      } else if (event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        revealButtonRef.current?.click();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleReset]);

  return (
    <ModalFocusScope
      className={`doge-day-2026-wip-page${focusedMode ? ' doge-day-2026-wip-page--focused' : ''}`}
      ariaLabel={`${DOGE_DAY_2026_WIP_CONFIG.collectionName} pack preview`}
      focusTarget="scope"
      onEscape={handleClose}
    >
      <DogeDay2026RevealOverlay
        boxLabel={DOGE_DAY_2026_WIP_CONFIG.packLabel}
        cards={currentCards}
        cardReady={cardReady}
        boxButtonRef={revealButtonRef}
        resetKey={round.resetKey}
        onPlayClick={playClickSound}
        onPlayReveal={playRevealSound}
        onPlayCardSwipe={playCardSwipeSound}
        onPlayCardSpread={playCardSpreadSound}
        onBackgroundTap={handleBackgroundTap}
        onError={handleSceneError}
      />
      <div
        className={`doge-day-2026-wip-controls${focusedMode ? ' doge-day-2026-wip-controls--hidden' : ''}`}
        aria-hidden={focusedMode || undefined}
        inert={focusedMode || undefined}
      >
        <button type="button" className="doge-day-2026-wip-close-btn" onClick={handleClose} aria-label="Close wip overlay">
          Close
        </button>
        <div className="doge-day-2026-wip-pack-picker" role="group" aria-label="Cards per pack">
          <button
            type="button"
            aria-label="1 card pack"
            aria-pressed={round.packSize === 1}
            onClick={() => handlePackSizeChange(1)}
          >1</button>
          <span aria-hidden="true">/</span>
          <button
            type="button"
            aria-label="2 card pack"
            aria-pressed={round.packSize === 2}
            onClick={() => handlePackSizeChange(2)}
          >2</button>
          <span aria-hidden="true">/</span>
          <button
            type="button"
            aria-label="3 card pack"
            aria-pressed={round.packSize === 3}
            onClick={() => handlePackSizeChange(3)}
          >3</button>
        </div>
        <button type="button" className="doge-day-2026-wip-reset-btn" onClick={handleReset} aria-label="Reset opening">
          Reset
        </button>
      </div>
    </ModalFocusScope>
  );
}
