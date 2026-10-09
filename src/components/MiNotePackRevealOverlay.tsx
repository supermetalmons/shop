import {
  Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent, type ReactNode, type TransitionEvent,
} from 'react';
import type { MiNotePackControls } from './MiNotePackViewer';
import type { DrifCardConfig } from '../drifCards';
import { isKeyboardShortcutTarget } from '../lib/focusTrap';
import { MI_NOTE_CARDS_DEFAULT } from '../lib/miNoteCardEffects';
import { MI_NOTE_CARDS_PACK_PLACEHOLDER_IMAGE_URL } from '../config/dropMediaDefaults';
import { createMiNoteCard } from '../lib/miNoteCards';
import {
  createMiNoteRevealState, miNoteRevealCardIds, MI_NOTE_INVENTORY_OPEN_TAPS,
  reduceMiNoteInventoryReveal, type MiNoteRevealEvent,
} from '../lib/miNoteCardReveal';
import { MI_NOTE_PACK_STARS } from '../lib/miNotePackStars';
import { normalizeMiNoteStickerEffectSettings } from '../lib/miNoteStickerEffects';
import packRenderSetups from '../lib/miNotePackRenderSetups.json';
import type { RevealRequestStatus } from '../shop/reveal';
import { ModalFocusScope } from './ModalFocusScope';
import '../styles/mi-note-wip.css';

function createViewer() {
  return lazy(() => import('./MiNotePackViewer'));
}

class MiNoteViewerBoundary extends Component<{ children: ReactNode; onError: (error: Error) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { this.props.onError(error); }
  render() { return this.state.failed ? null : this.props.children; }
}

type MiNotePackRevealOverlayProps = {
  overlayStyle?: CSSProperties;
  active: boolean;
  closing: boolean;
  suspended?: boolean;
  viewerOnly?: boolean;
  phase: 'preparing' | 'ready' | 'revealed';
  packMediaId?: number;
  revealedIds?: readonly number[];
  loadingImageSrc?: string;
  boxName: string;
  onRequestReveal?: () => RevealRequestStatus | void | Promise<RevealRequestStatus | void>;
  onBeforeAdvance?: () => boolean;
  onDismiss?: () => void;
  onTransitionEnd?: (event: TransitionEvent<HTMLDivElement>) => void;
  onRevealCompleteChange?: (complete: boolean) => void;
  onDismissReadyChange?: (ready: boolean) => void;
};

export default function MiNotePackRevealOverlay({
  overlayStyle, active, closing, suspended = false, viewerOnly = false, phase,
  packMediaId, revealedIds, loadingImageSrc, boxName, onRequestReveal, onBeforeAdvance,
  onDismiss, onTransitionEnd, onRevealCompleteChange, onDismissReadyChange,
}: MiNotePackRevealOverlayProps) {
  const controlsRef = useRef<MiNotePackControls | null>(null);
  const requestStateRef = useRef<'idle' | 'pending' | 'sent'>('idle');
  const requestGenerationRef = useRef(0);
  const [Viewer, setViewer] = useState(createViewer);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState(createMiNoteRevealState);
  const [viewerReady, setViewerReady] = useState(false);
  const [viewerError, setViewerError] = useState<Error | null>(null);
  const [requestFailed, setRequestFailed] = useState(false);
  const cardIds = useMemo(() => viewerOnly ? undefined : miNoteRevealCardIds(revealedIds), [revealedIds, viewerOnly]);
  const cards = useMemo<readonly [DrifCardConfig, DrifCardConfig] | undefined>(
    () => cardIds ? [createMiNoteCard(cardIds[0]), createMiNoteCard(cardIds[1])] : undefined,
    [cardIds],
  );
  const cardKey = `${attempt}:${cardIds?.join(',') || ''}`;
  const cardIdsRef = useRef(cardIds);
  cardIdsRef.current = cardIds;
  const [cardStatus, setCardStatus] = useState<{ key: string; ready: boolean; error: Error | null }>({
    key: cardKey, ready: false, error: null,
  });
  const cardsError = cardStatus.key === cardKey ? cardStatus.error : null;
  const error = viewerError || cardsError;
  const setup = useMemo(() => Object.values(packRenderSetups.setups).find(entry => entry.packId === packMediaId), [packMediaId]);
  const star = MI_NOTE_PACK_STARS.find(entry => entry.id === setup?.sticker.id);
  const ready = Boolean(setup && cards && viewerReady && cardStatus.key === cardKey && cardStatus.ready && !error);
  const interactionEnabled = Boolean(setup && viewerReady && !error && !closing && !suspended && (viewerOnly || phase === 'ready'));
  const dismissReady = viewerOnly || !setup || state.stage === 'interactive' || Boolean(error) || requestFailed;
  const effectSettings = useMemo(() => normalizeMiNoteStickerEffectSettings(setup?.sticker.effectSettings), [setup]);
  const fallbackImage = setup && loadingImageSrc ? loadingImageSrc : MI_NOTE_CARDS_PACK_PLACEHOLDER_IMAGE_URL;
  const showFallback = !setup || !viewerReady || Boolean(error);

  useEffect(() => {
    setState(previous => reduceMiNoteInventoryReveal(previous, { type: 'ready', ready }));
  }, [ready]);
  useEffect(() => {
    if (cardIds) {
      requestStateRef.current = 'sent';
      setRequestFailed(false);
    }
  }, [cardIds]);
  useEffect(() => () => { requestGenerationRef.current += 1; }, []);
  useEffect(() => {
    onRevealCompleteChange?.(dismissReady);
    onDismissReadyChange?.(dismissReady);
  }, [dismissReady, onDismissReadyChange, onRevealCompleteChange]);
  useEffect(() => () => {
    onRevealCompleteChange?.(false);
    onDismissReadyChange?.(false);
  }, [onDismissReadyChange, onRevealCompleteChange]);

  const requestReveal = useCallback(() => {
    if (viewerOnly || cardIdsRef.current || !onRequestReveal || requestStateRef.current !== 'idle') return;
    requestStateRef.current = 'pending';
    setRequestFailed(false);
    const generation = requestGenerationRef.current;
    const settle = (status: RevealRequestStatus | void) => {
      if (generation !== requestGenerationRef.current) return;
      const retry = status === 'retry' && !cardIdsRef.current;
      requestStateRef.current = retry ? 'idle' : 'sent';
      setRequestFailed(retry);
    };
    void Promise.resolve().then(onRequestReveal).then(settle, () => settle('retry'));
  }, [onRequestReveal, viewerOnly]);

  const handleEvent = useCallback((event: MiNoteRevealEvent) => {
    if (viewerOnly) {
      if (event.type === 'folder-pose' && event.pose !== 1) {
        setState(previous => reduceMiNoteInventoryReveal(previous, event));
      }
      return;
    }
    if (event.type === 'activate') {
      if (!interactionEnabled) return;
      if (state.stage === 'sealed') {
        if (onBeforeAdvance && !onBeforeAdvance()) return;
        requestReveal();
      }
    }
    setState(previous => reduceMiNoteInventoryReveal(
      reduceMiNoteInventoryReveal(previous, { type: 'ready', ready }), event,
    ));
  }, [interactionEnabled, onBeforeAdvance, ready, requestReveal, state.stage, viewerOnly]);

  const handleCardsReady = useCallback((cardsReady: boolean) => {
    setCardStatus(previous => ({ key: cardKey, ready: cardsReady, error: previous.key === cardKey ? previous.error : null }));
  }, [cardKey]);
  const handleCardsError = useCallback((cardsError: Error | null) => {
    setCardStatus(previous => ({ key: cardKey, ready: previous.key === cardKey && previous.ready, error: cardsError }));
  }, [cardKey]);
  const retryViewer = useCallback(() => {
    setViewerReady(false);
    setViewerError(null);
    setState(createMiNoteRevealState());
    setAttempt(previous => previous + 1);
    setViewer(createViewer);
  }, []);
  const dismiss = useCallback(() => {
    if (dismissReady && !closing && !suspended) onDismiss?.();
  }, [closing, dismissReady, onDismiss, suspended]);
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || closing || suspended) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (!controlsRef.current?.escape()) dismiss();
      return;
    }
    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || isKeyboardShortcutTarget(event.target)) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      controlsRef.current?.navigate(event.key === 'ArrowLeft' ? -1 : 1);
    } else if (!viewerOnly && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      controlsRef.current?.activate();
    }
  };
  const openingLocked = state.stage === 'seal-peeling' || state.stage === 'unsealed';
  const tapsRemaining = Math.max(0, MI_NOTE_INVENTORY_OPEN_TAPS - state.taps);
  const packLabel = state.stage === 'sealed'
    ? tapsRemaining > 0
      ? `Unseal Mi Note Cards pack (${tapsRemaining} ${tapsRemaining === 1 ? 'tap' : 'taps'} remaining)`
      : ready ? 'Unseal Mi Note Cards pack' : 'Waiting for Mi Note cards'
    : state.folderPose === 1 ? 'Close Mi Note Cards folder' : 'Open Mi Note Cards folder';

  return (
    <ModalFocusScope
      ariaLabel={`${boxName} ${viewerOnly ? '3D viewer' : 'unboxing'}`}
      focusTarget="scope"
      suspended={closing || suspended}
      className={`reveal-overlay mi-note-pack-overlay reveal-overlay--${phase}${active ? ' reveal-overlay--active' : ''}${closing ? ' reveal-overlay--closing' : ''}`}
      style={overlayStyle}
      onKeyDown={handleKeyDown}
      onContextMenu={event => event.preventDefault()}
      onDragStart={event => event.preventDefault()}
      data-stage={state.stage}
      data-taps={state.taps}
      data-folder-pose={state.folderPose}
      data-card-stage={state.cardStage}
    >
      <div className="reveal-overlay__backdrop" onClick={dismiss} />
      <div className="reveal-overlay__frame" onTransitionEnd={onTransitionEnd} onClick={event => {
        if (showFallback && event.target === event.currentTarget) dismiss();
      }}>
        {showFallback && <div className="mi-note-pack-overlay__fallback">
          <img src={fallbackImage} alt="" aria-hidden draggable={false} />
          {error && <button type="button" className="mi-note-pack-overlay__retry" aria-label="Retry loading pack"
            disabled={closing || suspended} onClick={retryViewer} />}
        </div>}
        {setup && star && <div className="mi-note-wip__stage" style={{ visibility: showFallback ? 'hidden' : 'visible' }}>
          <MiNoteViewerBoundary key={attempt} onError={setViewerError}>
            <Suspense fallback={null}>
              <Viewer
                key={attempt}
                color={setup.color}
                star={star}
                foldPosition={setup.sticker.foldPosition}
                rotationOffsetDegrees={setup.sticker.rotationOffsetDegrees}
                verticalPosition={setup.sticker.verticalPosition}
                sizeScale={setup.sticker.sizeScale}
                effectSettings={effectSettings}
                cards={cards}
                cardEffect={MI_NOTE_CARDS_DEFAULT}
                state={state}
                interactionEnabled={interactionEnabled}
                activationEnabled={!viewerOnly}
                onReadyChange={setViewerReady}
                onCardsReadyChange={handleCardsReady}
                onCardsError={handleCardsError}
                onError={setViewerError}
                onEvent={handleEvent}
                onBackgroundTap={dismiss}
                controlsRef={controlsRef}
              />
            </Suspense>
          </MiNoteViewerBoundary>
        </div>}
        <div className="mi-note-wip__actions" role="group" aria-label="Pack actions" onKeyDown={event => {
          if (!(event.target instanceof HTMLElement) || !event.target.matches('button')) return;
          if (event.key === 'Enter' && event.repeat) event.preventDefault();
          if (event.key !== ' ') return;
          event.preventDefault();
          if (!event.repeat) event.target.click();
        }}>
          {viewerOnly ? <>
            <button type="button" disabled={!interactionEnabled} onClick={() => controlsRef.current?.navigate(-1)}>Rotate pack left</button>
            <button type="button" disabled={!interactionEnabled} onClick={() => controlsRef.current?.navigate(1)}>Rotate pack right</button>
          </> : state.selectedCard === null ? <>
            <button type="button" aria-expanded={state.folderPose === 1} disabled={!interactionEnabled || openingLocked}
              onClick={() => controlsRef.current?.activate()}>{packLabel}</button>
            {state.stage === 'interactive' && state.folderPose === 1 && ready && cardIds?.map((id, index) => (
              <button key={index} type="button" aria-description={`Mi Note Card #${id}`}
                onClick={() => controlsRef.current?.selectCard(index as 0 | 1)}>View {index === 0 ? 'left' : 'right'} card</button>
            ))}
          </> : (
            <button type="button" disabled={!interactionEnabled} onClick={() => {
              if (state.cardStage === 'returning' && state.selectedCard !== null) controlsRef.current?.selectCard(state.selectedCard);
              else controlsRef.current?.returnCard();
            }}>{state.cardStage === 'returning' ? 'View card closeup' : 'Return card to pocket'}</button>
          )}
        </div>
      </div>
    </ModalFocusScope>
  );
}
