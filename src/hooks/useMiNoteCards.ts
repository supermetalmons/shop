import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import miNoteCollections from '../../mi_note_eth.json';
import {
  MI_NOTE_CONTRACT_ADDRESSES,
  miNoteAddressFromSearch,
} from '../../shared/miNoteCards.ts';
import { fetchMiNoteHoldings } from '../lib/shopApi';
import { subscribeToNavigation } from '../navigation';

const MI_NOTE_IMAGES = miNoteCollections.flatMap((collection) => collection.tokens);
const MI_NOTE_OWNED_COLLECTIONS = MI_NOTE_CONTRACT_ADDRESSES.map((contractAddress) => ({
  contractAddress,
  tokens: miNoteCollections.find(
    (collection) => collection.contractAddress.toLowerCase() === contractAddress,
  )!.tokens,
}));
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
    void fetchMiNoteHoldings(request.address, controller.signal).then((holdings) => {
      if (!active) return;
      const cards = MI_NOTE_OWNED_COLLECTIONS.flatMap(({ contractAddress, tokens }) => {
        const ownedIds = new Set(holdings[contractAddress]);
        return tokens.filter((card) => ownedIds.has(card.id));
      });
      setOwnedCards({ request, cards });
    }, () => {
      if (active) setOwnedCards({ request, cards: [] });
    });

    return () => {
      active = false;
      controller.abort();
    };
  }, [request]);

  if (!request.present) return randomCards;
  if (!request.address || ownedCards?.request !== request) return [];
  return ownedCards.cards;
}
