import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
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
  isClearCardRevealDismissReady,
  settleClearCardRevealRequest,
  shouldProtectClearCardOverlayClick,
  type ClearCardRevealRequestState,
} from '../lib/clearCardReveal';
import type { PonchoDrifellaRevealRequestStatus } from '../lib/ponchoDrifellaReveal';
import { useDarkColorScheme } from '../hooks/useDarkColorScheme';
import { useStaticToModelHandoff } from '../hooks/useStaticToModelHandoff';
import { useViewerDismissInput } from '../hooks/useViewerDismissInput';
import { resolveClearCardRevealRenderQuality } from '../lib/clearCardCanvas';
import {
  measureClearCardPreviewImage,
  resolveClearCardPreviewTransform,
  type ClearCardPreviewImage,
  type ClearCardPreviewModel,
} from '../lib/clearCardPreviewLayout';
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
  const [enteredResetKey, setEnteredResetKey] = useState<string | number | null>(null);
  const [previewImage, setPreviewImage] = useState<{ src: string; loaded: boolean; frame: ClearCardPreviewImage | null }>();
  const [previewModel, setPreviewModel] = useState<{ key: string; frame: ClearCardPreviewModel | null }>();
  const [imageCorsFailure, setImageCorsFailure] = useState<string>();
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
  const viewerOnly = Boolean(viewerMode);
  const previewKey = `${resetKey}:${viewerMode || 'unpack'}:${viewerAttempt}:${viewerMode === 'card' ? cardModelUrl : ''}`;
  const calibratePreview = Boolean(viewerOnly && resolvedLoadingImageSrc);
  const imageFrame = previewImage && previewImage.src === resolvedLoadingImageSrc ? previewImage.frame : undefined;
  const modelFrame = previewModel?.key === previewKey ? previewModel.frame : undefined;
  const previewMeasured = !calibratePreview || imageFrame === null || (imageFrame !== undefined && modelFrame !== undefined);
  const previewTransform = calibratePreview && imageFrame && modelFrame
    ? resolveClearCardPreviewTransform(imageFrame, modelFrame)
    : null;
  const startStyle = overlayStyle as Record<string, string | number | undefined> | undefined;
  const hasEntryTransform = ([
    ['--reveal-start-x', 0],
    ['--reveal-start-y', 0],
    ['--reveal-start-scale-x', 1],
    ['--reveal-start-scale-y', 1],
  ] as const).some(([property, rest]) => {
    const value = Number.parseFloat(String(startStyle?.[property] ?? rest));
    return Number.isFinite(value) && value !== rest;
  });
  const { modelVisible, fallbackVisible, onModelFrame } = useStaticToModelHandoff(
    active && enteredResetKey === resetKey && packReady && previewMeasured,
    `${previewKey}:${resolvedLoadingImageSrc}`,
  );
  const cardReady = Boolean(cardModelUrl && cardLoadStatus === 'ready');
  const returningToPreview = Boolean(
    closing && viewerOnly && previewImage?.src === resolvedLoadingImageSrc && previewImage?.loaded,
  );
  const showFallback = fallbackVisible || returningToPreview;
  const renderQualityByStage = useMemo(
    () => resolveClearCardRevealRenderQuality(viewerMode),
    [viewerMode],
  );
  const dismissReady = isClearCardRevealDismissReady(
    viewerOnly,
    displayStage,
    viewerStatus === 'error' || cardLoadStatus === 'error',
  );
  const freeMovementEnabled = isClearCardFreeMovementEnabled(viewerOnly, displayStage);
  const dismissInput = useViewerDismissInput({
    enabled: viewerOnly && !closing && !suspended,
    onDismiss,
    resetKey: `${resetKey}:${viewerMode}`,
  });

  useLayoutEffect(() => {
    if (!active) {
      setEnteredResetKey(null);
      return;
    }
    if (!hasEntryTransform || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setEnteredResetKey(resetKey);
      return;
    }
    const timeout = window.setTimeout(() => setEnteredResetKey(resetKey), 520);
    return () => window.clearTimeout(timeout);
  }, [active, hasEntryTransform, resetKey]);

  useEffect(() => {
    requestGenerationRef.current += 1;
    requestStateRef.current = createClearCardRevealRequestState(Boolean(cardModelUrl));
    setViewerAttempt(0);
    setViewerStatus('loading');
    setCardLoadStatus(cardModelUrl ? 'loading' : 'idle');
    setDisplayStage(viewerMode === 'card' ? 'revealed' : 'pack');
  }, [resetKey, viewerMode]);

  const handlePreviewFrame = useCallback((frame: ClearCardPreviewModel | null) => {
    setPreviewModel({ key: previewKey, frame });
  }, [previewKey]);

  const measurePreviewImage = useCallback(() => {
    const image = fallbackImageRef.current;
    if (!image || !resolvedLoadingImageSrc || !calibratePreview) return;
    let frame: ClearCardPreviewImage | null = null;
    try {
      frame = measureClearCardPreviewImage(image);
    } catch {}
    setPreviewImage({ src: resolvedLoadingImageSrc, loaded: image.naturalWidth > 0 && image.naturalHeight > 0, frame });
  }, [calibratePreview, resolvedLoadingImageSrc]);

  useLayoutEffect(() => {
    if (fallbackImageRef.current?.complete) measurePreviewImage();
  }, [measurePreviewImage]);

  useEffect(() => {
    if (cardModelUrl) requestStateRef.current = 'sent';
  }, [cardModelUrl]);

  useEffect(() => {
    onRevealCompleteChange?.(dismissReady);
    onDismissReadyChange?.(dismissReady);
  }, [dismissReady, onDismissReadyChange, onRevealCompleteChange]);

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
    if (!dismissReady || closing || suspended) return;
    onDismiss?.();
  }, [closing, dismissReady, onDismiss, suspended]);

  const handleFrameClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const objectHit = viewerRef.current?.isClientPointOnObject(event.clientX, event.clientY);
    const fallbackImage = fallbackImageRef.current;
    const fallbackHit = Boolean(
      fallbackVisible &&
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
  }, [fallbackVisible]);

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
      {...(viewerOnly ? dismissInput : {})}
      ariaLabel={
        viewerOnly
          ? `${boxName || (viewerMode === 'pack' ? 'Clear Cards pack' : 'Clear card')} 3D viewer`
          : boxName
            ? `${boxName} unboxing`
            : 'Clear card unboxing'
      }
      suspended={closing || suspended}
      focusKey={`${viewerStatus}:${cardLoadStatus}:${displayStage}:${fallbackVisible}`}
      className={`reveal-overlay clear-card-reveal-overlay reveal-overlay--${phase}${viewerOnly ? ' reveal-overlay--viewer' : ''}${active ? ' reveal-overlay--active' : ''}${closing ? ' reveal-overlay--closing' : ''}${suspended ? ' reveal-overlay--suspended' : ''}`}
      style={overlayStyle}
      onContextMenu={(event) => event.preventDefault()}
      onDragStart={(event) => event.preventDefault()}
      onClick={viewerOnly ? undefined : handleBackdropClick}
    >
      <div className="reveal-overlay__backdrop" />
      <div
        className="reveal-overlay__frame clear-card-reveal-overlay__frame"
        onClick={viewerOnly ? undefined : handleFrameClick}
        onTransitionEnd={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.propertyName === 'transform' && active && !closing) setEnteredResetKey(resetKey);
          onTransitionEnd?.(event);
        }}
      >
        <div
          className={`clear-card-reveal-overlay__viewport static-to-model${modelVisible ? ' static-to-model--visible' : ''}${showFallback ? '' : ' static-to-model--presented'}${returningToPreview ? ' clear-card-reveal-overlay__viewport--returning' : ''}`}
          aria-busy={
            viewerStatus !== 'error' && (!packReady || cardLoadStatus === 'loading')
          }
        >
          <div
            id="clear-card-reveal-blur-source"
            className="clear-card-reveal-overlay__visual"
            style={previewTransform ? {
              '--clear-card-preview-transform': `translate(${previewTransform.x}px, ${previewTransform.y}px) scale(${previewTransform.scaleX}, ${previewTransform.scaleY})`,
            } as CSSProperties : undefined}
          >
            {resolvedLoadingImageSrc ? (
              <img
                ref={fallbackImageRef}
                className="clear-card-reveal-overlay__fallback static-to-model__fallback"
                key={`${resolvedLoadingImageSrc}:${imageCorsFailure === resolvedLoadingImageSrc}`}
                crossOrigin={calibratePreview && imageCorsFailure !== resolvedLoadingImageSrc ? 'anonymous' : undefined}
                src={resolvedLoadingImageSrc}
                onLoad={measurePreviewImage}
                onError={() => {
                  if (!calibratePreview) return;
                  setPreviewImage({ src: resolvedLoadingImageSrc, loaded: false, frame: null });
                  setImageCorsFailure(resolvedLoadingImageSrc);
                }}
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
                  ready={modelVisible}
                  cardModelUrl={cardModelUrl}
                  packModelUrl={viewerMode === 'card' ? undefined : DEFAULT_CLEAR_PACK_MODEL_URL}
                  lightingConfig={lightingConfig}
                  renderQualityByStage={renderQualityByStage}
                  unrestrictedMovement={freeMovementEnabled}
                  axisLockedOrbit={false}
                  snapBackOnRelease={freeMovementEnabled}
                  interactionFrameRateMode="adaptive"
                  interactionEnabled={!fallbackVisible && (viewerOnly || phase === 'ready') && !closing && !suspended}
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
                  onFrameRendered={onModelFrame}
                  onPreviewFrame={calibratePreview ? handlePreviewFrame : undefined}
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
