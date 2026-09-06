import { useCallback, useRef } from 'react';
import { isDropFamily } from '../../config/deployment';
import {
  usesAssetGatedRevealFlow,
  usesClearCard3dRevealFlow,
  usesInteractiveCardPackRevealFlow,
} from '../../config/dropsExtraContent';
import { joinDropAssetUrl, resolveBoxMediaIdForDrop } from '../../lib/dropContent';
import { soundPlayer } from '../../lib/SoundPlayer';
import {
  clearPonchoDrifellaImageCache,
  createPonchoDrifellaImageCache,
  preloadPonchoDrifellaCardAssets,
  preloadPonchoDrifellaPackAssets,
} from '../../lib/ponchoDrifellaReveal';
import {
  getInteractiveCardPackCardsByFigureIds,
  getInteractiveCardPackRevealSequenceForDropId,
  normalizeInteractiveCardPackMediaId,
} from '../../lib/interactiveCardPackReveal';
import { interactiveCardPackRevealSoundUrlsForDropId } from '../../lib/interactiveCardPackRevealSounds';
import { preloadRevealFrames } from '../../lib/revealFrameSequence';
import { DEFAULT_BOX_SOUND_CLICK_URL, DEFAULT_BOX_SOUND_REVEAL_URL, pickRandomSoundUrl } from './sounds';
import type { RevealDropContext } from './contracts';

export function useRevealAssets({ getDropConfig, getDropContent }: Pick<RevealDropContext, 'getDropConfig' | 'getDropContent'>) {
  const preloadedBoxFramesRef = useRef<Set<string>>(new Set());
  const boxFramePreloadImagesRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const ponchoImageCacheRef = useRef(createPonchoDrifellaImageCache());
  const preloadedInteractivePackKeysRef = useRef<Set<string>>(new Set());
  const autoplayFramePreloadScheduledDropIdRef = useRef<string | null>(null);
  const soundInitPromiseRef = useRef<Promise<void> | null>(null);
  const videoPreloadRootRef = useRef<HTMLDivElement | null>(null);
  const videoPreloadKeyRef = useRef<string>('');
  const dropRevealIsAnimated = useCallback(
    (dropId?: string) => {
      const content = getDropContent(dropId);
      return content.reveal.mode === 'animated' && Boolean(content.reveal.frameTiming);
    },
    [getDropContent],
  );
  const revealFrameCountForDropId = useCallback(
    (dropId?: string) => getDropContent(dropId).reveal.frameTiming?.frameCount || 1,
    [getDropContent],
  );
  const revealClickMaxForDropId = useCallback(
    (dropId?: string) => getDropContent(dropId).reveal.frameTiming?.clickMax || 1,
    [getDropContent],
  );
  const revealAutoplayStartForDropId = useCallback(
    (dropId?: string) => getDropContent(dropId).reveal.frameTiming?.autoplayStart || 1,
    [getDropContent],
  );
  const revealMediaStartForDropId = useCallback(
    (dropId?: string) => getDropContent(dropId).reveal.frameTiming?.mediaStart || 1,
    [getDropContent],
  );
  const revealRendererForDropId = useCallback(
    (dropId?: string) => getDropContent(dropId).reveal.renderer,
    [getDropContent],
  );
  const usesInteractiveCardPackRevealForDropId = useCallback(
    (dropId?: string) => usesInteractiveCardPackRevealFlow(revealRendererForDropId(dropId)),
    [revealRendererForDropId],
  );
  const usesClearCard3dRevealForDropId = useCallback(
    (dropId?: string) => usesClearCard3dRevealFlow(revealRendererForDropId(dropId)),
    [revealRendererForDropId],
  );
  const usesAssetGatedRevealForDropId = useCallback(
    (dropId?: string) => usesAssetGatedRevealFlow(revealRendererForDropId(dropId)),
    [revealRendererForDropId],
  );
  const resolveInteractiveCardPackMediaIdForBox = useCallback(
    (dropId?: string, boxId?: string | number) => {
      if (!usesInteractiveCardPackRevealForDropId(dropId)) return undefined;
      const dropConfig = getDropConfig(dropId);
      return resolveBoxMediaIdForDrop(dropConfig || dropId, boxId) || undefined;
    },
    [getDropConfig, usesInteractiveCardPackRevealForDropId],
  );
  const revealSoundUrlsForDropId = useCallback(
    (dropId?: string) => {
      const { sound } = getDropContent(dropId).reveal;
      if (
        usesInteractiveCardPackRevealForDropId(dropId) ||
        usesClearCard3dRevealForDropId(dropId)
      ) {
        const { click, reveal, cardSwipe, cardSpread } = interactiveCardPackRevealSoundUrlsForDropId(dropId);
        return {
          click,
          reveal,
          cardSwipe,
          cardSpread,
          clickVolume: sound.clickVolume,
          revealVolume: sound.revealVolume,
        };
      }
      return {
        click: [DEFAULT_BOX_SOUND_CLICK_URL],
        reveal: DEFAULT_BOX_SOUND_REVEAL_URL,
        clickVolume: sound.clickVolume,
        revealVolume: sound.revealVolume,
      };
    },
    [getDropContent, usesClearCard3dRevealForDropId, usesInteractiveCardPackRevealForDropId],
  );
  const preloadInteractiveCardPackRevealCardAssetsForDropId = useCallback(
    (dropId?: string, figureIds?: readonly number[]) => {
      if (!usesInteractiveCardPackRevealForDropId(dropId)) return;
      if (!figureIds?.length) return;
      getInteractiveCardPackCardsByFigureIds(dropId, figureIds).forEach((card) => {
        preloadPonchoDrifellaCardAssets(card, ponchoImageCacheRef.current, { mode: 'warm', priority: 'low' });
      });
    },
    [usesInteractiveCardPackRevealForDropId],
  );
  const preloadInteractiveCardPackRevealPackAssetsForDropId = useCallback(
    (dropId?: string, packMediaId?: number) => {
      if (!usesInteractiveCardPackRevealForDropId(dropId)) return;
      const dropConfig = getDropConfig(dropId);
      const sequencePackMediaId = normalizeInteractiveCardPackMediaId(packMediaId);
      if (isDropFamily(dropConfig, 'card_nft_2') && sequencePackMediaId === undefined) return;
      const preloadKey = `${dropConfig?.dropId || dropId || 'current'}:${sequencePackMediaId ?? 'default'}`;
      if (preloadedInteractivePackKeysRef.current.has(preloadKey)) return;
      preloadedInteractivePackKeysRef.current.add(preloadKey);
      preloadPonchoDrifellaPackAssets(
        ponchoImageCacheRef.current,
        { mode: 'warm', priority: 'low' },
        getInteractiveCardPackRevealSequenceForDropId(dropId, sequencePackMediaId),
      );
    },
    [getDropConfig, usesInteractiveCardPackRevealForDropId],
  );
  const boxImageForDropId = useCallback(
    (dropId?: string): string | undefined => {
      const content = getDropContent(dropId);
      return content.box.previewImageUrl;
    },
    [getDropContent],
  );
  const boxAspectRatioForDropId = useCallback(
    (dropId?: string): number => {
      const content = getDropContent(dropId);
      return content.box.aspectRatio;
    },
    [getDropContent],
  );
  const revealFrameSequenceForDropId = useCallback(
    (dropId?: string) => {
      const content = getDropContent(dropId);
      return content.reveal.frameSequence;
    },
    [getDropContent],
  );
  const revealMediaBaseForDropId = useCallback(
    (dropId?: string): string | undefined => {
      const content = getDropContent(dropId);
      return content.figures.revealVideoBaseUrl;
    },
    [getDropContent],
  );
  const preloadBoxFrames = useCallback(
    (fromFrame = 1, toFrame?: number, dropId?: string) => {
      if (typeof window === 'undefined') return;
      if (usesInteractiveCardPackRevealForDropId(dropId)) return;
      preloadRevealFrames(
        revealFrameSequenceForDropId(dropId),
        preloadedBoxFramesRef.current,
        boxFramePreloadImagesRef.current,
        fromFrame,
        toFrame,
      );
    },
    [revealFrameSequenceForDropId, usesInteractiveCardPackRevealForDropId],
  );

  const ensureVideoPreloadRoot = useCallback(() => {
    if (typeof document === 'undefined') return null;
    if (videoPreloadRootRef.current) return videoPreloadRootRef.current;
    const root = document.createElement('div');
    root.setAttribute('data-reveal-video-preload', 'true');
    root.style.position = 'absolute';
    root.style.width = '0px';
    root.style.height = '0px';
    root.style.overflow = 'hidden';
    root.style.opacity = '0';
    root.style.pointerEvents = 'none';
    document.body.appendChild(root);
    videoPreloadRootRef.current = root;
    return root;
  }, []);

  const preloadRevealVideos = useCallback(
    (mediaIds: number[], dropId?: string) => {
      if (typeof document === 'undefined') return;
      const revealMediaBase = revealMediaBaseForDropId(dropId);
      if (!revealMediaBase) return;
      const root = ensureVideoPreloadRoot();
      if (!root) return;
      const ids = Array.from(new Set(mediaIds.filter((mediaId) => Number.isFinite(mediaId) && mediaId > 0)));
      if (!ids.length) return;
      const key = `${revealMediaBase}|${ids.join(',')}`;
      if (videoPreloadKeyRef.current === key) return;
      videoPreloadKeyRef.current = key;
      while (root.firstChild) {
        root.removeChild(root.firstChild);
      }
      ids.forEach((mediaId) => {
        const movSrc = joinDropAssetUrl(revealMediaBase, `${mediaId}.mov`);
        const webmSrc = joinDropAssetUrl(revealMediaBase, `${mediaId}.webm`);
        if (!movSrc || !webmSrc) return;
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.setAttribute('aria-hidden', 'true');
        const sourceMov = document.createElement('source');
        sourceMov.src = movSrc;
        sourceMov.type = 'video/quicktime; codecs="hvc1"';
        const sourceWebm = document.createElement('source');
        sourceWebm.src = webmSrc;
        sourceWebm.type = 'video/webm';
        video.appendChild(sourceMov);
        video.appendChild(sourceWebm);
        root.appendChild(video);
        video.load();
      });
    },
    [ensureVideoPreloadRoot, revealMediaBaseForDropId],
  );

  const ensureSoundReady = useCallback(() => {
    if (soundPlayer.isInitialized) return Promise.resolve();
    if (soundInitPromiseRef.current) return soundInitPromiseRef.current;
    const promise = soundPlayer.initializeOnUserInteraction(true);
    soundInitPromiseRef.current = promise.finally(() => {
      if (soundInitPromiseRef.current === promise) {
        soundInitPromiseRef.current = null;
      }
    });
    return soundInitPromiseRef.current;
  }, []);

  const preloadRevealSounds = useCallback((dropId?: string) => {
    const { click, reveal, cardSwipe, cardSpread } = revealSoundUrlsForDropId(dropId);
    const motionSounds = [cardSwipe, cardSpread].filter((soundUrl): soundUrl is string => Boolean(soundUrl));
    void soundPlayer.preloadSound(reveal);
    click.forEach((clickUrl) => {
      void soundPlayer.preloadSound(clickUrl);
    });
    motionSounds.forEach((motionUrl) => {
      void soundPlayer.preloadSound(motionUrl);
    });
    void ensureSoundReady().then(() => {
      void soundPlayer.preloadSound(reveal);
      click.forEach((clickUrl) => {
        void soundPlayer.preloadSound(clickUrl);
      });
      motionSounds.forEach((motionUrl) => {
        void soundPlayer.preloadSound(motionUrl);
      });
    });
  }, [ensureSoundReady, revealSoundUrlsForDropId]);
  const preloadCardMotionSoundsForDropId = useCallback(
    (dropId?: string) => {
      const { cardSwipe, cardSpread } = revealSoundUrlsForDropId(dropId);
      [cardSwipe, cardSpread].forEach((motionUrl) => {
        if (motionUrl) {
          void soundPlayer.preloadSound(motionUrl);
        }
      });
    },
    [revealSoundUrlsForDropId],
  );
  const scheduleCardMotionSoundPreloadForDropId = useCallback(
    (dropId?: string) => {
      if (typeof window === 'undefined') {
        preloadCardMotionSoundsForDropId(dropId);
        return;
      }
      window.setTimeout(() => {
        preloadCardMotionSoundsForDropId(dropId);
      }, 0);
    },
    [preloadCardMotionSoundsForDropId],
  );
  const playCardMotionSoundForDropId = useCallback(
    (dropId: string | undefined, soundKey: 'cardSwipe' | 'cardSpread') => {
      const soundUrls = revealSoundUrlsForDropId(dropId);
      const motionUrl = soundUrls[soundKey];
      if (!motionUrl) return;
      const play = () => {
        void soundPlayer.playSound(motionUrl, soundUrls.clickVolume);
      };
      if (soundPlayer.isInitialized) {
        play();
        return;
      }
      const pending = soundInitPromiseRef.current;
      if (pending) {
        void pending.then(play);
        return;
      }
      void ensureSoundReady().then(play);
    },
    [ensureSoundReady, revealSoundUrlsForDropId],
  );
  const playRevealSoundForDropId = useCallback(
    (dropId?: string) => {
      const { reveal, revealVolume } = revealSoundUrlsForDropId(dropId);
      const play = () => {
        void soundPlayer.playSound(reveal, revealVolume);
      };
      if (soundPlayer.isInitialized) {
        play();
        return;
      }
      const pending = soundInitPromiseRef.current;
      if (pending) {
        void pending.then(play);
      }
    },
    [revealSoundUrlsForDropId],
  );
  const playClickSoundForDropId = useCallback(
    (dropId?: string) => {
      const { click, clickVolume } = revealSoundUrlsForDropId(dropId);
      const clickUrl = pickRandomSoundUrl(click);
      void ensureSoundReady().then(() => {
        void soundPlayer.playSound(clickUrl, clickVolume);
        scheduleCardMotionSoundPreloadForDropId(dropId);
      });
    },
    [ensureSoundReady, revealSoundUrlsForDropId, scheduleCardMotionSoundPreloadForDropId],
  );

  const preloadRevealAssetsForPackMedia = useCallback(
    (dropId?: string, packMediaId?: number) => {
      preloadRevealSounds(dropId);
      if (usesAssetGatedRevealForDropId(dropId)) {
        if (usesInteractiveCardPackRevealForDropId(dropId)) {
          preloadInteractiveCardPackRevealPackAssetsForDropId(dropId, packMediaId);
        }
        return;
      }
      preloadBoxFrames(1, revealClickMaxForDropId(dropId), dropId);
      preloadBoxFrames(revealAutoplayStartForDropId(dropId), revealFrameCountForDropId(dropId), dropId);
    },
    [
      preloadBoxFrames,
      preloadInteractiveCardPackRevealPackAssetsForDropId,
      preloadRevealSounds,
      revealAutoplayStartForDropId,
      revealClickMaxForDropId,
      revealFrameCountForDropId,
      usesAssetGatedRevealForDropId,
      usesInteractiveCardPackRevealForDropId,
    ],
  );

  const clearRevealVideos = useCallback(() => {
    videoPreloadKeyRef.current = '';
    if (videoPreloadRootRef.current) {
      while (videoPreloadRootRef.current.firstChild) {
        videoPreloadRootRef.current.removeChild(videoPreloadRootRef.current.firstChild);
      }
    }
  }, []);

  const resetRevealAssets = useCallback(() => {
    preloadedBoxFramesRef.current.clear();
    boxFramePreloadImagesRef.current.clear();
    preloadedInteractivePackKeysRef.current.clear();
    clearPonchoDrifellaImageCache(ponchoImageCacheRef.current);
    autoplayFramePreloadScheduledDropIdRef.current = null;
    videoPreloadKeyRef.current = '';
    if (videoPreloadRootRef.current) {
      videoPreloadRootRef.current.remove();
      videoPreloadRootRef.current = null;
    }
  }, []);

  return {
    dropRevealIsAnimated,
    revealFrameCountForDropId,
    revealClickMaxForDropId,
    revealAutoplayStartForDropId,
    revealMediaStartForDropId,
    revealRendererForDropId,
    usesInteractiveCardPackRevealForDropId,
    usesClearCard3dRevealForDropId,
    usesAssetGatedRevealForDropId,
    resolveInteractiveCardPackMediaIdForBox,
    revealSoundUrlsForDropId,
    boxImageForDropId,
    boxAspectRatioForDropId,
    revealFrameSequenceForDropId,
    revealMediaBaseForDropId,
    preloadBoxFrames,
    preloadRevealVideos,
    preloadInteractiveCardPackRevealCardAssetsForDropId,
    preloadInteractiveCardPackRevealPackAssetsForDropId,
    preloadRevealAssetsForPackMedia,
    ensureSoundReady,
    playClickSoundForDropId,
    playRevealSoundForDropId,
    playCardMotionSoundForDropId,
    clearRevealVideos,
    resetRevealAssets,
    ponchoImageCacheRef,
    autoplayFramePreloadScheduledDropIdRef,
  };
}

export type RevealAssets = ReturnType<typeof useRevealAssets>;
