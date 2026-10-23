import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  const [inspectionEnabled] = useState(() => Boolean(import.meta.env?.DEV)
    && new URLSearchParams(window.location.search).get('inspectOpening') === '1');
  const [inspectionTimeMs, setInspectionTimeMs] = useState(0);
  const [inspectionFrames, setInspectionFrames] = useState<string[]>([]);
  const [inspectionReady, setInspectionReady] = useState(false);
  const [inspectionDensity, setInspectionDensity] = useState<number | undefined>();
  const inspectionCaptureRef = useRef<(() => string[]) | null>(null);
  const inspectionFramesButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeFramesButtonRef = useRef<HTMLButtonElement | null>(null);
  const framesWereOpenRef = useRef(false);
  const framesOpen = inspectionEnabled && inspectionFrames.length > 0;
  const [round, setRound] = useState(() => ({
    packSize: DOGE_DAY_2026_WIP_CONFIG.itemsPerPack as PackSize,
    cardIds: inspectionEnabled ? [1, 2, 3].slice(0, DOGE_DAY_2026_WIP_CONFIG.itemsPerPack)
      : randomCardIds(DOGE_DAY_2026_WIP_CONFIG.itemsPerPack),
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
    if (inspectionEnabled) {
      setCardReady(true);
      return;
    }
    const { cardReadyMinDelayMs, cardReadyMaxDelayMs } = DOGE_DAY_2026_WIP_CONFIG;
    const delay = cardReadyMinDelayMs + Math.floor(Math.random() * (cardReadyMaxDelayMs - cardReadyMinDelayMs + 1));
    const timeoutId = window.setTimeout(() => setCardReady(true), delay);
    return () => window.clearTimeout(timeoutId);
  }, [round.resetKey, inspectionEnabled]);

  const handleReset = useCallback(() => {
    setInspectionFrames([]);
    setCardReady(inspectionEnabled);
    setInspectionTimeMs(0);
    setRound((current) => ({
      ...current,
      cardIds: inspectionEnabled ? [1, 2, 3].slice(0, current.packSize)
        : randomCardIds(current.packSize, current.cardIds[0]),
      resetKey: current.resetKey + 1,
    }));
  }, [inspectionEnabled]);
  const handlePackSizeChange = useCallback((packSize: PackSize) => {
    if (packSize === round.packSize) return;
    setInspectionFrames([]);
    setCardReady(inspectionEnabled);
    setRound((current) => ({
      packSize,
      cardIds: inspectionEnabled ? [1, 2, 3].slice(0, packSize)
        : randomCardIds(packSize, current.cardIds[0]),
      resetKey: current.resetKey + 1,
    }));
  }, [round.packSize, inspectionEnabled]);

  const handleClose = useCallback(() => {
    navigate('/');
    playMiNoteClosingParticles();
  }, []);
  const handleBackgroundTap = useCallback(() => setFocusedMode((current) => !current), []);
  const handleSceneError = useCallback(() => setFocusedMode(false), []);
  const handleCloseFrames = useCallback(() => setInspectionFrames([]), []);

  useLayoutEffect(() => {
    if (framesOpen) closeFramesButtonRef.current?.focus({ preventScroll: true });
    else if (framesWereOpenRef.current) {
      const trigger = inspectionFramesButtonRef.current;
      (trigger?.disabled ? trigger.closest<HTMLElement>('[role="dialog"]') : trigger)?.focus({ preventScroll: true });
    }
    framesWereOpenRef.current = framesOpen;
  }, [framesOpen]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (framesOpen || event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey || isKeyboardShortcutTarget(event.target)) return;
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
  }, [handleReset, framesOpen]);

  return (
    <ModalFocusScope
      className={`doge-day-2026-wip-page${focusedMode ? ' doge-day-2026-wip-page--focused' : ''}`}
      ariaLabel={framesOpen ? 'Opening frames at 60 Hz' : `${DOGE_DAY_2026_WIP_CONFIG.collectionName} pack preview`}
      focusTarget="scope"
      onEscape={framesOpen ? handleCloseFrames : handleClose}
    >
      <div inert={framesOpen || undefined} aria-hidden={framesOpen || undefined}>
        <DogeDay2026RevealOverlay
          boxLabel={DOGE_DAY_2026_WIP_CONFIG.packLabel}
          cards={currentCards}
          cardReady={cardReady}
          boxButtonRef={revealButtonRef}
          resetKey={round.resetKey}
          inspectionTimeMs={inspectionEnabled ? inspectionTimeMs : undefined}
          inspectionDensity={inspectionEnabled ? inspectionDensity : undefined}
          inspectionCaptureRef={inspectionEnabled ? inspectionCaptureRef : undefined}
          onInspectionReady={inspectionEnabled ? setInspectionReady : undefined}
          onPlayClick={playClickSound}
          onPlayReveal={playRevealSound}
          onPlayCardSwipe={playCardSwipeSound}
          onPlayCardSpread={playCardSpreadSound}
          onBackgroundTap={handleBackgroundTap}
          onError={handleSceneError}
        />
      </div>
      {inspectionEnabled && (
        <div
          className="doge-day-2026-opening-inspector"
          role="group"
          aria-label="Opening frame inspection"
          inert={framesOpen || undefined}
          aria-hidden={framesOpen || undefined}
        >
          <div className="doge-day-2026-opening-inspector__steps">
            <button
              type="button"
              aria-label="Previous opening frame"
              disabled={inspectionTimeMs <= 0}
              onClick={() => setInspectionTimeMs(current => Math.max(0, (Math.round(current * 60 / 1000) - 1) * 1000 / 60))}
            >Previous</button>
            <output aria-live="polite">{inspectionTimeMs.toFixed(2)} ms · {Math.round(inspectionTimeMs * 60 / 1000)} / 78</output>
            <button
              type="button"
              aria-label="Next opening frame"
              disabled={inspectionTimeMs >= 1300}
              onClick={() => setInspectionTimeMs(current => Math.min(1300, (Math.round(current * 60 / 1000) + 1) * 1000 / 60))}
            >Next</button>
          </div>
          <input
            type="range"
            aria-label="Opening frame"
            min="0"
            max="78"
            step="1"
            value={Math.round(inspectionTimeMs * 60 / 1000)}
            onChange={event => setInspectionTimeMs(Math.min(1300, Number(event.currentTarget.value) * 1000 / 60))}
          />
          <div className="doge-day-2026-opening-inspector__steps">
            <button
              ref={inspectionFramesButtonRef}
              type="button"
              disabled={!inspectionReady}
              onClick={() => setInspectionFrames(inspectionCaptureRef.current?.() ?? [])}
            >{inspectionReady ? 'Frames' : 'Loading frames…'}</button>
            <label>
              Resolution{' '}
              <select
                aria-label="Inspection pixel density"
                value={inspectionDensity ?? 'native'}
                onChange={event => {
                  setInspectionFrames([]);
                  setInspectionDensity(event.currentTarget.value === 'native' ? undefined : Number(event.currentTarget.value));
                }}
              >
                <option value="native">Native</option>
                <option value="1">1×</option>
                <option value="2">2×</option>
                <option value="3">3×</option>
              </select>
            </label>
          </div>
        </div>
      )}
      {framesOpen && (
        <div className="doge-day-2026-opening-frames" role="region" aria-label="Opening frames at 60 Hz">
          <button ref={closeFramesButtonRef} type="button" onClick={handleCloseFrames}>Close frames</button>
          {inspectionFrames.map((source, index) => (
            <img key={index} src={source} alt={`Opening frames ${index * 20}–${Math.min(index * 20 + 19, 78)}`} />
          ))}
        </div>
      )}
      <div
        className={`doge-day-2026-wip-controls${focusedMode ? ' doge-day-2026-wip-controls--hidden' : ''}`}
        aria-hidden={focusedMode || framesOpen || undefined}
        inert={focusedMode || framesOpen || undefined}
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
