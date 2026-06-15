import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type TransitionEvent } from 'react';
import { InventoryGrid } from './components/InventoryGrid';
import { PonchoCardViewerOverlay } from './components/PonchoRevealOverlay';
import { ShopHeader } from './components/ShopHeader';
import { useCardNft2UnrevealedCards } from './hooks/useCardNft2UnrevealedCards';
import { useOverlayScrollLock } from './hooks/useOverlayScrollLock';
import { cardNft2AssetUrl } from './lib/cardNft2Assets';
import { getInteractiveCardPackCardByFigureId } from './lib/interactiveCardPackReveal';
import {
  calcAspectLockedRevealOriginRect,
  calcPonchoDrifellaAbsoluteCardRect,
  calcPonchoDrifellaRevealTargetRectInViewport,
  getRevealOverlayViewport,
  ponchoDrifellaRevealOverlayStyleVars,
  sameRevealOverlayRect,
  toRevealOverlayRect,
  type PonchoDrifellaFrameRect,
} from './lib/revealOverlayLayout';
import {
  clearPonchoDrifellaImageCache,
  createPonchoDrifellaImageCache,
  preloadPonchoDrifellaCardAssets,
} from './lib/ponchoDrifellaReveal';
import type { DrifCardConfig } from './drifCards';
import type { InventoryItem } from './types';

const CARD_NFT_2_DROP_ID = 'card_nft_2';
const CARD_NFT_2_GRID_PAGE_SIZE = 240;

type UnrevealedCardViewerState = {
  overlayId: string;
  figureId: number;
  card: DrifCardConfig;
  originRect: PonchoDrifellaFrameRect;
  targetRect: PonchoDrifellaFrameRect;
  active: boolean;
  closing: boolean;
};

function cardNft2UnrevealedItem(cardId: number): InventoryItem {
  return {
    id: `card-nft-2-unrevealed-${cardId}`,
    dropId: CARD_NFT_2_DROP_ID,
    name: `Card #${cardId}`,
    kind: 'dude',
    dudeId: cardId,
    image: cardNft2AssetUrl('img', cardId),
  };
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message && !/^(internal|unknown)$/i.test(error.message.trim())) {
    return error.message;
  }
  return 'Unable to load unrevealed cards.';
}

export default function CardNft2UnrevealedApp() {
  const imageCacheRef = useRef(createPonchoDrifellaImageCache());
  const resizeRafRef = useRef<number | null>(null);
  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isError,
    isFetching,
    isFetchingNextPage,
    isLoading,
    refetch,
  } = useCardNft2UnrevealedCards();
  const [viewer, setViewer] = useState<UnrevealedCardViewerState | null>(null);
  const [visiblePageIndex, setVisiblePageIndex] = useState(0);
  const viewerOpen = Boolean(viewer);
  const cardIds = useMemo(() => data?.pages.flatMap((page) => page.ids) || [], [data]);
  const visiblePageStart = visiblePageIndex * CARD_NFT_2_GRID_PAGE_SIZE;
  const visiblePageEnd = visiblePageStart + CARD_NFT_2_GRID_PAGE_SIZE;
  const visibleCardIds = useMemo(
    () => cardIds.slice(visiblePageStart, visiblePageEnd),
    [cardIds, visiblePageEnd, visiblePageStart],
  );
  const items = useMemo(() => visibleCardIds.map(cardNft2UnrevealedItem), [visibleCardIds]);
  const totalFetched = cardIds.length;
  const hasLoadedNextGridPage = visiblePageEnd < totalFetched;
  const canShowPreviousGridPage = visiblePageIndex > 0;
  const canShowNextGridPage = hasLoadedNextGridPage || Boolean(hasNextPage);
  const visibleFirst = items.length ? visiblePageStart + 1 : 0;
  const visibleLast = visiblePageStart + items.length;
  const statusText = isLoading
    ? 'Loading'
    : items.length
      ? `${visibleFirst.toLocaleString()}-${visibleLast.toLocaleString()} of ${totalFetched.toLocaleString()}${hasNextPage ? '+' : ''}`
      : '0 cards';

  useEffect(() => {
    return () => {
      clearPonchoDrifellaImageCache(imageCacheRef.current);
    };
  }, []);

  useEffect(() => {
    setVisiblePageIndex((current) => {
      const lastPageIndex = Math.max(0, Math.ceil(totalFetched / CARD_NFT_2_GRID_PAGE_SIZE) - 1);
      return Math.min(current, lastPageIndex);
    });
  }, [totalFetched]);

  useEffect(() => {
    if (!viewer || viewer.active || viewer.closing) return undefined;
    const raf = window.requestAnimationFrame(() => {
      setViewer((current) => (current?.overlayId === viewer.overlayId ? { ...current, active: true } : current));
    });
    return () => window.cancelAnimationFrame(raf);
  }, [viewer]);

  useEffect(() => {
    if (!viewer || viewer.closing) return undefined;
    const overlayId = viewer.overlayId;
    const updateTargetRect = () => {
      if (resizeRafRef.current !== null) return;
      resizeRafRef.current = window.requestAnimationFrame(() => {
        resizeRafRef.current = null;
        const targetRect = calcPonchoDrifellaAbsoluteCardRect(calcPonchoDrifellaRevealTargetRectInViewport());
        setViewer((current) => {
          if (!current || current.overlayId !== overlayId || current.closing) return current;
          return sameRevealOverlayRect(current.targetRect, targetRect) ? current : { ...current, targetRect };
        });
      });
    };
    window.addEventListener('resize', updateTargetRect);
    window.addEventListener('orientationchange', updateTargetRect);
    window.visualViewport?.addEventListener('resize', updateTargetRect);
    window.visualViewport?.addEventListener('scroll', updateTargetRect);
    return () => {
      window.removeEventListener('resize', updateTargetRect);
      window.removeEventListener('orientationchange', updateTargetRect);
      window.visualViewport?.removeEventListener('resize', updateTargetRect);
      window.visualViewport?.removeEventListener('scroll', updateTargetRect);
      if (resizeRafRef.current !== null) {
        window.cancelAnimationFrame(resizeRafRef.current);
        resizeRafRef.current = null;
      }
    };
  }, [viewer?.overlayId, viewer?.closing]);

  const openCard = useCallback((item: InventoryItem, originRect?: DOMRect | null) => {
    const figureId = item.dudeId;
    if (typeof figureId !== 'number') return;
    const card = getInteractiveCardPackCardByFigureId(CARD_NFT_2_DROP_ID, figureId);
    if (!card) return;

    preloadPonchoDrifellaCardAssets(card, imageCacheRef.current, { mode: 'warm', priority: 'low' });
    const targetRect = calcPonchoDrifellaAbsoluteCardRect(calcPonchoDrifellaRevealTargetRectInViewport());
    const resolvedOriginRect = originRect
      ? calcAspectLockedRevealOriginRect(originRect, targetRect)
      : new DOMRect(targetRect.left, targetRect.top, targetRect.width, targetRect.height);

    setViewer({
      overlayId: item.id,
      figureId,
      card,
      originRect: toRevealOverlayRect(resolvedOriginRect),
      targetRect,
      active: false,
      closing: false,
    });
  }, []);

  const dismissViewer = useCallback(() => {
    setViewer((current) => (current && !current.closing ? { ...current, active: false, closing: true } : current));
  }, []);

  const showPreviousGridPage = useCallback(() => {
    setVisiblePageIndex((current) => Math.max(0, current - 1));
  }, []);

  const showNextGridPage = useCallback(() => {
    if (hasLoadedNextGridPage) {
      setVisiblePageIndex((current) => current + 1);
      return;
    }
    if (!hasNextPage || isFetchingNextPage) return;

    void fetchNextPage().then((result) => {
      if (result.isError) return;
      setVisiblePageIndex((current) => current + 1);
    });
  }, [fetchNextPage, hasLoadedNextGridPage, hasNextPage, isFetchingNextPage]);

  useOverlayScrollLock({ active: viewerOpen, onEscape: dismissViewer });

  const handleViewerTransitionEnd = useCallback((evt: TransitionEvent<HTMLDivElement>) => {
    if (evt.target !== evt.currentTarget || evt.propertyName !== 'opacity') return;
    setViewer((current) => (current?.closing ? null : current));
  }, []);

  const viewerOverlayStyle: CSSProperties | undefined = viewer
    ? (ponchoDrifellaRevealOverlayStyleVars({
        originRect: viewer.originRect,
        targetRect: viewer.targetRect,
        mode: 'poncho-card',
        viewport: getRevealOverlayViewport(),
        cardCount: 1,
      }) as CSSProperties)
    : undefined;

  return (
    <div className="page card-nft2-unrevealed-page">
      {viewer ? (
        <PonchoCardViewerOverlay
          overlayStyle={viewerOverlayStyle}
          active={viewer.active}
          closing={viewer.closing}
          card={viewer.card}
          cardIdLabel={`#${viewer.figureId}`}
          onDismiss={dismissViewer}
          onTransitionEnd={handleViewerTransitionEnd}
        />
      ) : null}
      <ShopHeader scrollHomeToTop />
      <section className="app-section card-nft2-unrevealed-section">
        <div className="app-section__head card-nft2-unrevealed-section__head">
          <div>
            <div className="app-section__title">Unrevealed Cards</div>
            <div className="muted small">{statusText}</div>
          </div>
        </div>
        {isError ? (
          <div className="error card-nft2-unrevealed-section__error">
            {errorText(error)}
            <button
              type="button"
              className="quiet card-nft2-unrevealed-section__retry"
              onClick={() => {
                void refetch();
              }}
            >
              Retry
            </button>
          </div>
        ) : null}
        <InventoryGrid
          items={items}
          onViewItem={openCard}
          interactionMode="view-only"
          figureMediaMode="image"
          className="inventory--card-nft2-unrevealed"
          emptyStateVisibility={isLoading ? 'hidden' : 'visible'}
        />
        {isLoading ? <div className="muted small card-nft2-unrevealed-section__loading">Loading cards...</div> : null}
        {canShowPreviousGridPage || canShowNextGridPage ? (
          <div className="card-nft2-unrevealed-section__pager" aria-label="Card page navigation">
            <button
              type="button"
              className="quiet card-nft2-unrevealed-section__page-button"
              onClick={showPreviousGridPage}
              disabled={!canShowPreviousGridPage}
            >
              Previous
            </button>
            <span className="muted small card-nft2-unrevealed-section__page-status">
              Page {(visiblePageIndex + 1).toLocaleString()}
            </span>
            <button
              type="button"
              className="quiet card-nft2-unrevealed-section__page-button"
              onClick={showNextGridPage}
              disabled={!canShowNextGridPage || (isFetchingNextPage && !hasLoadedNextGridPage)}
            >
              {isFetchingNextPage && !hasLoadedNextGridPage ? 'Loading...' : 'Next'}
            </button>
          </div>
        ) : totalFetched && !isFetching ? (
          <div className="muted small card-nft2-unrevealed-section__end">End of list</div>
        ) : null}
      </section>
    </div>
  );
}
