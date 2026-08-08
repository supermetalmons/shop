import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
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
import { ModalFocusScope } from './ModalFocusScope';

const CLEAR_CARD_REVEAL_LIGHTING_PRESET_ID: ClearCardLightingPresetId = 'light-upcoming';
const CLEAR_CARD_REVEAL_CAMERA_ZOOM = 1.5;

function createClearCardThreeViewerComponent() {
  return lazy(() => import('../ClearCardThreeViewer'));
}

type ClearCardViewerErrorBoundaryProps = {
  children: ReactNode;
  onError: () => void;
};

class ClearCardViewerErrorBoundary extends Component<
  ClearCardViewerErrorBoundaryProps,
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error('[mons] failed to load the clear-card reveal viewer', error);
    this.props.onError();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

type ClearCardRevealOverlayProps = {
  overlayStyle?: CSSProperties;
  active: boolean;
  closing: boolean;
  suspended?: boolean;
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
  suspended = false,
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
  const [ClearCardThreeViewer, setClearCardThreeViewer] = useState(
    createClearCardThreeViewerComponent,
  );
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
    if (closing || suspended) return;
    onPlayHit?.();
    if (!cardModelUrl) requestReveal();
  }, [cardModelUrl, closing, onPlayHit, requestReveal, suspended]);

  const handlePackBreak = useCallback(() => {
    if (closing || suspended) return;
    onPlayBreak?.();
  }, [closing, onPlayBreak, suspended]);

  const handleBackdropClick = useCallback(() => {
    if (!revealComplete || closing || suspended) return;
    onDismiss?.();
  }, [closing, onDismiss, revealComplete, suspended]);

  const handleRetryCard = useCallback(() => {
    setCardLoadStatus('loading');
    viewerRef.current?.retryCardModel();
  }, []);

  const handleRetryViewer = useCallback(() => {
    setViewerStatus('loading');
    setCardLoadStatus(cardModelUrl ? 'loading' : 'idle');
    setDisplayStage('pack');
    setClearCardThreeViewer(() => createClearCardThreeViewerComponent());
    setViewerAttempt((attempt) => attempt + 1);
  }, [cardModelUrl]);

  const handleViewerError = useCallback(() => {
    setViewerStatus('error');
  }, []);

  return (
    <ModalFocusScope
      ariaLabel={boxName ? `${boxName} unboxing` : 'Clear card unboxing'}
      suspended={closing || suspended}
      focusKey={`${viewerStatus}:${cardLoadStatus}:${displayStage}`}
      className={`reveal-overlay clear-card-reveal-overlay reveal-overlay--${phase}${active ? ' reveal-overlay--active' : ''}${closing ? ' reveal-overlay--closing' : ''}${suspended ? ' reveal-overlay--suspended' : ''}`}
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
          <div id="clear-card-reveal-blur-source" className="clear-card-reveal-overlay__visual">
            {loadingImageSrc ? (
              <img
                className="clear-card-reveal-overlay__fallback"
                src={loadingImageSrc}
                alt=""
                draggable={false}
                aria-hidden="true"
              />
            ) : null}
            <ClearCardViewerErrorBoundary
              key={`${String(resetKey)}:${viewerAttempt}`}
              onError={handleViewerError}
            >
              <Suspense fallback={null}>
                <ClearCardThreeViewer
                  ref={viewerRef}
                  ready={packReady}
                  cardModelUrl={cardModelUrl}
                  packModelUrl={DEFAULT_CLEAR_PACK_MODEL_URL}
                  lightingConfig={lightingConfig}
                  unrestrictedMovement={false}
                  axisLockedOrbit={false}
                  interactionFrameRateMode="adaptive"
                  interactionEnabled={phase === 'ready' && !closing && !suspended}
                  keyboardActivationEnabled={displayStage === 'pack'}
                  hitProgressionMode="reveal-gated"
                  revealReady={cardReady}
                  initiallyRevealed={false}
                  cameraZoom={CLEAR_CARD_REVEAL_CAMERA_ZOOM}
                  ariaLabel={
                    displayStage === 'pack'
                      ? `Interactive 3D ${boxName}; press Enter or Space to hit the pack`
                      : `Interactive 3D ${boxName} card`
                  }
                  onStatusChange={setViewerStatus}
                  onCardModelLoadStatusChange={setCardLoadStatus}
                  onStageChange={setDisplayStage}
                  onPackHit={handlePackHit}
                  onPackBreak={handlePackBreak}
                />
              </Suspense>
            </ClearCardViewerErrorBoundary>
          </div>
          {viewerStatus === 'error' ? (
            <button
              type="button"
              className="clear-card-reveal-overlay__retry"
              data-frosted-surface=""
              onClick={handleRetryViewer}
            >
              Retry 3D
            </button>
          ) : cardLoadStatus === 'error' ? (
            <button
              type="button"
              className="clear-card-reveal-overlay__retry"
              data-frosted-surface=""
              onClick={handleRetryCard}
            >
              Retry card
            </button>
          ) : null}
        </div>
      </div>
    </ModalFocusScope>
  );
}
