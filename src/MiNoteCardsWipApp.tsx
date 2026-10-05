import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ModalFocusScope } from './components/ModalFocusScope';
import MiNotePackViewer from './components/MiNotePackViewer';
import WipInteractiveCard from './components/WipInteractiveCard';
import { useMiNoteCardAssets } from './hooks/useMiNoteCardAssets';
import { isKeyboardShortcutTarget } from './lib/focusTrap';
import { getInteractiveCardPackCardsByFigureIds } from './lib/interactiveCardPackReveal';
import { createMiNoteCardInput } from './lib/miNoteCardInput';
import {
  createMiNoteRevealState,
  reduceMiNoteReveal,
  sampleMiNotePack,
} from './lib/miNoteCardReveal';
import { navigate } from './navigation';
import './styles/mi-note-wip.css';

function MiNotePackOpening({
  selection,
  onReset,
  onRetry,
}: {
  selection: ReturnType<typeof sampleMiNotePack>;
  onReset: () => void;
  onRetry: () => void;
}) {
  const [state, dispatch] = useReducer(reduceMiNoteReveal, undefined, createMiNoteRevealState);
  const [focused, setFocused] = useState(false);
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
  const buttonRef = useRef<HTMLButtonElement>(null);
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
  const handleClose = useCallback(() => navigate('/'), []);
  const handleActivate = useCallback(() => {
    if (viewerReady && !error) dispatch({ type: 'activate' });
  }, [error, viewerReady]);
  const packInput = useMemo(() => createMiNoteCardInput(handleActivate), [handleActivate]);

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

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey || isKeyboardShortcutTarget(event.target)) return;
      if (event.code === 'KeyR') {
        event.preventDefault();
        onReset();
      } else if (event.code === 'Space') {
        event.preventDefault();
        buttonRef.current?.click();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onReset]);

  const openingLocked = state.openRequested || ['opening', 'pack-falling', 'revealed'].includes(state.stage);
  const note = error
    ? 'Unable to load this pack.'
    : !viewerReady
      ? 'Loading…'
      : state.openRequested && !ready && !revealed
        ? 'Loading cards…'
        : '';

  return (
    <ModalFocusScope
      className={`wip-page mi-note-wip${revealed ? ' mi-note-wip--revealed' : ''}`}
      ariaLabel="Mi Note Cards pack preview"
      focusTarget="scope"
      onEscape={handleClose}
      data-stage={state.stage}
      data-variant={selection.variant.id}
      onPointerUp={(event) => {
        if (event.isPrimary && event.button === 0 && event.target instanceof Element && event.target.classList.contains('mi-note-wip__stage')) {
          setFocused((value) => !value);
        }
      }}
    >
      <div className="mi-note-wip__stage">
        <MiNotePackViewer
          color={selection.variant.color}
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
      <div className={`wip-controls${focused ? ' wip-controls--hidden' : ''}`} aria-hidden={focused || undefined} inert={focused || undefined}>
        <button type="button" className="wip-close-btn" onClick={handleClose} aria-label="Close Mi Note Cards preview">Close</button>
        <button type="button" className="wip-reset-btn" onClick={onReset} aria-label="Reset opening">Reset</button>
      </div>
      {note && (
        <div className="mi-note-wip__status" role={error ? 'alert' : 'status'}>
          {note}
          {error && <button type="button" className="link" onClick={onRetry}>Retry</button>}
        </div>
      )}
    </ModalFocusScope>
  );
}

export default function MiNoteCardsWipApp() {
  const [round, setRound] = useState(() => ({ generation: 0, selection: sampleMiNotePack() }));
  const handleReset = useCallback(() => {
    setRound((previous) => ({ generation: previous.generation + 1, selection: sampleMiNotePack() }));
  }, []);
  const handleRetry = useCallback(() => {
    setRound((previous) => ({ ...previous, generation: previous.generation + 1 }));
  }, []);
  return <MiNotePackOpening key={round.generation} selection={round.selection} onReset={handleReset} onRetry={handleRetry} />;
}
