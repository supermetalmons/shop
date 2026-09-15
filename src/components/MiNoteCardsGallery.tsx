import { useMiNoteCards } from '../hooks/useMiNoteCards';
import { BackgroundLayerPortal } from './BackgroundBlurLayer';
import '../styles/mi-note-cards.css';

type MiNoteCardsGalleryProps = {
  onNotify: () => void;
};

export default function MiNoteCardsGallery({ onNotify }: MiNoteCardsGalleryProps) {
  const cards = useMiNoteCards();

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
