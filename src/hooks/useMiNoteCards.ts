import { useCallback, useEffect, useMemo, useState } from 'react';
import miNoteCollections from '../../mi_note_eth.json';
import {
  MI_NOTE_CONTRACT_ADDRESSES,
  normalizeMiNoteAddress,
} from '../../shared/miNoteCards.ts';
import { fetchMiNoteHoldings } from '../lib/shopApi';

const MI_NOTE_IMAGES = miNoteCollections.flatMap((collection) => collection.tokens);
const MI_NOTE_OWNED_COLLECTIONS = MI_NOTE_CONTRACT_ADDRESSES.map((contractAddress) => ({
  contractAddress,
  tokens: miNoteCollections.find(
    (collection) => collection.contractAddress.toLowerCase() === contractAddress,
  )!.tokens,
}));
const MI_NOTE_CARD_COUNT = 300;
const EMPTY_CARDS: typeof MI_NOTE_IMAGES = [];

export type MiNoteCardsSource =
  | { mode: 'all' }
  | { mode: 'owned'; address: string }
  | { mode: 'inactive' };

type MiNoteCardsState = {
  cards: typeof MI_NOTE_IMAGES;
  status: 'idle' | 'loading' | 'success' | 'partial' | 'error';
  retry: () => void;
};

function selectRandomCards() {
  const cards = [...MI_NOTE_IMAGES];
  const count = Math.min(MI_NOTE_CARD_COUNT, cards.length);

  for (let index = 0; index < count; index += 1) {
    const randomIndex = index + Math.floor(Math.random() * (cards.length - index));
    [cards[index], cards[randomIndex]] = [cards[randomIndex], cards[index]];
  }

  return cards.slice(0, count);
}

export function useMiNoteCards(source: MiNoteCardsSource): MiNoteCardsState {
  const address = source.mode === 'owned' ? normalizeMiNoteAddress(source.address) : null;
  const [attempt, setAttempt] = useState(0);
  const request = useMemo(() => address ? { address, attempt } : null, [address, attempt]);
  const [randomCards] = useState(selectRandomCards);
  const [ownedCards, setOwnedCards] = useState<{
    request: NonNullable<typeof request>;
    cards: typeof MI_NOTE_IMAGES;
    status: 'success' | 'partial' | 'error';
  } | null>(null);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    if (!request) return;
    const controller = new AbortController();
    let active = true;
    void fetchMiNoteHoldings(request.address, controller.signal).then(({ tokenIdsByContract, resultsByContract }) => {
      if (!active) return;
      const cards = MI_NOTE_OWNED_COLLECTIONS.flatMap(({ contractAddress, tokens }) => {
        const ownedIds = new Set(tokenIdsByContract[contractAddress]);
        return tokens.filter((card) => ownedIds.has(card.id));
      });
      const partial = Object.values(resultsByContract).some((result) => result.status === 'error');
      setOwnedCards({ request, cards, status: partial ? 'partial' : 'success' });
    }, () => {
      if (active) setOwnedCards({ request, cards: EMPTY_CARDS, status: 'error' });
    });

    return () => {
      active = false;
      controller.abort();
    };
  }, [request]);

  if (source.mode === 'all') return { cards: randomCards, status: 'success', retry };
  if (!request) return { cards: EMPTY_CARDS, status: 'idle', retry };
  if (ownedCards?.request !== request) return { cards: EMPTY_CARDS, status: 'loading', retry };
  return { cards: ownedCards.cards, status: ownedCards.status, retry };
}
