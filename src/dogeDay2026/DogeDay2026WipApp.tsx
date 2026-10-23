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

function randomCardId(previous?: number) {
  const count = DOGE_DAY_2026_WIP_CONFIG.cardCount;
  if (previous === undefined) return Math.floor(Math.random() * count) + 1;
  return ((previous - 1 + Math.floor(Math.random() * (count - 1)) + 1) % count) + 1;
}

export default function DogeDay2026WipApp() {
  const [cardId, setCardId] = useState(randomCardId);
  const [cardReady, setCardReady] = useState(false);
  const [focusedMode, setFocusedMode] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const soundInitPromiseRef = useRef<Promise<void> | null>(null);
  const revealButtonRef = useRef<HTMLButtonElement | null>(null);
  const currentCards = useMemo(() => {
    const card = getDogeDay2026StarterCard(cardId);
    return card ? [card] : [];
  }, [cardId]);

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

  useEffect(() => {
    void soundPlayer.preloadSound(DOGE_DAY_2026_WIP_SOUNDS.reveal);
    DOGE_DAY_2026_WIP_SOUNDS.click.forEach((url) => {
      void soundPlayer.preloadSound(url);
    });
  }, []);

  useEffect(() => {
    const { cardReadyMinDelayMs, cardReadyMaxDelayMs } = DOGE_DAY_2026_WIP_CONFIG;
    const delay = cardReadyMinDelayMs + Math.floor(Math.random() * (cardReadyMaxDelayMs - cardReadyMinDelayMs + 1));
    const timeoutId = window.setTimeout(() => setCardReady(true), delay);
    return () => window.clearTimeout(timeoutId);
  }, [resetKey]);

  const handleReset = useCallback(() => {
    setCardReady(false);
    setCardId((current) => randomCardId(current));
    setResetKey((current) => current + 1);
  }, []);

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
        resetKey={resetKey}
        onPlayClick={playClickSound}
        onPlayReveal={playRevealSound}
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
        <button type="button" className="doge-day-2026-wip-reset-btn" onClick={handleReset} aria-label="Reset opening">
          Reset
        </button>
      </div>
    </ModalFocusScope>
  );
}
