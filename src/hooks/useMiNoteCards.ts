import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import miNoteCollections from '../../mi_note_eth.json';
import { MI_NOTE_2_CONTRACT_ADDRESS, miNoteAddressFromSearch } from '../../shared/miNoteCards.ts';
import { fetchMiNoteTokenIds } from '../lib/shopApi';
import { subscribeToNavigation } from '../navigation';

const MI_NOTE_IMAGES = miNoteCollections.flatMap((collection) => collection.tokens);
const MI_NOTE_2_IMAGES = miNoteCollections.find(
  (collection) => collection.contractAddress.toLowerCase() === MI_NOTE_2_CONTRACT_ADDRESS,
)!.tokens;
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

const currentSearch = () => window.location.search;

export function useMiNoteCards() {
  const search = useSyncExternalStore(subscribeToNavigation, currentSearch);
  const request = useMemo(() => miNoteAddressFromSearch(search), [search]);
  const [randomCards] = useState(selectRandomCards);
  const [ownedCards, setOwnedCards] = useState<{
    request: typeof request;
    cards: typeof MI_NOTE_IMAGES;
  } | null>(null);

  useEffect(() => {
    if (!request.address) return;
    const controller = new AbortController();
    let active = true;

    fetchMiNoteTokenIds(request.address, controller.signal).then(
      (tokenIds) => {
        if (!active) return;
        const ownedIds = new Set(tokenIds);
        setOwnedCards({ request, cards: MI_NOTE_2_IMAGES.filter((card) => ownedIds.has(card.id)) });
      },
      () => {
        if (active) setOwnedCards({ request, cards: [] });
      },
    );

    return () => {
      active = false;
      controller.abort();
    };
  }, [request]);

  if (!request.present) return randomCards;
  if (!request.address || ownedCards?.request !== request) return [];
  return ownedCards.cards;
}
