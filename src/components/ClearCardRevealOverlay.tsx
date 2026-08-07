import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type TransitionEvent,
} from 'react';
import {
  createClearCardLightingPreset,
  type ClearCardLightingPresetId,
} from '../clearCardLighting';
import type {
  ClearCardDisplayStage,
  ClearCardModelLoadStatus,
  ClearCardThreeViewerHandle,
  ViewerStatus,
} from '../ClearCardThreeViewer';
import { DEFAULT_CLEAR_PACK_MODEL_URL, clearCardModelUrl } from '../lib/clearCardModels';
import {
  beginClearCardRevealRequest,
  createClearCardRevealRequestState,
  settleClearCardRevealRequest,
  type ClearCardRevealRequestState,
} from '../lib/clearCardReveal';
import type { PonchoDrifellaRevealRequestStatus } from '../lib/ponchoDrifellaReveal';

const ClearCardThreeViewer = lazy(() => import('../ClearCardThreeViewer'));
const CLEAR_CARD_REVEAL_LIGHTING_PRESET_ID: ClearCardLightingPresetId = 'light-upcoming';
const CLEAR_CARD_REVEAL_CAMERA_ZOOM = 1.5;

type ClearCardRevealOverlayProps = {
  overlayStyle?: CSSProperties;
  active: boolean;
  closing: boolean;
  phase: 'preparing' | 'ready' | 'revealed';
  cardId?: number;
  loadingImageSrc?: string;
  resetKey: string | number;
  boxName: string;
  onRequestReveal?: () => PonchoDrifellaRevealRequestStatus | void | Promise<PonchoDrifellaRevealRequestStatus | void>;
  onPlayHit?: () => void;
  onPlayBreak?: () => void;
  onDismiss?: () => void;
  onTransitionEnd?: (event: TransitionEvent<HTMLDivElement>) => void;
  onRevealCompleteChange?: (complete: boolean) => void;
  onDismissReadyChange?: (ready: boolean) => void;
};

export default function ClearCardRevealOverlay({
  overlayStyle,
  active,
  closing,
  phase,
  cardId,
  loadingImageSrc,
  resetKey,
  boxName,
  onRequestReveal,
  onPlayHit,
  onPlayBreak,
  onDismiss,
  onTransitionEnd,
  onRevealCompleteChange,
  onDismissReadyChange,
}: ClearCardRevealOverlayProps) {
  const viewerRef = useRef<ClearCardThreeViewerHandle | null>(null);
  const requestStateRef = useRef<ClearCardRevealRequestState>('idle');
  const requestGenerationRef = useRef(0);
  const [viewerAttempt, setViewerAttempt] = useState(0);
  const [viewerStatus, setViewerStatus] = useState<ViewerStatus>('loading');
  const [cardLoadStatus, setCardLoadStatus] = useState<ClearCardModelLoadStatus>('idle');
  const [displayStage, setDisplayStage] = useState<ClearCardDisplayStage>('pack');
  const lightingConfig = useMemo(
    () => createClearCardLightingPreset(CLEAR_CARD_REVEAL_LIGHTING_PRESET_ID),
    [],
  );
  const cardModelUrl = clearCardModelUrl(cardId);
  const packReady = viewerStatus === 'ready';
  const cardReady = Boolean(cardModelUrl && cardLoadStatus === 'ready');
  const revealComplete = displayStage === 'revealed';

  useEffect(() => {
    requestGenerationRef.current += 1;
    requestStateRef.current = createClearCardRevealRequestState(Boolean(cardModelUrl));
    setViewerAttempt(0);
    setViewerStatus('loading');
    setCardLoadStatus(cardModelUrl ? 'loading' : 'idle');
    setDisplayStage('pack');
  }, [resetKey]);

  useEffect(() => {
    if (cardModelUrl) requestStateRef.current = 'sent';
  }, [cardModelUrl]);

  useEffect(() => {
    onRevealCompleteChange?.(revealComplete);
    onDismissReadyChange?.(revealComplete);
  }, [onDismissReadyChange, onRevealCompleteChange, revealComplete]);

  useEffect(() => () => {
    onRevealCompleteChange?.(false);
    onDismissReadyChange?.(false);
  }, [onDismissReadyChange, onRevealCompleteChange]);

  const requestReveal = useCallback(() => {
    if (!onRequestReveal) return;
    const request = beginClearCardRevealRequest(requestStateRef.current);
    requestStateRef.current = request.state;
    if (!request.shouldRequest) return;
    const requestGeneration = requestGenerationRef.current;
    void Promise.resolve(onRequestReveal())
      .then((status) => {
        if (requestGeneration !== requestGenerationRef.current) return;
        requestStateRef.current = settleClearCardRevealRequest(status);
      })
      .catch(() => {
        if (requestGeneration !== requestGenerationRef.current) return;
        requestStateRef.current = settleClearCardRevealRequest('retry');
      });
  }, [onRequestReveal]);

  const handlePackHit = useCallback(() => {
    onPlayHit?.();
    if (!cardModelUrl) requestReveal();
  }, [cardModelUrl, onPlayHit, requestReveal]);

  const handlePackBreak = useCallback(() => {
    onPlayBreak?.();
  }, [onPlayBreak]);

  const handleBackdropClick = useCallback(() => {
    if (!revealComplete || closing) return;
    onDismiss?.();
  }, [closing, onDismiss, revealComplete]);

  const handleRetryCard = useCallback(() => {
    setCardLoadStatus('loading');
    viewerRef.current?.retryCardModel();
  }, []);

  const handleRetryViewer = useCallback(() => {
    setViewerStatus('loading');
    setCardLoadStatus(cardModelUrl ? 'loading' : 'idle');
    setDisplayStage('pack');
    setViewerAttempt((attempt) => attempt + 1);
  }, [cardModelUrl]);

  return (
    <div
      className={`reveal-overlay clear-card-reveal-overlay reveal-overlay--${phase}${active ? ' reveal-overlay--active' : ''}${closing ? ' reveal-overlay--closing' : ''}`}
      role="presentation"
      style={overlayStyle}
      onContextMenu={(event) => event.preventDefault()}
      onDragStart={(event) => event.preventDefault()}
    >
      <div className="reveal-overlay__backdrop" onClick={handleBackdropClick} />
      <div
        className="reveal-overlay__frame clear-card-reveal-overlay__frame"
        onClick={(event) => event.stopPropagation()}
        onTransitionEnd={onTransitionEnd}
      >
        <div
          className={`clear-card-reveal-overlay__viewport${packReady ? ' clear-card-reveal-overlay__viewport--ready' : ''}`}
          aria-busy={!packReady || cardLoadStatus === 'loading'}
        >
          {loadingImageSrc ? (
            <img
              className="clear-card-reveal-overlay__fallback"
              src={loadingImageSrc}
              alt=""
              draggable={false}
              aria-hidden="true"
            />
          ) : null}
          <Suspense fallback={null}>
            <ClearCardThreeViewer
              key={`${String(resetKey)}:${viewerAttempt}`}
              ref={viewerRef}
              ready={packReady}
              cardModelUrl={cardModelUrl}
              packModelUrl={DEFAULT_CLEAR_PACK_MODEL_URL}
              lightingConfig={lightingConfig}
              unrestrictedMovement={false}
              axisLockedOrbit={false}
              interactionFrameRateMode="adaptive"
              interactionEnabled={phase === 'ready' && !closing}
              hitProgressionMode="reveal-gated"
              revealReady={cardReady}
              initiallyRevealed={false}
              cameraZoom={CLEAR_CARD_REVEAL_CAMERA_ZOOM}
              ariaLabel={`Interactive 3D ${boxName}`}
              onStatusChange={setViewerStatus}
              onCardModelLoadStatusChange={setCardLoadStatus}
              onStageChange={setDisplayStage}
              onPackHit={handlePackHit}
              onPackBreak={handlePackBreak}
            />
          </Suspense>
          {viewerStatus === 'error' ? (
            <button
              type="button"
              className="clear-card-reveal-overlay__retry"
              onClick={handleRetryViewer}
            >
              Retry 3D
            </button>
          ) : cardLoadStatus === 'error' ? (
            <button
              type="button"
              className="clear-card-reveal-overlay__retry"
              onClick={handleRetryCard}
            >
              Retry card
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
