import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import { navigate } from './navigation';
import { soundPlayer } from './lib/SoundPlayer';
import {
  CLEAR_CARD_MODEL_COUNT,
  DEFAULT_CLEAR_PACK_MODEL_URL,
  clearCardModelUrl,
} from './lib/clearCardModels';
import { CLEAR_CARDS_BREAK_SOUND_URL, CLEAR_CARDS_HIT_SOUND_URLS } from './config/dropMediaDefaults';
import ClearCardLightingPanel from './components/ClearCardLightingPanel';
import {
  createClearCardLightingPreset,
  type ClearCardLightingConfig,
  type ClearCardLightingPresetId,
} from './clearCardLighting';
import type {
  ClearCardDisplayStage,
  ClearCardThreeViewerHandle,
  ViewerStatus,
} from './ClearCardThreeViewer';
import { ModalFocusScope } from './components/ModalFocusScope';
import { isKeyboardShortcutTarget } from './lib/focusTrap';
import './clearCardWip.css';

const ClearCardThreeViewer = lazy(() => import('./ClearCardThreeViewer'));

const HIT_SOUND_VOLUME = 0.42;
const BREAK_SOUND_VOLUME = 0.42;
const CLEAR_CARD_WIP_LIGHTING_PRESET_ID: ClearCardLightingPresetId = 'light-upcoming';
const CARD_MODEL_OPTIONS = Array.from({ length: CLEAR_CARD_MODEL_COUNT }, (_, index) => {
  const cardId = index + 1;
  return { label: `Card: ${cardId}`, url: clearCardModelUrl(cardId)! };
});

function getSnapshotFilename(modelUrl: string, objectKind: 'pack' | 'card') {
  const fallback = objectKind === 'pack' ? 'clear-pack-snapshot' : 'clear-card-snapshot';
  try {
    const pathname = new URL(modelUrl, window.location.href).pathname;
    const filename = decodeURIComponent(pathname.split('/').pop() ?? '');
    const basename = filename.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9._-]+/g, '_');
    return `${basename || fallback}.png`;
  } catch {
    return `${fallback}.png`;
  }
}

function downloadSnapshotBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export default function ClearCardWipApp() {
  const [status, setStatus] = useState<ViewerStatus>('loading');
  const [cardModelUrl, setCardModelUrl] = useState<string>(CARD_MODEL_OPTIONS[0].url);
  const [cardRevealed, setCardRevealed] = useState(false);
  const [displayStage, setDisplayStage] = useState<ClearCardDisplayStage>('pack');
  const [unrestrictedMovement, setUnrestrictedMovement] = useState(false);
  const [axisLockedOrbit, setAxisLockedOrbit] = useState(false);
  const [upcomingDropPreview, setUpcomingDropPreview] = useState(false);
  const [lightingConfig, setLightingConfig] = useState(() =>
    createClearCardLightingPreset(CLEAR_CARD_WIP_LIGHTING_PRESET_ID),
  );
  const [lightingPresetId, setLightingPresetId] = useState<
    ClearCardLightingPresetId | 'custom'
  >(CLEAR_CARD_WIP_LIGHTING_PRESET_ID);
  const viewerRef = useRef<ClearCardThreeViewerHandle | null>(null);
  const soundInitPromiseRef = useRef<Promise<void> | null>(null);
  const previewViewModeRef = useRef({ unrestrictedMovement: false, axisLockedOrbit: false });

  const handleStatusChange = useCallback((nextStatus: ViewerStatus) => {
    setStatus(nextStatus);
  }, []);
  const handleClose = useCallback(() => {
    navigate('/');
  }, []);
  const handleReset = useCallback(() => {
    setCardRevealed(false);
    viewerRef.current?.reset();
  }, []);
  const handleLightingChange = useCallback((nextConfig: ClearCardLightingConfig) => {
    setLightingPresetId('custom');
    setLightingConfig(nextConfig);
  }, []);
  const handleLightingPresetChange = useCallback((presetId: ClearCardLightingPresetId) => {
    setLightingPresetId(presetId);
    setLightingConfig(createClearCardLightingPreset(presetId));
  }, []);
  const handleUnrestrictedMovementChange = useCallback((enabled: boolean) => {
    setUnrestrictedMovement(enabled);
    if (enabled) setAxisLockedOrbit(false);
  }, []);
  const handleAxisLockedOrbitChange = useCallback((enabled: boolean) => {
    setAxisLockedOrbit(enabled);
    if (enabled) setUnrestrictedMovement(false);
  }, []);
  const handleUpcomingDropPreviewChange = useCallback(
    (enabled: boolean) => {
      setStatus('loading');
      setUpcomingDropPreview(enabled);
      if (enabled) {
        previewViewModeRef.current = { unrestrictedMovement, axisLockedOrbit };
        setUnrestrictedMovement(true);
        setAxisLockedOrbit(false);
      } else {
        setUnrestrictedMovement(previewViewModeRef.current.unrestrictedMovement);
        setAxisLockedOrbit(previewViewModeRef.current.axisLockedOrbit);
      }
    },
    [axisLockedOrbit, unrestrictedMovement],
  );
  const handleSnapshot = useCallback(async () => {
    const viewer = viewerRef.current;
    if (!viewer) throw new Error('Snapshot rendering is unavailable.');
    const snapshot = await viewer.captureSnapshot();
    const modelUrl =
      snapshot.objectKind === 'pack' ? DEFAULT_CLEAR_PACK_MODEL_URL : cardModelUrl;
    downloadSnapshotBlob(snapshot.blob, getSnapshotFilename(modelUrl, snapshot.objectKind));
  }, [cardModelUrl]);
  const handleModelChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const nextModelUrl = event.currentTarget.value;
      if (nextModelUrl === cardModelUrl) return;
      setStatus('loading');
      setCardModelUrl(nextModelUrl);
    },
    [cardModelUrl],
  );
  const ensureSoundReady = useCallback(() => {
    if (soundPlayer.isInitialized) return Promise.resolve();
    if (soundInitPromiseRef.current) return soundInitPromiseRef.current;
    const promise = soundPlayer.initializeOnUserInteraction(true).catch(() => undefined);
    soundInitPromiseRef.current = promise;
    void promise.then(() => {
      if (soundInitPromiseRef.current === promise) {
        soundInitPromiseRef.current = null;
      }
    });
    return promise;
  }, []);

  const handlePackHit = useCallback(() => {
    void ensureSoundReady().then(() => {
      const soundUrl =
        CLEAR_CARDS_HIT_SOUND_URLS[
          Math.floor(Math.random() * CLEAR_CARDS_HIT_SOUND_URLS.length)
        ] || CLEAR_CARDS_HIT_SOUND_URLS[0];
      void soundPlayer.playSound(soundUrl, HIT_SOUND_VOLUME);
    });
  }, [ensureSoundReady]);

  const handlePackBreak = useCallback(() => {
    setCardRevealed(true);
    const play = () => {
      void soundPlayer.playSound(CLEAR_CARDS_BREAK_SOUND_URL, BREAK_SOUND_VOLUME);
    };
    if (soundPlayer.isInitialized) {
      play();
      return;
    }
    const pending = soundInitPromiseRef.current;
    if (pending) {
      void pending.then(play);
      return;
    }
    void ensureSoundReady().then(play);
  }, [ensureSoundReady]);

  useEffect(() => {
    if (status !== 'ready') return;
    CLEAR_CARDS_HIT_SOUND_URLS.forEach((soundUrl) => {
      void soundPlayer.preloadSound(soundUrl).catch(() => undefined);
    });
    void soundPlayer.preloadSound(CLEAR_CARDS_BREAK_SOUND_URL).catch(() => undefined);
  }, [status]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }
      if (isKeyboardShortcutTarget(event.target)) {
        return;
      }
      if (event.code === 'KeyR' || event.key === 'r' || event.key === 'R') {
        event.preventDefault();
        viewerRef.current?.reset();
        return;
      }
      if (event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        viewerRef.current?.hit();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const ready = status === 'ready';

  return (
    <ModalFocusScope
      className="clear-card-wip"
      ariaLabel="Clear card sample"
      focusTarget="scope"
      onEscape={handleClose}
    >
      <div className="clear-card-wip__backdrop" aria-hidden="true" />
      <div
        id="clear-card-wip-blur-source"
        className={`clear-card-wip__stage${
          upcomingDropPreview ? ' clear-card-wip__stage--upcoming-drop' : ''
        }`}
      >
        <div className="clear-card-wip__preview-frame">
          <div
            className={`clear-card-wip__viewport${ready ? ' clear-card-wip__viewport--ready' : ''}`}
            aria-busy={status === 'loading'}
          >
            <Suspense fallback={null}>
              <ClearCardThreeViewer
                key={`${cardModelUrl}:${
                  upcomingDropPreview ? 'upcoming-drop' : DEFAULT_CLEAR_PACK_MODEL_URL
                }`}
                ref={viewerRef}
                ready={ready}
                cardModelUrl={cardModelUrl}
                packModelUrl={upcomingDropPreview ? undefined : DEFAULT_CLEAR_PACK_MODEL_URL}
                lightingConfig={lightingConfig}
                unrestrictedMovement={unrestrictedMovement}
                axisLockedOrbit={axisLockedOrbit}
                snapBackOnRelease={upcomingDropPreview}
                initiallyRevealed={upcomingDropPreview || cardRevealed}
                onStatusChange={handleStatusChange}
                onStageChange={setDisplayStage}
                onPackHit={handlePackHit}
                onPackBreak={handlePackBreak}
              />
            </Suspense>
            {status === 'error' ? (
              <div
                className="clear-card-wip__status clear-card-wip__status--error"
                role="alert"
              >
                Unable to display 3D card.
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <div className="clear-card-wip__model-pickers">
        <select
          className="clear-card-wip__model-picker"
          aria-label="Card model"
          value={cardModelUrl}
          onChange={handleModelChange}
        >
          {CARD_MODEL_OPTIONS.map((option) => (
            <option key={option.url} value={option.url}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <ClearCardLightingPanel
        config={lightingConfig}
        presetId={lightingPresetId}
        unrestrictedMovement={unrestrictedMovement}
        axisLockedOrbit={axisLockedOrbit}
        upcomingDropPreview={upcomingDropPreview}
        snapshotDisabled={!ready || displayStage === 'breaking'}
        onChange={handleLightingChange}
        onPresetChange={handleLightingPresetChange}
        onUnrestrictedMovementChange={handleUnrestrictedMovementChange}
        onAxisLockedOrbitChange={handleAxisLockedOrbitChange}
        onUpcomingDropPreviewChange={handleUpcomingDropPreviewChange}
        onSnapshot={handleSnapshot}
      />
      <button
        type="button"
        className="wip-close-btn"
        onClick={handleClose}
        aria-label="Close clear card viewer"
      >
        Close
      </button>
      <button
        type="button"
        className="wip-reset-btn"
        onClick={handleReset}
        aria-label="Reset unboxing"
      >
        Reset
      </button>
    </ModalFocusScope>
  );
}
