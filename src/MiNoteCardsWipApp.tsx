import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ModalFocusScope } from './components/ModalFocusScope';
import MiNotePackViewer, { type MiNotePackControls } from './components/MiNotePackViewer';
import WipInteractiveCard from './components/WipInteractiveCard';
import { useMiNoteCardAssets } from './hooks/useMiNoteCardAssets';
import { isKeyboardShortcutTarget } from './lib/focusTrap';
import { getInteractiveCardPackCardsByFigureIds } from './lib/interactiveCardPackReveal';
import {
  createMiNoteRevealState,
  MI_NOTE_PACK_VARIANTS,
  MI_NOTE_OPEN_TAPS,
  reduceMiNoteReveal,
  sampleMiNotePack,
  type MiNotePack,
  type MiNotePackVariant,
} from './lib/miNoteCardReveal';
import { MI_NOTE_PACK_STARS, type MiNotePackStar } from './lib/miNotePackStars';
import { navigate } from './navigation';
import './styles/mi-note-wip.css';

function MiNotePackOpening({
  selection,
  star,
  controlsRef,
  onRetry,
  onBackgroundTap,
}: {
  selection: ReturnType<typeof sampleMiNotePack>;
  star: MiNotePackStar;
  controlsRef: RefObject<MiNotePackControls | null>;
  onRetry: () => void;
  onBackgroundTap: () => void;
}) {
  const [state, dispatch] = useReducer(reduceMiNoteReveal, undefined, createMiNoteRevealState);
  const [viewerReady, setViewerReady] = useState(false);
  const [viewerError, setViewerError] = useState<Error | null>(null);
  const [mountedError, setMountedError] = useState<Error | null>(null);
  const [mountedReady, setMountedReady] = useState<readonly [boolean, boolean]>([false, false]);
  const [touchResting, setTouchResting] = useState(false);
  const [cardElements] = useState<readonly [HTMLDivElement, HTMLDivElement]>(() => {
    const createElement = () => {
      const element = document.createElement('div');
      element.className = 'mi-note-wip__card';
      element.setAttribute('aria-hidden', 'true');
      element.setAttribute('inert', '');
      return element;
    };
    return [createElement(), createElement()];
  });
  const cards = useMemo(
    () => getInteractiveCardPackCardsByFigureIds('card_nft_2', selection.cardIds),
    [selection.cardIds],
  );
  const assets = useMiNoteCardAssets(cards);
  const error = viewerError || assets.error || mountedError;
  const mountedCardsReady = mountedReady.every(Boolean);
  const ready = viewerReady && assets.ready && mountedCardsReady && !error;
  const handleFirstImageReady = useCallback((value: boolean) => {
    setMountedReady((previous) => previous[0] === value ? previous : [value, previous[1]]);
  }, []);
  const handleSecondImageReady = useCallback((value: boolean) => {
    setMountedReady((previous) => previous[1] === value ? previous : [previous[0], value]);
  }, []);

  useLayoutEffect(() => {
    cardElements.forEach((element, index) => {
      const active = index === state.selectedCard && state.cardStage === 'inspecting';
      element.dataset.active = String(active);
      element.toggleAttribute('inert', !active);
      if (active) element.removeAttribute('aria-hidden');
      else element.setAttribute('aria-hidden', 'true');
    });
  }, [cardElements, state.selectedCard, state.cardStage]);

  useEffect(() => dispatch({ type: 'ready', ready }), [ready]);
  useEffect(() => setTouchResting(false), [state.selectedCard]);

  useEffect(() => {
    if (!assets.ready || mountedCardsReady) return;
    const timer = window.setTimeout(() => {
      setMountedError(new Error('The card images could not be displayed. Please retry.'));
    }, 10_000);
    return () => window.clearTimeout(timer);
  }, [assets.ready, mountedCardsReady]);

  const openingLocked = state.stage === 'seal-peeling' || state.stage === 'unsealed';
  const note = error
    ? 'Unable to load this pack.'
    : !viewerReady
      ? 'Loading…'
      : openingLocked && !ready
        ? 'Loading cards…'
        : '';
  const packLabel = state.stage === 'sealed'
    ? `Open Mi Note Cards pack (${MI_NOTE_OPEN_TAPS - state.taps} ${state.taps === MI_NOTE_OPEN_TAPS - 1 ? 'tap' : 'taps'} remaining)`
    : state.folderPose === 1 ? 'Close Mi Note Cards folder' : 'Open Mi Note Cards folder';

  return (
    <div
      className="mi-note-wip mi-note-wip__opening"
      data-stage={state.stage}
      data-taps={state.taps}
      data-folder-pose={state.folderPose}
      data-card-stage={state.cardStage}
      data-selected-card={state.selectedCard ?? undefined}
      data-variant={selection.variant.id}
      data-star={star.id}
    >
      <div className="mi-note-wip__stage">
        <MiNotePackViewer
          color={selection.variant.color}
          star={star}
          foldPosition={star.foldPosition}
          rotationOffsetDegrees={star.rotationOffsetDegrees}
          cardElements={cardElements}
          state={state}
          interactionEnabled={viewerReady && !error}
          onReadyChange={setViewerReady}
          onError={setViewerError}
          onEvent={dispatch}
          onBackgroundTap={onBackgroundTap}
          controlsRef={controlsRef}
        />
      </div>
      <div className="mi-note-wip__actions" role="group" aria-label="Folder actions">
        {state.selectedCard === null ? (
          <>
            <button
              type="button"
              aria-label={packLabel}
              aria-expanded={state.folderPose === 1}
              aria-busy={openingLocked && !ready}
              disabled={!viewerReady || Boolean(error) || openingLocked}
              onClick={() => controlsRef.current?.activate()}
            >{packLabel}</button>
            {state.stage === 'interactive' && state.folderPose === 1 && ready && cards.map((_, index) => (
              <button key={index} type="button" onClick={() => controlsRef.current?.selectCard(index as 0 | 1)}>
                View {index === 0 ? 'left' : 'right'} card
              </button>
            ))}
          </>
        ) : (
          <button type="button" disabled={state.cardStage !== 'inspecting'} onClick={() => controlsRef.current?.returnCard()}>
            Return card to pocket
          </button>
        )}
      </div>
      {cards.map((card, index) => createPortal(
        <div
          className="mi-note-wip__card-content"
          onPointerDownCapture={() => setTouchResting(false)}
          onPointerEnter={(event) => { if (event.pointerType === 'mouse') setTouchResting(false); }}
          onPointerUpCapture={(event) => { if (event.pointerType !== 'mouse') setTouchResting(true); }}
          onPointerCancel={() => setTouchResting(true)}
        >
          <WipInteractiveCard
            card={card}
            interactive={state.selectedCard === index && (state.cardStage === 'inspecting' || state.cardStage === 'returning')}
            interactionMode={state.cardStage === 'returning' || touchResting ? 'settling' : 'normal'}
            wakeOnInteractiveUnlock={false}
            onImageReadyChange={index === 0 ? handleFirstImageReady : handleSecondImageReady}
            ariaLabel={`Card NFT 2 card ${selection.cardIds[index]}`}
            imageAlt={`Card NFT 2 #${selection.cardIds[index]}`}
          />
        </div>,
        cardElements[index],
        String(selection.cardIds[index]),
      ))}
      {note && (
        <div className="mi-note-wip__status" role={error ? 'alert' : 'status'}>
          {note}
          {error && <button type="button" className="link" onClick={onRetry}>Retry</button>}
        </div>
      )}
    </div>
  );
}

export default function MiNoteCardsWipApp() {
  const [round, setRound] = useState<{ generation: number; selection: MiNotePack; star: MiNotePackStar }>(() => ({
    generation: 0,
    selection: sampleMiNotePack(),
    star: MI_NOTE_PACK_STARS[0],
  }));
  const [focused, setFocused] = useState(false);
  const controlsRef = useRef<MiNotePackControls | null>(null);
  const handleClose = useCallback(() => navigate('/'), []);
  const handleEscape = useCallback(() => {
    if (!controlsRef.current?.escape()) handleClose();
  }, [handleClose]);
  const handleBackgroundTap = useCallback(() => setFocused((value) => !value), []);
  const handleReset = useCallback(() => {
    setRound((previous) => ({
      ...previous,
      generation: previous.generation + 1,
      selection: { ...sampleMiNotePack(), variant: previous.selection.variant },
    }));
  }, []);
  const handleRetry = useCallback(() => {
    setRound((previous) => ({ ...previous, generation: previous.generation + 1 }));
  }, []);
  const handleStarChange = useCallback((star: MiNotePackStar) => {
    setRound((previous) => previous.star.id === star.id ? previous : {
      ...previous,
      generation: previous.generation + 1,
      star,
    });
  }, []);
  const handleColorChange = useCallback((variant: MiNotePackVariant) => {
    setRound((previous) => previous.selection.variant.id === variant.id ? previous : {
      ...previous,
      generation: previous.generation + 1,
      selection: { ...previous.selection, variant },
    });
  }, []);
  const cycleStar = (direction: number) => {
    const index = MI_NOTE_PACK_STARS.findIndex((star) => star.id === round.star.id);
    handleStarChange(MI_NOTE_PACK_STARS[(index + direction + MI_NOTE_PACK_STARS.length) % MI_NOTE_PACK_STARS.length]);
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey || isKeyboardShortcutTarget(event.target)) return;
      if (event.code === 'KeyR') {
        event.preventDefault();
        handleReset();
      } else if (event.code === 'Space' || event.code === 'Enter') {
        event.preventDefault();
        controlsRef.current?.activate();
      } else if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
        event.preventDefault();
        controlsRef.current?.navigate(event.code === 'ArrowLeft' ? -1 : 1);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleReset]);

  return (
    <ModalFocusScope
      className="wip-page mi-note-wip-page"
      ariaLabel="Mi Note Cards pack preview"
      focusTarget="scope"
      onEscape={handleEscape}
    >
      <MiNotePackOpening
        key={round.generation}
        selection={round.selection}
        star={round.star}
        controlsRef={controlsRef}
        onRetry={handleRetry}
        onBackgroundTap={handleBackgroundTap}
      />
      <div className={`wip-controls${focused ? ' wip-controls--hidden' : ''}`} aria-hidden={focused || undefined} inert={focused || undefined}>
        <button type="button" className="wip-close-btn" onClick={handleClose} aria-label="Close Mi Note Cards preview">Close</button>
        <div className="mi-note-wip__pickers" role="group" aria-label="Pack appearance">
          <div className="mi-note-wip__appearance-row">
            <div className="mi-note-wip__star-picker">
              <button type="button" className="mi-note-wip__star-step" onClick={() => cycleStar(-1)} aria-label="Previous star">‹</button>
              <select
                aria-label="Star sticker"
                value={round.star.id}
                onChange={(event) => {
                  const star = MI_NOTE_PACK_STARS.find((entry) => entry.id === event.target.value);
                  if (star) handleStarChange(star);
                }}
              >
                {MI_NOTE_PACK_STARS.map((star) => <option key={star.id} value={star.id}>{star.name}</option>)}
              </select>
              <button type="button" className="mi-note-wip__star-step" onClick={() => cycleStar(1)} aria-label="Next star">›</button>
            </div>
            <div className="mi-note-wip__colors" role="group" aria-label="Pack color">
              {MI_NOTE_PACK_VARIANTS.map((variant) => (
                <button
                  key={variant.id}
                  type="button"
                  className="mi-note-wip__color"
                  aria-label={variant.name}
                  aria-pressed={round.selection.variant.id === variant.id}
                  title={variant.name}
                  onClick={() => handleColorChange(variant)}
                >
                  <span style={{ backgroundColor: variant.color }} />
                </button>
              ))}
            </div>
          </div>
        </div>
        <button type="button" className="wip-reset-btn" onClick={handleReset} aria-label="Reset opening">Reset</button>
      </div>
    </ModalFocusScope>
  );
}
