import { useEffect, useMemo, useState } from 'react';
import { ModalFocusScope } from './components/ModalFocusScope';
import MiNoteCardCssEffectPanel from './components/MiNoteCardCssEffectPanel';
import WipInteractiveCard from './components/WipInteractiveCard';
import type { DrifCardConfig } from './drifCards';
import { useMiNoteCardAssets } from './hooks/useMiNoteCardAssets';
import { useMiNoteCardCssDraft } from './hooks/useMiNoteCardCssDraft';
import { MI_NOTE_CARDS_DEFAULT } from './lib/miNoteCardEffects';
import { miNoteCardCssEffectStyle } from './lib/miNoteCardCssEffects';
import { createMiNoteCard, MI_NOTE_CARD_COUNT, sampleMiNoteCardId } from './lib/miNoteCards';
import { navigate } from './navigation';
import './styles/mi-note-cards-demo-wip.css';

function DemoCardPreview({ card, name, holdPose }: { card: DrifCardConfig; name: string; holdPose: boolean }) {
  const assets = useMiNoteCardAssets([card]);
  const [imageReady, setImageReady] = useState(false);
  const [displayFailed, setDisplayFailed] = useState(false);
  const [touchResting, setTouchResting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const failed = Boolean(assets.error) || displayFailed;
  const ready = assets.ready && imageReady && !failed;

  useEffect(() => {
    if (holdPose) setTouchResting(false);
  }, [holdPose]);

  useEffect(() => {
    if (!assets.ready || imageReady || displayFailed) return;
    const timer = window.setTimeout(() => setDisplayFailed(true), 10_000);
    return () => window.clearTimeout(timer);
  }, [assets.ready, imageReady, displayFailed]);

  return (
    <div className="mi-note-demo__preview" aria-busy={!ready && !failed}>
      <div
        className="mi-note-demo__card"
        style={{ visibility: ready ? 'visible' : 'hidden' }}
        onPointerDownCapture={() => setTouchResting(false)}
        onPointerEnter={(event) => { if (event.pointerType === 'mouse') setTouchResting(false); }}
        onPointerUpCapture={(event) => { if (event.pointerType !== 'mouse' && !holdPose) setTouchResting(true); }}
        onPointerCancel={() => setTouchResting(true)}
      >
        <WipInteractiveCard
          key={attempt}
          card={card}
          interactive={ready}
          onImageReadyChange={setImageReady}
          interactionMode={touchResting ? 'settling' : 'normal'}
          holdPoseOnLeave={holdPose}
          ariaLabel={`Inspect ${name}`}
          imageAlt={name}
        />
      </div>
      {!ready && (
        <div className="mi-note-demo__status" role={failed ? 'alert' : 'status'}>
          {failed ? (
            <>
              <span>Unable to load this card.</span>
              <button type="button" className="link" onClick={() => {
                setImageReady(false);
                setDisplayFailed(false);
                setAttempt((value) => value + 1);
                assets.retry();
              }}>Retry</button>
            </>
          ) : 'Loading…'}
        </div>
      )}
    </div>
  );
}

export default function MiNoteCardsDemoWipApp() {
  const [selectedCardId, setSelectedCardId] = useState(() => sampleMiNoteCardId());
  const [cardIdInput, setCardIdInput] = useState(() => String(selectedCardId));
  const [panelOpen, setPanelOpen] = useState(() => !window.matchMedia('(max-width: 760px)').matches);
  const [holdPose, setHoldPose] = useState(true);
  const draft = useMiNoteCardCssDraft();
  const effectStyle = useMemo(() => miNoteCardCssEffectStyle(draft.settings), [draft.settings]);
  const card = useMemo(
    () => createMiNoteCard(selectedCardId, MI_NOTE_CARDS_DEFAULT),
    [selectedCardId],
  );
  const handleClose = () => navigate('/');

  return (
    <ModalFocusScope
      className={`wip-page mi-note-demo${panelOpen ? ' mi-note-demo--panel-open' : ''}`}
      ariaLabel="Mi Note Cards demo"
      focusTarget="scope"
      onEscape={handleClose}
    >
      <div className="mi-note-demo__content" style={effectStyle}>
        <DemoCardPreview
          key={selectedCardId}
          card={card}
          name={`Mi Note Card #${selectedCardId}`}
          holdPose={holdPose}
        />
      </div>
      <div className="mi-note-demo__controls">
        <button type="button" className="wip-close-btn" onClick={handleClose} aria-label="Close Mi Note Cards demo">Close</button>
        <div className="mi-note-demo__card-controls" role="group" aria-label="Card controls">
          <input
            type="number"
            inputMode="numeric"
            aria-label="Card ID"
            min={1}
            max={MI_NOTE_CARD_COUNT}
            step={1}
            value={cardIdInput}
            onChange={(event) => {
              setCardIdInput(event.target.value);
              const next = event.target.valueAsNumber;
              if (Number.isInteger(next) && next >= 1 && next <= MI_NOTE_CARD_COUNT) setSelectedCardId(next);
            }}
          />
        </div>
      </div>
      <MiNoteCardCssEffectPanel
        settings={draft.settings}
        onChange={draft.setSettings}
        onReset={draft.reset}
        holdPose={holdPose}
        onHoldPoseChange={setHoldPose}
        open={panelOpen}
        onOpenChange={setPanelOpen}
      />
    </ModalFocusScope>
  );
}
