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
const CARD_NFT_2_AUTO_LOAD_ROOT_MARGIN = '720px 0px';

type UnrevealedAutoLoadState = {
  cardCount: number;
  hasNextPage: boolean;
  nextCursor?: number;
};

type UnrevealedCardViewerState = {
  overlayId: string;
  figureId: number;
  card: DrifCardConfig;
  loadingImageSrc?: string;
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

function cardNft2UnrevealedLoadingImageSrc(image: string | undefined): string | undefined {
  const trimmed = String(image || '').trim();
  return trimmed ? `${trimmed}#unrevealed-grid-preview` : undefined;
}

export default function CardNft2UnrevealedApp() {
  const imageCacheRef = useRef(createPonchoDrifellaImageCache());
  const resizeRafRef = useRef<number | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const nextPageRequestInFlightRef = useRef(false);
  const blockedAutoLoadKeyRef = useRef<string | null>(null);
  const autoLoadStateRef = useRef<UnrevealedAutoLoadState>({
    cardCount: 0,
    hasNextPage: false,
  });
  const {
    data,
    fetchNextPage,
    hasNextPage,
  } = useCardNft2UnrevealedCards();
  const [viewer, setViewer] = useState<UnrevealedCardViewerState | null>(null);
  const viewerOpen = Boolean(viewer);
  const cardIds = useMemo(() => data?.pages.flatMap((page) => page.ids) || [], [data]);
  const items = useMemo(() => cardIds.map(cardNft2UnrevealedItem), [cardIds]);
  const nextCursor = data?.pages[data.pages.length - 1]?.nextCursor;

  useEffect(() => {
    return () => {
      clearPonchoDrifellaImageCache(imageCacheRef.current);
    };
  }, []);

  useEffect(() => {
    if (!viewer || viewer.active || viewer.closing) return undefined;
    let raf = window.requestAnimationFrame(() => {
      raf = window.requestAnimationFrame(() => {
        setViewer((current) => (current?.overlayId === viewer.overlayId ? { ...current, active: true } : current));
      });
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
      loadingImageSrc: cardNft2UnrevealedLoadingImageSrc(item.image),
      originRect: toRevealOverlayRect(resolvedOriginRect),
      targetRect,
      active: false,
      closing: false,
    });
  }, []);

  const dismissViewer = useCallback(() => {
    setViewer((current) => (current && !current.closing ? { ...current, active: false, closing: true } : current));
  }, []);

  useEffect(() => {
    autoLoadStateRef.current = {
      cardCount: cardIds.length,
      hasNextPage: Boolean(hasNextPage),
      nextCursor,
    };
  }, [cardIds.length, hasNextPage, nextCursor]);

  const autoLoadKey = useCallback(({ cardCount, nextCursor: cursor }: UnrevealedAutoLoadState) => {
    return cursor === undefined ? `count:${cardCount}` : `cursor:${cursor}`;
  }, []);

  const loadNextPage = useCallback(async () => {
    const autoLoadState = autoLoadStateRef.current;
    const key = autoLoadKey(autoLoadState);
    if (!autoLoadState.hasNextPage || nextPageRequestInFlightRef.current || blockedAutoLoadKeyRef.current === key) return;

    nextPageRequestInFlightRef.current = true;
    try {
      const result = await fetchNextPage({ cancelRefetch: false, throwOnError: true });
      blockedAutoLoadKeyRef.current = result.isError ? key : null;
    } catch {
      blockedAutoLoadKeyRef.current = key;
    } finally {
      nextPageRequestInFlightRef.current = false;
    }
  }, [autoLoadKey, fetchNextPage]);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !cardIds.length || !hasNextPage || typeof IntersectionObserver === 'undefined') return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        const isIntersecting = entries.some((entry) => entry.isIntersecting);
        if (isIntersecting) {
          void loadNextPage();
        } else {
          blockedAutoLoadKeyRef.current = null;
        }
      },
      { rootMargin: CARD_NFT_2_AUTO_LOAD_ROOT_MARGIN },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [cardIds.length, hasNextPage, loadNextPage]);

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
          cardIdLabel={viewer.closing ? undefined : String(viewer.figureId)}
          loadingImageSrc={viewer.loadingImageSrc}
          onDismiss={dismissViewer}
          onTransitionEnd={handleViewerTransitionEnd}
        />
      ) : null}
      <ShopHeader scrollHomeToTop />
      <main className="card-nft2-unrevealed-gallery" aria-label="Unrevealed cards">
        <InventoryGrid
          items={items}
          onViewItem={openCard}
          interactionMode="view-only"
          figureMediaMode="image"
          className="inventory--card-nft2-unrevealed"
          emptyStateVisibility="none"
        />
        <div ref={sentinelRef} className="card-nft2-unrevealed-sentinel" aria-hidden="true" />
      </main>
    </div>
  );
}
