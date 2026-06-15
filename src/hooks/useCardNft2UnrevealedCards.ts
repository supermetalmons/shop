import { useInfiniteQuery } from '@tanstack/react-query';
import { listCardNft2UnrevealedCards } from '../lib/api';

export function useCardNft2UnrevealedCards() {
  return useInfiniteQuery({
    queryKey: ['card-nft-2-unrevealed-cards'],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      listCardNft2UnrevealedCards(typeof pageParam === 'number' ? { cursor: pageParam } : undefined),
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextCursor : undefined),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}
