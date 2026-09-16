import miNoteCollections from '../../mi_note_eth.json';
import { useMiNoteCards } from '../hooks/useMiNoteCards';
import { BackgroundLayerPortal } from './BackgroundBlurLayer';
import '../styles/mi-note-cards.css';

const MI_NOTE_OPENSEA_URLS = new Map(miNoteCollections.flatMap(({ contractAddress, tokens }) => (
  tokens.map(({ id, mid }) => [mid, `https://opensea.io/item/ethereum/${contractAddress}/${id}`] as const)
)));

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
            <figure key={card.mid} className="mi-note-cards__item">
              <img
                className="mi-note-cards__image"
                src={card.mid.replace('/mid/', '/thumbs/')}
                alt={card.name}
                loading="lazy"
                decoding="async"
                draggable={false}
                onDragStart={(event) => event.preventDefault()}
              />
              <figcaption className="mi-note-cards__name">
                <a
                  className="mi-note-cards__link"
                  href={MI_NOTE_OPENSEA_URLS.get(card.mid)}
                  target="_blank"
                  rel="noopener noreferrer"
                  draggable={false}
                  onDragStart={(event) => event.preventDefault()}
                >
                  {card.name}
                </a>
              </figcaption>
            </figure>
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
