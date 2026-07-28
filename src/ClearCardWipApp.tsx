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
import { LITTLE_SWAG_BOXES_CDN_BASE_URL } from './config/dropMediaDefaults';
import type { ClearCardThreeViewerHandle } from './ClearCardThreeViewer';
import './clearCardWip.css';

const ClearCardThreeViewer = lazy(() => import('./ClearCardThreeViewer'));

type ViewerStatus = 'loading' | 'ready' | 'error';

const HIT_SOUND_URL = `${LITTLE_SWAG_BOXES_CDN_BASE_URL}/sounds/click.mp3`;
const BREAK_SOUND_URL = `${LITTLE_SWAG_BOXES_CDN_BASE_URL}/sounds/unbox1p.mp3`;
const HIT_SOUND_VOLUME = 0.42;
const BREAK_SOUND_VOLUME = 0.42;
const CARD_MODEL_OPTIONS = [
  { label: 'Sample', url: '/clear_card_sample.glb' },
  { label: 'Sample 15', url: '/clear_card_sample_15.glb' },
  { label: 'Sample 17', url: '/clear_card_sample_17.glb' },
  { label: 'Sample 19', url: '/clear_card_sample_19.glb' },
] as const;

function isWipShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tagName = target.tagName;
  return (
    tagName === 'INPUT' ||
    tagName === 'TEXTAREA' ||
    tagName === 'SELECT' ||
    tagName === 'BUTTON' ||
    tagName === 'A'
  );
}

export default function ClearCardWipApp() {
  const [status, setStatus] = useState<ViewerStatus>('loading');
  const [cardModelUrl, setCardModelUrl] = useState<string>(CARD_MODEL_OPTIONS[1].url);
  const [cardRevealed, setCardRevealed] = useState(false);
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
      void soundPlayer.playSound(HIT_SOUND_URL, HIT_SOUND_VOLUME);
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
    void soundPlayer.preloadSound(HIT_SOUND_URL).catch(() => undefined);
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
              key={cardModelUrl}
              ref={viewerRef}
              ready={ready}
              cardModelUrl={cardModelUrl}
              initiallyRevealed={cardRevealed}
              onStatusChange={handleStatusChange}
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
