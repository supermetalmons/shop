import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState, type RefObject } from 'react';
import { ModalFocusScope } from './components/ModalFocusScope';
import MiNotePackViewer, { type MiNotePackControls } from './components/MiNotePackViewer';
import type { DrifCardConfig } from './drifCards';
import { isKeyboardShortcutTarget } from './lib/focusTrap';
import { MI_NOTE_CARD_EFFECTS } from './lib/miNoteCardEffects';
import { createMiNoteCard, MI_NOTE_CARD_COUNT, sampleMiNoteIndex } from './lib/miNoteCards';
import {
  createMiNoteRevealState,
  MI_NOTE_OPEN_TAPS,
  reduceMiNoteReveal,
  sampleMiNotePack,
  type MiNotePack,
} from './lib/miNoteCardReveal';
import { MI_NOTE_PACK_STARS, type MiNotePackStar } from './lib/miNotePackStars';
import { DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS } from './lib/miNoteStickerEffects';
import { MI_NOTE_STAR_VERTICAL_DEFAULT } from './lib/miNoteStarFolds';
import { navigate } from './navigation';
import './styles/mi-note-wip.css';

function MiNotePackOpening({
  selection,
  star,
  cardEffect,
  controlsRef,
  onRetry,
  onBackgroundTap,
}: {
  selection: ReturnType<typeof sampleMiNotePack>;
  star: MiNotePackStar;
  cardEffect: DrifCardConfig['effect'];
  controlsRef: RefObject<MiNotePackControls | null>;
  onRetry: () => void;
  onBackgroundTap: () => void;
}) {
  const [state, dispatch] = useReducer(reduceMiNoteReveal, undefined, createMiNoteRevealState);
  const [viewerReady, setViewerReady] = useState(false);
  const [viewerError, setViewerError] = useState<Error | null>(null);
  const [cardsReady, setCardsReady] = useState(false);
  const [cardsError, setCardsError] = useState<Error | null>(null);
  const selectedCardDescriptionId = useId();
  const cards = useMemo<readonly [DrifCardConfig, DrifCardConfig]>(
    () => [createMiNoteCard(selection.cardIds[0]), createMiNoteCard(selection.cardIds[1])],
    [selection.cardIds],
  );
  const error = viewerError || cardsError;
  const ready = viewerReady && cardsReady && !error;

  useEffect(() => dispatch({ type: 'ready', ready }), [ready]);

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
          verticalPosition={MI_NOTE_STAR_VERTICAL_DEFAULT}
          sizeScale={star.sizeScale}
          effectSettings={DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS}
          cards={cards}
          cardEffect={cardEffect}
          state={state}
          interactionEnabled={viewerReady && !error}
          onReadyChange={setViewerReady}
          onCardsReadyChange={setCardsReady}
          onCardsError={setCardsError}
          onError={setViewerError}
          onEvent={dispatch}
          onBackgroundTap={onBackgroundTap}
          controlsRef={controlsRef}
        />
      </div>
      <div
        className="mi-note-wip__actions"
        role="group"
        aria-label="Folder actions"
        onKeyDown={(event) => {
          if (!(event.target instanceof HTMLElement) || !event.target.matches('button')) return;
          if (event.key === 'Enter' && event.repeat) event.preventDefault();
          if (event.key !== ' ') return;
          event.preventDefault();
          if (!event.repeat) event.target.click();
        }}
      >
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
              <button
                key={index}
                type="button"
                aria-description={`Mi Note Card #${selection.cardIds[index]}`}
                onClick={() => controlsRef.current?.selectCard(index as 0 | 1)}
              >
                View {index === 0 ? 'left' : 'right'} card
              </button>
            ))}
          </>
        ) : (
          <button
            type="button"
            aria-describedby={selectedCardDescriptionId}
            disabled={!viewerReady || Boolean(error)}
            onClick={() => {
              if (state.cardStage === 'returning' && state.selectedCard !== null) {
                controlsRef.current?.selectCard(state.selectedCard);
              } else {
                controlsRef.current?.returnCard();
              }
            }}
          >
            {state.cardStage === 'returning' ? 'View card closeup' : 'Return card to pocket'}
            <span id={selectedCardDescriptionId} hidden>
              Mi Note Card #{selection.cardIds[state.selectedCard]}
            </span>
          </button>
        )}
      </div>
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
  const [round, setRound] = useState<{
    generation: number;
    selection: MiNotePack;
    star: MiNotePackStar;
    cardIdInputs: readonly [string, string];
  }>(() => {
    const selection = sampleMiNotePack();
    return {
      generation: 0,
      selection,
      star: MI_NOTE_PACK_STARS[sampleMiNoteIndex(MI_NOTE_PACK_STARS.length, Math.random)],
      cardIdInputs: [String(selection.cardIds[0]), String(selection.cardIds[1])],
    };
  });
  const [focused, setFocused] = useState(false);
  const [selectedEffect, setSelectedEffect] = useState<(typeof MI_NOTE_CARD_EFFECTS)[number]>(MI_NOTE_CARD_EFFECTS[0]);
  const controlsRef = useRef<MiNotePackControls | null>(null);
  const handleClose = useCallback(() => navigate('/'), []);
  const handleEscape = useCallback(() => {
    if (!controlsRef.current?.escape()) handleClose();
  }, [handleClose]);
  const handleBackgroundTap = useCallback(() => setFocused((value) => !value), []);
  const handleReset = useCallback(() => {
    setRound((previous) => {
      const selection = sampleMiNotePack();
      return {
        ...previous,
        generation: previous.generation + 1,
        selection,
        star: MI_NOTE_PACK_STARS[sampleMiNoteIndex(MI_NOTE_PACK_STARS.length, Math.random)],
        cardIdInputs: [String(selection.cardIds[0]), String(selection.cardIds[1])],
      };
    });
  }, []);
  const handleRetry = useCallback(() => {
    setRound((previous) => ({ ...previous, generation: previous.generation + 1 }));
  }, []);
  const handleCardIdChange = useCallback((index: 0 | 1, value: string) => {
    const id = Number(value);
    setRound((previous) => {
      const cardIdInputs: [string, string] = [...previous.cardIdInputs];
      cardIdInputs[index] = value;
      if (!Number.isInteger(id) || id < 1 || id > MI_NOTE_CARD_COUNT || id === previous.selection.cardIds[index]) {
        return { ...previous, cardIdInputs };
      }
      const cardIds: [number, number] = [...previous.selection.cardIds];
      cardIds[index] = id;
      return { ...previous, cardIdInputs, selection: { ...previous.selection, cardIds } };
    });
  }, []);

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
        cardEffect={selectedEffect.effect}
        controlsRef={controlsRef}
        onRetry={handleRetry}
        onBackgroundTap={handleBackgroundTap}
      />
      <div className={`wip-controls${focused ? ' wip-controls--hidden' : ''}`} aria-hidden={focused || undefined} inert={focused || undefined}>
        <button type="button" className="wip-close-btn" onClick={handleClose} aria-label="Close Mi Note Cards preview">Close</button>
        <div className="mi-note-wip__pickers" role="group" aria-label="Card controls">
          <div className="mi-note-wip__card-row">
            {([0, 1] as const).map((index) => (
              <input
                key={index}
                className="mi-note-wip__card-id"
                type="number"
                inputMode="numeric"
                aria-label={`${index === 0 ? 'Left' : 'Right'} card ID`}
                min={1}
                max={MI_NOTE_CARD_COUNT}
                step={1}
                value={round.cardIdInputs[index]}
                onChange={(event) => handleCardIdChange(index, event.target.value)}
              />
            ))}
            <select
              className="mi-note-wip__effect-picker"
              aria-label="Effect"
              value={selectedEffect.effect.effectKey}
              onChange={(event) => {
                const effect = MI_NOTE_CARD_EFFECTS.find((entry) => entry.effect.effectKey === event.target.value);
                if (effect) setSelectedEffect(effect);
              }}
            >
              {MI_NOTE_CARD_EFFECTS.map(({ name, effect }) => <option key={effect.effectKey} value={effect.effectKey}>{name}</option>)}
            </select>
          </div>
        </div>
        <button type="button" className="wip-reset-btn" onClick={handleReset} aria-label="Reset opening">Reset</button>
      </div>
    </ModalFocusScope>
  );
}
