import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import { navigate } from './navigation';
import { soundPlayer } from './lib/SoundPlayer';
import ClearCardLightingPanel from './components/ClearCardLightingPanel';
import {
  DEFAULT_CLEAR_CARD_LIGHTING_PRESET_ID,
  createClearCardLightingPreset,
  type ClearCardLightingConfig,
  type ClearCardLightingPresetId,
} from './clearCardLighting';
import type {
  ClearCardDisplayStage,
  ClearCardThreeViewerHandle,
} from './ClearCardThreeViewer';
import './clearCardWip.css';

const ClearCardThreeViewer = lazy(() => import('./ClearCardThreeViewer'));

type ViewerStatus = 'loading' | 'ready' | 'error';

const CLEAR_CARDS_SOUND_BASE_URL = 'https://cdn.lil.org/nft/clear_cards/sounds';
const HIT_SOUND_URLS = [
  `${CLEAR_CARDS_SOUND_BASE_URL}/hit1.mp3`,
  `${CLEAR_CARDS_SOUND_BASE_URL}/hit2.mp3`,
  `${CLEAR_CARDS_SOUND_BASE_URL}/hit3.mp3`,
] as const;
const BREAK_SOUND_URL = `${CLEAR_CARDS_SOUND_BASE_URL}/crash.mp3`;
const HIT_SOUND_VOLUME = 0.42;
const BREAK_SOUND_VOLUME = 0.42;
const CARD_MODEL_OPTIONS = [
  { label: 'Card: Sample 15', url: '/clear_card_sample_15.glb' },
] as const;
const PACK_MODEL_OPTIONS = [
  { label: 'Pack: Sample', url: '/clear_pack_sample.glb' },
  { label: 'Pack: Sample 18', url: '/clear_pack_sample_18.glb' },
] as const;

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

function isWipShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tagName = target.tagName;
  return (
    tagName === 'INPUT' ||
    tagName === 'TEXTAREA' ||
    tagName === 'SELECT' ||
    tagName === 'BUTTON' ||
    tagName === 'SUMMARY' ||
    tagName === 'A'
  );
}

export default function ClearCardWipApp() {
  const [status, setStatus] = useState<ViewerStatus>('loading');
  const [cardModelUrl, setCardModelUrl] = useState<string>(CARD_MODEL_OPTIONS[0].url);
  const [packModelUrl, setPackModelUrl] = useState<string>(PACK_MODEL_OPTIONS[1].url);
  const [cardRevealed, setCardRevealed] = useState(false);
  const [displayStage, setDisplayStage] = useState<ClearCardDisplayStage>('pack');
  const [unrestrictedMovement, setUnrestrictedMovement] = useState(false);
  const [axisLockedOrbit, setAxisLockedOrbit] = useState(false);
  const [lightingConfig, setLightingConfig] = useState(() => createClearCardLightingPreset());
  const [lightingPresetId, setLightingPresetId] = useState<
    ClearCardLightingPresetId | 'custom'
  >(DEFAULT_CLEAR_CARD_LIGHTING_PRESET_ID);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<ClearCardThreeViewerHandle | null>(null);
  const soundInitPromiseRef = useRef<Promise<void> | null>(null);

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
  const handleSnapshot = useCallback(async () => {
    const viewer = viewerRef.current;
    if (!viewer) throw new Error('Snapshot rendering is unavailable.');
    const snapshot = await viewer.captureSnapshot();
    const modelUrl = snapshot.objectKind === 'pack' ? packModelUrl : cardModelUrl;
    downloadSnapshotBlob(snapshot.blob, getSnapshotFilename(modelUrl, snapshot.objectKind));
  }, [cardModelUrl, packModelUrl]);
  const handleModelChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const nextModelUrl = event.currentTarget.value;
      if (nextModelUrl === cardModelUrl) return;
      setStatus('loading');
      setCardModelUrl(nextModelUrl);
    },
    [cardModelUrl],
  );
  const handlePackModelChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const nextModelUrl = event.currentTarget.value;
      if (nextModelUrl === packModelUrl) return;
      setStatus('loading');
      setPackModelUrl(nextModelUrl);
      // Picking a pack means you want to see that pack, so go back to the unopened
      // state — otherwise an already-revealed card would mount straight over it.
      // Card changes deliberately keep the current stage.
      setCardRevealed(false);
    },
    [packModelUrl],
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
      const soundUrl = HIT_SOUND_URLS[Math.floor(Math.random() * HIT_SOUND_URLS.length)] || HIT_SOUND_URLS[0];
      void soundPlayer.playSound(soundUrl, HIT_SOUND_VOLUME);
    });
  }, [ensureSoundReady]);

  const handlePackBreak = useCallback(() => {
    setCardRevealed(true);
    const play = () => {
      void soundPlayer.playSound(BREAK_SOUND_URL, BREAK_SOUND_VOLUME);
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
    HIT_SOUND_URLS.forEach((soundUrl) => {
      void soundPlayer.preloadSound(soundUrl).catch(() => undefined);
    });
    void soundPlayer.preloadSound(BREAK_SOUND_URL).catch(() => undefined);
  }, [status]);

  useLayoutEffect(() => {
    pageRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }
      if (isWipShortcutTarget(event.target)) {
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
    <div
      ref={pageRef}
      className="clear-card-wip"
      role="dialog"
      aria-modal="true"
      aria-label="Clear card sample"
      tabIndex={-1}
    >
      <div className="clear-card-wip__backdrop" aria-hidden="true" />
      <div className="clear-card-wip__stage">
        <div
          className={`clear-card-wip__viewport${ready ? ' clear-card-wip__viewport--ready' : ''}`}
          aria-busy={status === 'loading'}
        >
          <Suspense fallback={null}>
            <ClearCardThreeViewer
              key={`${cardModelUrl}:${packModelUrl}`}
              ref={viewerRef}
              ready={ready}
              cardModelUrl={cardModelUrl}
              packModelUrl={packModelUrl}
              lightingConfig={lightingConfig}
              unrestrictedMovement={unrestrictedMovement}
              axisLockedOrbit={axisLockedOrbit}
              initiallyRevealed={cardRevealed}
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
        <select
          className="clear-card-wip__model-picker"
          aria-label="Pack model"
          value={packModelUrl}
          onChange={handlePackModelChange}
        >
          {PACK_MODEL_OPTIONS.map((option) => (
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
        snapshotDisabled={!ready || displayStage === 'breaking'}
        onChange={handleLightingChange}
        onPresetChange={handleLightingPresetChange}
        onUnrestrictedMovementChange={handleUnrestrictedMovementChange}
        onAxisLockedOrbitChange={handleAxisLockedOrbitChange}
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
    </div>
  );
}
