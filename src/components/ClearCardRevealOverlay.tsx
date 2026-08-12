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
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type TransitionEvent,
} from 'react';
import { createClearCardLightingPreset } from '../clearCardLighting';
import type {
  ClearCardDisplayStage,
  ClearCardModelLoadStatus,
  ClearCardThreeViewerHandle,
  ViewerStatus,
} from '../ClearCardThreeViewer';
import { DEFAULT_CLEAR_PACK_MODEL_URL, clearCardModelUrl } from '../lib/clearCardModels';
import { resolveColorSchemeImageSources } from '../lib/colorSchemeImages';
import {
  beginClearCardRevealRequest,
  createClearCardRevealRequestState,
  isClearCardFallbackImagePoint,
  isClearCardFreeMovementEnabled,
  settleClearCardRevealRequest,
  shouldProtectClearCardOverlayClick,
  type ClearCardRevealRequestState,
} from '../lib/clearCardReveal';
import type { PonchoDrifellaRevealRequestStatus } from '../lib/ponchoDrifellaReveal';
import { useDarkColorScheme } from '../hooks/useDarkColorScheme';
import { ModalFocusScope } from './ModalFocusScope';

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
  viewerMode?: 'card' | 'pack';
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
  viewerMode,
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
  const darkMode = useDarkColorScheme();
  const viewerRef = useRef<ClearCardThreeViewerHandle | null>(null);
  const fallbackImageRef = useRef<HTMLImageElement | null>(null);
  const requestStateRef = useRef<ClearCardRevealRequestState>('idle');
  const requestGenerationRef = useRef(0);
  const [ClearCardThreeViewer, setClearCardThreeViewer] = useState(
    createClearCardThreeViewerComponent,
  );
  const [viewerAttempt, setViewerAttempt] = useState(0);
  const [viewerStatus, setViewerStatus] = useState<ViewerStatus>('loading');
  const [cardLoadStatus, setCardLoadStatus] = useState<ClearCardModelLoadStatus>('idle');
  const [displayStage, setDisplayStage] = useState<ClearCardDisplayStage>(
    viewerMode === 'card' ? 'revealed' : 'pack',
  );
  const lightingConfig = useMemo(
    () => createClearCardLightingPreset(undefined, { darkMode }),
    [darkMode],
  );
  const resolvedLoadingImageSrc = useMemo(() => {
    if (!loadingImageSrc) return undefined;
    const sources = resolveColorSchemeImageSources('clear_cards', loadingImageSrc);
    return darkMode ? sources.darkSrc || sources.lightSrc : sources.lightSrc;
  }, [darkMode, loadingImageSrc]);
  const cardModelUrl = clearCardModelUrl(cardId);
  const packReady = viewerStatus === 'ready';
  const cardReady = Boolean(cardModelUrl && cardLoadStatus === 'ready');
  const viewerOnly = Boolean(viewerMode);
  const revealComplete = viewerOnly || displayStage === 'revealed';
  const freeMovementEnabled = isClearCardFreeMovementEnabled(viewerOnly, displayStage);

  useEffect(() => {
    requestGenerationRef.current += 1;
    requestStateRef.current = createClearCardRevealRequestState(Boolean(cardModelUrl));
    setViewerAttempt(0);
    setViewerStatus('loading');
    setCardLoadStatus(cardModelUrl ? 'loading' : 'idle');
    setDisplayStage(viewerMode === 'card' ? 'revealed' : 'pack');
  }, [resetKey, viewerMode]);

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

  const handleFrameClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const objectHit = viewerRef.current?.isClientPointOnObject(event.clientX, event.clientY);
    const fallbackImage = fallbackImageRef.current;
    const fallbackHit = Boolean(
      !packReady &&
      fallbackImage &&
      isClearCardFallbackImagePoint(
        event,
        fallbackImage.getBoundingClientRect(),
        fallbackImage,
      ),
    );
    if (shouldProtectClearCardOverlayClick(objectHit, fallbackHit)) {
      event.stopPropagation();
    }
  }, [packReady]);

  const handleRetryCard = useCallback(() => {
    setCardLoadStatus('loading');
    viewerRef.current?.retryCardModel();
  }, []);

  const handleRetryViewer = useCallback(() => {
    setViewerStatus('loading');
    setCardLoadStatus(cardModelUrl ? 'loading' : 'idle');
    setDisplayStage(viewerMode === 'card' ? 'revealed' : 'pack');
    setClearCardThreeViewer(() => createClearCardThreeViewerComponent());
    setViewerAttempt((attempt) => attempt + 1);
  }, [cardModelUrl, viewerMode]);

  const handleViewerError = useCallback(() => {
    setViewerStatus('error');
  }, []);

  return (
    <ModalFocusScope
      ariaLabel={
        viewerOnly
          ? `${boxName || (viewerMode === 'pack' ? 'Clear Cards pack' : 'Clear card')} 3D viewer`
          : boxName
            ? `${boxName} unboxing`
            : 'Clear card unboxing'
      }
      suspended={closing || suspended}
      focusKey={`${viewerStatus}:${cardLoadStatus}:${displayStage}`}
      className={`reveal-overlay clear-card-reveal-overlay reveal-overlay--${phase}${active ? ' reveal-overlay--active' : ''}${closing ? ' reveal-overlay--closing' : ''}${suspended ? ' reveal-overlay--suspended' : ''}`}
      style={overlayStyle}
      onContextMenu={(event) => event.preventDefault()}
      onDragStart={(event) => event.preventDefault()}
      onClick={handleBackdropClick}
    >
      <div className="reveal-overlay__backdrop" />
      <div
        className="reveal-overlay__frame clear-card-reveal-overlay__frame"
        onClick={handleFrameClick}
        onTransitionEnd={onTransitionEnd}
      >
        <div
          className={`clear-card-reveal-overlay__viewport${packReady ? ' clear-card-reveal-overlay__viewport--ready' : ''}`}
          aria-busy={!packReady || cardLoadStatus === 'loading'}
        >
          <div id="clear-card-reveal-blur-source" className="clear-card-reveal-overlay__visual">
            {resolvedLoadingImageSrc ? (
              <img
                ref={fallbackImageRef}
                className={`clear-card-reveal-overlay__fallback${
                  viewerMode === 'card'
                    ? ' clear-card-reveal-overlay__fallback--card-viewer'
                    : ''
                }`}
                src={resolvedLoadingImageSrc}
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
                  packModelUrl={viewerMode === 'card' ? undefined : DEFAULT_CLEAR_PACK_MODEL_URL}
                  lightingConfig={lightingConfig}
                  unrestrictedMovement={freeMovementEnabled}
                  axisLockedOrbit={false}
                  snapBackOnRelease={freeMovementEnabled}
                  interactionFrameRateMode="adaptive"
                  interactionEnabled={(viewerOnly || phase === 'ready') && !closing && !suspended}
                  interactionBounds="parent"
                  pointerActivationEnabled={!freeMovementEnabled}
                  keyboardActivationEnabled={!viewerOnly && displayStage === 'pack'}
                  keyboardRotationEnabled={freeMovementEnabled}
                  hitProgressionMode="reveal-gated"
                  revealReady={cardReady}
                  initiallyRevealed={viewerMode === 'card'}
                  ariaLabel={
                    viewerOnly
                      ? `Interactive 3D ${boxName || (viewerMode === 'pack' ? 'Clear Cards pack' : 'Clear card')}; drag or use arrow keys to rotate`
                      : freeMovementEnabled
                        ? `Interactive 3D ${boxName} card; drag or use arrow keys to rotate`
                        : displayStage === 'pack'
                          ? `Interactive 3D ${boxName}; press Enter or Space to hit the pack`
                          : `Interactive 3D ${boxName} unpacking`
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
              onClick={(event) => {
                event.stopPropagation();
                handleRetryViewer();
              }}
            >
              Retry 3D
            </button>
          ) : cardLoadStatus === 'error' ? (
            <button
              type="button"
              className="clear-card-reveal-overlay__retry"
              onClick={(event) => {
                event.stopPropagation();
                handleRetryCard();
              }}
            >
              Retry card
            </button>
          ) : null}
        </div>
      </div>
    </ModalFocusScope>
  );
}
