import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import {
  figureMetadataCacheKey,
  getCachedFigureMetadata,
} from '../../lib/figureMetadata';
import { getMediaIdForFigureId } from '../../lib/figureMediaMap';
import {
  getInteractiveCardPackCardByFigureId,
  getInteractiveCardPackCardsByFigureIds,
  getInteractiveCardPackRevealFigureIds,
} from '../../lib/interactiveCardPackReveal';
import { clearCardModelUrl } from '../../lib/clearCardModels';
import { resolveRevealFrameSrc } from '../../lib/revealFrameSequence';
import {
  PONCHO_DRIFELLA_REVEAL_ROW_SLOT_COUNT,
  getRevealOverlayViewport as getOverlayViewport,
  ponchoDrifellaRevealOverlayStyleVars,
  revealOverlayStyleVars,
} from '../../lib/revealOverlayLayout';
import type { ShopRevealOptions } from './contracts';
import type { RevealOverlayState } from './types';
import type { RevealAssets } from './useRevealAssets';

export function useRevealPresentation({ options, assets, revealOverlay }: {
  options: ShopRevealOptions;
  assets: RevealAssets;
  revealOverlay: RevealOverlayState | null;
}) {
  const {
    getDropContent, routeDrop, boxLabelForDropId, figureLabelForDropId,
    figureMetadataByKey, figureReferenceForDropId, requireKnownDropConfig, queueFigureMetadataFetch,
  } = options;
  const {
    usesInteractiveCardPackRevealForDropId, usesClearCard3dRevealForDropId,
    revealMediaStartForDropId, playRevealSoundForDropId, preloadRevealVideos,
    boxImageForDropId, revealFrameSequenceForDropId, revealMediaBaseForDropId,
  } = assets;
  const revealFrameSequence = revealFrameSequenceForDropId(revealOverlay?.dropId || routeDrop?.dropId);
  const revealMediaBase = revealMediaBaseForDropId(revealOverlay?.dropId || routeDrop?.dropId);
  const revealOverlayUsesPonchoViewer = revealOverlay?.viewerMode === 'poncho-card';
  const revealOverlayClearCardViewerMode: 'card' | 'pack' | undefined =
    revealOverlay?.viewerMode === 'clear-card'
      ? 'card'
      : revealOverlay?.viewerMode === 'clear-pack'
        ? 'pack'
        : undefined;
  const revealOverlayUsesClearCardViewer = Boolean(revealOverlayClearCardViewerMode);
  const revealOverlayUsesReceiptImage = revealOverlay?.viewerMode === 'receipt-image';
  const revealOverlayHasInteractiveCardPackRenderer = Boolean(
    revealOverlay &&
      !revealOverlayUsesPonchoViewer &&
      !revealOverlayUsesReceiptImage &&
      usesInteractiveCardPackRevealForDropId(revealOverlay.dropId),
  );
  const revealOverlayHasClearCard3dRenderer = Boolean(
    revealOverlay &&
      !revealOverlayUsesPonchoViewer &&
      !revealOverlayUsesReceiptImage &&
      usesClearCard3dRevealForDropId(revealOverlay.dropId),
  );
  const revealOverlayUsesPonchoLayout = Boolean(
    revealOverlayUsesPonchoViewer || revealOverlayHasInteractiveCardPackRenderer,
  );
  const revealOverlayContent = useMemo(
    () => getDropContent(revealOverlay?.dropId || routeDrop?.dropId),
    [getDropContent, revealOverlay?.dropId, routeDrop?.dropId],
  );
  const revealOverlayContainerLabel = revealOverlay
    ? boxLabelForDropId(revealOverlay.dropId)
    : boxLabelForDropId(routeDrop?.dropId);
  const interactiveViewerCard = useMemo(() => {
    if (revealOverlay?.viewerMode !== 'poncho-card' || typeof revealOverlay.viewerFigureId !== 'number') return undefined;
    return getInteractiveCardPackCardByFigureId(revealOverlay.dropId, revealOverlay.viewerFigureId);
  }, [revealOverlay?.dropId, revealOverlay?.viewerFigureId, revealOverlay?.viewerMode]);
  const interactiveRevealCards = useMemo(() => {
    if (!revealOverlayHasInteractiveCardPackRenderer || !revealOverlay?.revealedIds?.length) return [];
    const figureIds = getInteractiveCardPackRevealFigureIds(
      revealOverlay.dropId,
      revealOverlay.revealedIds,
      revealOverlay.interactiveRevealCardId,
    );
    return getInteractiveCardPackCardsByFigureIds(revealOverlay.dropId, figureIds);
  }, [revealOverlay?.dropId, revealOverlay?.interactiveRevealCardId, revealOverlay?.revealedIds, revealOverlayHasInteractiveCardPackRenderer]);
  const clearCardRevealId = useMemo(() => {
    if (!revealOverlayHasClearCard3dRenderer || revealOverlay?.revealedIds?.length !== 1) return undefined;
    const figureId = revealOverlay.revealedIds[0];
    return clearCardModelUrl(figureId) ? figureId : undefined;
  }, [revealOverlay?.revealedIds, revealOverlayHasClearCard3dRenderer]);
  const revealOverlayStyle: CSSProperties | undefined = revealOverlay
    ? (revealOverlayUsesPonchoLayout
        ? ponchoDrifellaRevealOverlayStyleVars({
            originRect: revealOverlay.originRect,
            targetRect: revealOverlay.targetRect,
            mode: revealOverlay.viewerMode === 'poncho-card' ? 'poncho-card' : 'default',
            viewport: getOverlayViewport(),
            cardCount: interactiveRevealCards.length || PONCHO_DRIFELLA_REVEAL_ROW_SLOT_COUNT,
          })
        : revealOverlayStyleVars({
            originRect: revealOverlay.originRect,
            targetRect: revealOverlay.targetRect,
            mode: revealOverlay.viewerMode === 'poncho-card' ? 'poncho-card' : 'default',
          })) as CSSProperties
    : undefined;
  const revealOverlayCanRenderInteractiveCardPack = Boolean(
    revealOverlayHasInteractiveCardPackRenderer &&
      (!revealOverlay?.revealedIds?.length || interactiveRevealCards.length > 0),
  );
  const revealOverlayCanRenderClearCard3d = revealOverlayHasClearCard3dRenderer;
  const showRevealOutcome = Boolean(
    revealOverlay &&
      revealOverlay.revealedIds?.length &&
      (revealOverlayContent.reveal.mode === 'static' || revealOverlay.frame >= revealMediaStartForDropId(revealOverlay.dropId)),
  );
  const revealOverlayStage = revealOverlay
    ? revealOverlay.phase === 'preparing'
      ? 'preparing'
      : showRevealOutcome
        ? 'revealed'
        : 'ready'
    : 'ready';
  const revealMediaItems = useMemo<Array<{ figureId: number; index: number; mediaId?: number; image?: string; name: string }>>(() => {
    if (
      revealOverlayCanRenderInteractiveCardPack ||
      revealOverlayCanRenderClearCard3d ||
      !revealOverlay?.revealedIds?.length
    ) {
      return [];
    }
    const revealDrop = requireKnownDropConfig(revealOverlay.dropId, 'reveal overlay');
    if (revealOverlayContent.figures.revealPresentation === 'videos') {
      return revealOverlay.revealedIds.map((figureId, index) => {
        const cacheKey = figureMetadataCacheKey(revealOverlay.dropId, figureId);
        const meta = figureMetadataByKey[cacheKey] || getCachedFigureMetadata(revealOverlay.dropId, figureId);
        return {
          figureId,
          index,
          mediaId: getMediaIdForFigureId(figureId, revealDrop.figureMedia),
          image: meta?.image,
          name: meta?.name || figureReferenceForDropId(revealOverlay.dropId, figureId),
        };
      });
    }
    return revealOverlay.revealedIds.map((figureId, index) => {
      const cacheKey = figureMetadataCacheKey(revealOverlay.dropId, figureId);
      const meta = figureMetadataByKey[cacheKey] || getCachedFigureMetadata(revealOverlay.dropId, figureId);
      return {
        figureId,
        index,
        image: meta?.image,
        name: meta?.name || figureReferenceForDropId(revealOverlay.dropId, figureId),
      };
    });
  }, [
    figureMetadataByKey,
    figureReferenceForDropId,
    requireKnownDropConfig,
    revealOverlay?.dropId,
    revealOverlay?.revealedIds,
    revealOverlayContent.figures.revealPresentation,
    revealOverlayCanRenderInteractiveCardPack,
    revealOverlayCanRenderClearCard3d,
  ]);
  const revealMediaIds = useMemo(
    () =>
      Array.from(
        new Set(
          revealMediaItems
            .map((entry) => entry.mediaId)
            .filter((mediaId): mediaId is number => Boolean(mediaId)),
        ),
      ),
    [revealMediaItems],
  );

  const revealSoundPlayedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!revealOverlay) {
      revealSoundPlayedRef.current = null;
      return;
    }
    if (revealOverlayCanRenderInteractiveCardPack || revealOverlayCanRenderClearCard3d) return;
    if (!showRevealOutcome) return;
    if (revealSoundPlayedRef.current === revealOverlay.id) return;
    revealSoundPlayedRef.current = revealOverlay.id;
    playRevealSoundForDropId(revealOverlay.dropId);
  }, [playRevealSoundForDropId, revealOverlay, revealOverlayCanRenderClearCard3d, revealOverlayCanRenderInteractiveCardPack, showRevealOutcome]);

  useEffect(() => {
    if (revealOverlayCanRenderInteractiveCardPack || revealOverlayCanRenderClearCard3d) return;
    if (!revealOverlay?.revealedIds?.length) return;
    queueFigureMetadataFetch(revealOverlay.revealedIds.map((figureId) => ({ dropId: revealOverlay.dropId, figureId })));
  }, [queueFigureMetadataFetch, revealOverlay?.dropId, revealOverlay?.revealedIds, revealOverlayCanRenderClearCard3d, revealOverlayCanRenderInteractiveCardPack]);

  const revealMediaStyle = useMemo(() => {
    if (!revealOverlay || !revealMediaItems.length) return undefined;
    const width = revealOverlay.targetRect.width;
    const height = revealOverlay.targetRect.height;
    const base = Math.min(width, height);
    const baseSize = Math.floor(Math.min(base * 0.7, 220));
    const widthCap = width < 240 ? 0.42 : width < 320 ? 0.48 : width < 420 ? 0.52 : 0.6;
    const maxByWidth = Math.floor(width * widthCap);
    const maxByHeight = Math.floor(height * 0.9);
    const maxSize = Math.floor(Math.min(baseSize * 1.4, maxByWidth, maxByHeight));
    const count = revealMediaItems.length;
    const densityScale = count <= 3 ? 0.8 : count <= 5 ? 0.68 : count <= 8 ? 0.56 : 0.48;
    const size = Math.max(48, Math.floor(maxSize * densityScale));
    const shiftY = Math.floor(size * 0.1);
    return {
      ['--reveal-media-size' as never]: `${size}px`,
      ['--reveal-media-shift-y' as never]: `${shiftY}px`,
    };
  }, [revealOverlay, revealMediaItems.length]);
  useEffect(() => {
    if (!revealMediaIds.length) return;
    if (revealOverlayContent.figures.revealPresentation !== 'videos') return;
    preloadRevealVideos(revealMediaIds, revealOverlay?.dropId || routeDrop?.dropId);
  }, [preloadRevealVideos, revealMediaIds, revealOverlay?.dropId, revealOverlayContent.figures.revealPresentation, routeDrop?.dropId]);
  const animatedRevealFrameSrc =
    revealOverlay && revealOverlay.frame && revealOverlayContent.reveal.mode === 'animated' && revealFrameSequence
      ? resolveRevealFrameSrc(revealFrameSequence, revealOverlay.frame)
      : undefined;
  const revealBoxFrameSrc =
    revealOverlay && !revealOverlayCanRenderInteractiveCardPack && revealOverlay.frame
      ? animatedRevealFrameSrc || revealOverlay.image || boxImageForDropId(revealOverlay.dropId)
      : undefined;

  return {
    revealOverlayUsesPonchoViewer,
    revealOverlayClearCardViewerMode,
    revealOverlayUsesClearCardViewer,
    revealOverlayUsesReceiptImage,
    revealOverlayContent,
    revealOverlayContainerLabel,
    cardLabel: revealOverlay ? `Revealed ${figureLabelForDropId(revealOverlay.dropId, 1)}` : '',
    interactiveViewerCard,
    interactiveRevealCards,
    clearCardRevealId,
    revealOverlayStyle,
    revealOverlayCanRenderInteractiveCardPack,
    revealOverlayCanRenderClearCard3d,
    showRevealOutcome,
    revealOverlayStage,
    revealMediaItems,
    revealMediaStyle,
    revealBoxFrameSrc,
    revealMediaBase,
  };
}
