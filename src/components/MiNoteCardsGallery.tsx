import { useState } from 'react';
import miNoteCollections from '../../mi_note_eth.json';
import { BackgroundLayerPortal } from './BackgroundBlurLayer';
import '../styles/mi-note-cards.css';

const MI_NOTE_IMAGES = miNoteCollections.flatMap((collection) => collection.tokens);
const MI_NOTE_CARD_COUNT = 300;

function selectRandomCards() {
  const cards = [...MI_NOTE_IMAGES];
  const count = Math.min(MI_NOTE_CARD_COUNT, cards.length);

  for (let index = 0; index < count; index += 1) {
    const randomIndex = index + Math.floor(Math.random() * (cards.length - index));
    [cards[index], cards[randomIndex]] = [cards[randomIndex], cards[index]];
  }

  return cards.slice(0, count);
}

type MiNoteCardsGalleryProps = {
  onNotify: () => void;
};

export default function MiNoteCardsGallery({ onNotify }: MiNoteCardsGalleryProps) {
  const [cards] = useState(selectRandomCards);

  return (
    <>
      <main className="mi-note-cards" aria-label="Mi Note cards">
        <div className="mi-note-cards__grid">
          {cards.map((card) => (
            <img
              key={card.mid}
              className="mi-note-cards__image"
              src={card.mid.replace('/mid/', '/thumbs/')}
              alt={card.name}
              loading="lazy"
              decoding="async"
            />
          ))}
        </div>
      </main>
      <BackgroundLayerPortal placement="trailing">
        <button type="button" className="mi-note-cards__notify" onClick={onNotify}>
          Notify me
        </button>
      </BackgroundLayerPortal>
    </>
  );
}
