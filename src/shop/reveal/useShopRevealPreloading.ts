import { useEffect } from 'react';
import { isDropFamily } from '../../config/deployment';
import type { ShopRevealController } from './useShopReveal';

export function useShopRevealPreloading(
  { routeDrop, assets, revealOverlay }: ShopRevealController,
  shouldPreloadBoxFramesInitial: boolean,
) {
  const {
    dropRevealIsAnimated, preloadBoxFrames, preloadInteractiveCardPackRevealPackAssetsForDropId,
    revealClickMaxForDropId, revealAutoplayStartForDropId, revealFrameCountForDropId,
    autoplayFramePreloadScheduledDropIdRef,
  } = assets;
  useEffect(() => {
    if (!routeDrop || !shouldPreloadBoxFramesInitial) return;
    if (!isDropFamily(routeDrop, 'card_nft_2')) {
      preloadInteractiveCardPackRevealPackAssetsForDropId(routeDrop.dropId);
    }
    if (!dropRevealIsAnimated(routeDrop.dropId)) return;
    preloadBoxFrames(1, revealClickMaxForDropId(routeDrop.dropId), routeDrop.dropId);
  }, [
    routeDrop,
    dropRevealIsAnimated,
    preloadBoxFrames,
    preloadInteractiveCardPackRevealPackAssetsForDropId,
    revealClickMaxForDropId,
    shouldPreloadBoxFramesInitial,
  ]);
  useEffect(() => {
    if (!routeDrop || !shouldPreloadBoxFramesInitial) return;
    if (!dropRevealIsAnimated(routeDrop.dropId)) return;
    if (typeof window === 'undefined') return;
    if (autoplayFramePreloadScheduledDropIdRef.current === routeDrop.dropId) return;
    autoplayFramePreloadScheduledDropIdRef.current = routeDrop.dropId;
    const run = () =>
      preloadBoxFrames(routeDrop.dropId ? revealAutoplayStartForDropId(routeDrop.dropId) : 1, revealFrameCountForDropId(routeDrop.dropId), routeDrop.dropId);
    const win = window as unknown as {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    if (typeof win.requestIdleCallback === 'function') {
      const handle = win.requestIdleCallback(run, { timeout: 1500 });
      return () => {
        if (typeof win.cancelIdleCallback === 'function') win.cancelIdleCallback(handle);
      };
    }
    const timeout = window.setTimeout(run, 750);
    return () => window.clearTimeout(timeout);
  }, [
    routeDrop,
    dropRevealIsAnimated,
    preloadBoxFrames,
    revealAutoplayStartForDropId,
    revealFrameCountForDropId,
    shouldPreloadBoxFramesInitial,
  ]);
  useEffect(() => {
    if (!revealOverlay) return;
    if (revealOverlay.viewerMode === 'receipt-image') return;
    preloadInteractiveCardPackRevealPackAssetsForDropId(revealOverlay.dropId, revealOverlay.packMediaId);
    if (!dropRevealIsAnimated(revealOverlay.dropId)) return;
    preloadBoxFrames(
      revealAutoplayStartForDropId(revealOverlay.dropId),
      revealFrameCountForDropId(revealOverlay.dropId),
      revealOverlay.dropId,
    );
  }, [
    dropRevealIsAnimated,
    preloadBoxFrames,
    preloadInteractiveCardPackRevealPackAssetsForDropId,
    revealAutoplayStartForDropId,
    revealFrameCountForDropId,
    revealOverlay,
  ]);
}
