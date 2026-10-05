import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ModalFocusScope } from './components/ModalFocusScope';
import MiNotePackViewer from './components/MiNotePackViewer';
import MiNoteFoldControls from './components/MiNoteFoldControls';
import WipInteractiveCard from './components/WipInteractiveCard';
import { useMiNoteCardAssets } from './hooks/useMiNoteCardAssets';
import { useMiNoteStarFolds } from './hooks/useMiNoteStarFolds';
import { isKeyboardShortcutTarget } from './lib/focusTrap';
import { getInteractiveCardPackCardsByFigureIds } from './lib/interactiveCardPackReveal';
import { createMiNoteCardInput } from './lib/miNoteCardInput';
import {
  createMiNoteRevealState,
  MI_NOTE_PACK_VARIANTS,
  reduceMiNoteReveal,
  sampleMiNotePack,
  type MiNotePack,
  type MiNotePackVariant,
  type MiNoteRevealStage,
} from './lib/miNoteCardReveal';
import { MI_NOTE_PACK_STARS, type MiNotePackStar } from './lib/miNotePackStars';
import { normalizeMiNoteStarFoldPosition, normalizeMiNoteStarRotationOffset } from './lib/miNoteStarFolds';
import { navigate } from './navigation';
import './styles/mi-note-wip.css';

function MiNotePackOpening({
  selection,
  star,
  foldPosition,
  rotationOffsetDegrees,
  buttonRef,
  onRetry,
  onStageChange,
}: {
  selection: ReturnType<typeof sampleMiNotePack>;
  star: MiNotePackStar;
  foldPosition: number;
  rotationOffsetDegrees: number;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onRetry: () => void;
  onStageChange: (stage: MiNoteRevealStage) => void;
}) {
  const [state, dispatch] = useReducer(reduceMiNoteReveal, undefined, createMiNoteRevealState);
  const [viewerReady, setViewerReady] = useState(false);
  const [viewerError, setViewerError] = useState<Error | null>(null);
  const [mountedError, setMountedError] = useState<Error | null>(null);
  const [mountedReady, setMountedReady] = useState<readonly [boolean, boolean]>([false, false]);
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
  const revealed = state.stage === 'revealed';
  const mountedCardsReady = mountedReady.every(Boolean);
  const ready = viewerReady && assets.ready && mountedCardsReady && !error;
  const handleFirstImageReady = useCallback((value: boolean) => {
    setMountedReady((previous) => previous[0] === value ? previous : [value, previous[1]]);
  }, []);
  const handleSecondImageReady = useCallback((value: boolean) => {
    setMountedReady((previous) => previous[1] === value ? previous : [previous[0], value]);
  }, []);
  const handleActivate = useCallback(() => {
    if (viewerReady && !error) dispatch({ type: 'activate' });
  }, [error, viewerReady]);
  const packInput = useMemo(() => createMiNoteCardInput(handleActivate), [handleActivate]);

  useLayoutEffect(() => onStageChange(state.stage), [onStageChange, state.stage]);

  useLayoutEffect(() => {
    cardElements.forEach((element) => {
      if (revealed) {
        element.removeAttribute('aria-hidden');
        element.removeAttribute('inert');
      } else {
        element.setAttribute('aria-hidden', 'true');
        element.setAttribute('inert', '');
      }
    });
  }, [cardElements, revealed]);

  useEffect(() => dispatch({ type: 'ready', ready }), [ready]);

  useEffect(() => {
    if (!assets.ready || mountedCardsReady) return;
    const timer = window.setTimeout(() => {
      setMountedError(new Error('The card images could not be displayed. Please retry.'));
    }, 10_000);
    return () => window.clearTimeout(timer);
  }, [assets.ready, mountedCardsReady]);

  const openingLocked = state.openRequested || ['opening', 'pack-falling', 'revealed'].includes(state.stage);
  const note = error
    ? 'Unable to load this pack.'
    : !viewerReady
      ? 'Loading…'
      : state.openRequested && !ready && !revealed
        ? 'Loading cards…'
        : '';

  return (
    <div
      className={`mi-note-wip mi-note-wip__opening${revealed ? ' mi-note-wip--revealed' : ''}`}
      data-stage={state.stage}
      data-variant={selection.variant.id}
      data-star={star.id}
    >
      <div className="mi-note-wip__stage">
        <MiNotePackViewer
          color={selection.variant.color}
          star={star}
          foldPosition={foldPosition}
          rotationOffsetDegrees={rotationOffsetDegrees}
          cardElements={cardElements}
          stage={state.stage}
          onReadyChange={setViewerReady}
          onError={setViewerError}
          onSealFinished={() => dispatch({ type: 'seal-finished' })}
          onOpened={() => dispatch({ type: 'opened' })}
          onDiscarded={() => dispatch({ type: 'discarded' })}
          buttonRef={buttonRef}
        />
        {!revealed && (
          <button
            ref={buttonRef}
            type="button"
            className="mi-note-wip__pack-button"
            aria-label={state.stage === 'sealed' ? 'Remove star seal' : 'Open Mi Note Cards pack'}
            aria-busy={state.openRequested && !ready}
            disabled={!viewerReady || Boolean(error) || openingLocked}
            {...packInput}
          />
        )}
      </div>
      {cards.map((card, index) => createPortal(
        <WipInteractiveCard
          card={card}
          interactive={revealed}
          wakeOnInteractiveUnlock
          onImageReadyChange={index === 0 ? handleFirstImageReady : handleSecondImageReady}
          ariaLabel={`Card NFT 2 card ${selection.cardIds[index]}`}
          imageAlt={`Card NFT 2 #${selection.cardIds[index]}`}
        />,
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
  const { foldPositions, rotationOffsetsDegrees, setFoldPosition, setRotationOffset, storageError } = useMiNoteStarFolds();
  const foldPosition = foldPositions[round.star.id];
  const rotationOffsetDegrees = rotationOffsetsDegrees[round.star.id];
  const stageRef = useRef<MiNoteRevealStage>('sealed');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const handleStageChange = useCallback((stage: MiNoteRevealStage) => { stageRef.current = stage; }, []);
  const handleClose = useCallback(() => navigate('/'), []);
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
  const resealForAdjustment = () => {
    if (stageRef.current !== 'sealed') {
      stageRef.current = 'sealed';
      handleRetry();
    }
  };
  const handleFoldChange = (value: number) => {
    const next = normalizeMiNoteStarFoldPosition(value);
    if (next === foldPosition) return;
    resealForAdjustment();
    setFoldPosition(round.star.id, next);
  };
  const handleRotationChange = (value: number) => {
    const next = normalizeMiNoteStarRotationOffset(value);
    if (next === rotationOffsetDegrees) return;
    resealForAdjustment();
    setRotationOffset(round.star.id, next);
  };
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
      } else if (event.code === 'Space') {
        event.preventDefault();
        buttonRef.current?.click();
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
      onEscape={handleClose}
      onPointerUp={(event) => {
        if (event.isPrimary && event.button === 0 && event.target instanceof Element && event.target.classList.contains('mi-note-wip__stage')) {
          setFocused((value) => !value);
        }
      }}
    >
      <MiNotePackOpening
        key={round.generation}
        selection={round.selection}
        star={round.star}
        foldPosition={foldPosition}
        rotationOffsetDegrees={rotationOffsetDegrees}
        buttonRef={buttonRef}
        onRetry={handleRetry}
        onStageChange={handleStageChange}
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
          <MiNoteFoldControls
            foldPosition={foldPosition}
            foldPositions={foldPositions}
            rotationOffsetDegrees={rotationOffsetDegrees}
            rotationOffsetsDegrees={rotationOffsetsDegrees}
            storageError={storageError}
            onChange={handleFoldChange}
            onRotationChange={handleRotationChange}
          />
        </div>
        <button type="button" className="wip-reset-btn" onClick={handleReset} aria-label="Reset opening">Reset</button>
      </div>
    </ModalFocusScope>
  );
}
