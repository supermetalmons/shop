import { useEffect, useState } from 'react';
import type { DrifCardConfig } from '../drifCards';
import { getDogeDay2026CardAssetSources } from './starterCards';
import {
  DOGE_DAY_2026_PACK_REVEAL_SEQUENCE,
  type DogeDay2026RevealSequence,
} from './revealSequence';
const DOGE_DAY_2026_PUNCH_FRAME_DURATION_MS = 100;
const DOGE_DAY_2026_SEQUENCE_AUTOPLAY_DELAY_MS = 50;
export const DOGE_DAY_2026_PACK_DISCARD_DELAY_MS = 420;
export const DOGE_DAY_2026_PACK_DISCARD_DURATION_MS = 380;
const DOGE_DAY_2026_CARD_INTERACTION_UNLOCK_DELAY_MS =
  DOGE_DAY_2026_PACK_DISCARD_DELAY_MS + DOGE_DAY_2026_PACK_DISCARD_DURATION_MS;
const DOGE_DAY_2026_ASSET_RETRY_DELAY_MS = 180;
const DOGE_DAY_2026_BACKGROUND_PRELOAD_PAUSE_MS = 48;
const DOGE_DAY_2026_CARD_IMAGE_SETTLE_DELAY_MS = 96;
const DOGE_DAY_2026_IMAGE_LOAD_TIMEOUT_BASE_MS = 12_000;
const DOGE_DAY_2026_IMAGE_LOAD_TIMEOUT_MAX_MS = 60_000;

type DogeDay2026ImagePreloadMode = 'warm' | 'resident';
type DogeDay2026ImagePreloadPriority = 'high' | 'low';

export type DogeDay2026ImageCache = {
  fetched: Set<string>;
  pending: Map<string, Promise<void>>;
  resident: Map<string, HTMLImageElement>;
};

type DogeDay2026ImagePreloadOptions = {
  mode?: DogeDay2026ImagePreloadMode;
  priority?: DogeDay2026ImagePreloadPriority;
};

const DOGE_DAY_2026_WARM_PRELOAD_OPTIONS = {
  mode: 'warm',
  priority: 'low',
} as const satisfies DogeDay2026ImagePreloadOptions;

const DOGE_DAY_2026_RESIDENT_PRELOAD_OPTIONS = {
  mode: 'resident',
  priority: 'high',
} as const satisfies DogeDay2026ImagePreloadOptions;

type WaitForDogeDay2026AssetsUntilReadyOptions = DogeDay2026ImagePreloadOptions & {
  signal?: AbortSignal;
  retryDelayMs?: number;
};

type WaitForDogeDay2026ResidentImageSourcesProgressivelyOptions = {
  signal?: AbortSignal;
  retryDelayMs?: number;
  priority?: DogeDay2026ImagePreloadPriority;
  shouldPause?: () => boolean;
  pauseDelayMs?: number;
};

export type DogeDay2026RevealPhase = 'preparing' | 'ready' | 'revealed';
export type DogeDay2026RevealRequestStatus = 'resolved' | 'retry';

type DogeDay2026RevealStage =
  | 'idle'
  | 'punch'
  | 'segment_1_1'
  | 'segment_1_1_hold'
  | 'segment_1_2'
  | 'segment_1_2_hold'
  | 'autoplay'
  | 'revealed';

const dogeImageCacheGeneration = new WeakMap<DogeDay2026ImageCache, number>();
const dogeImageCacheInvalidationListeners = new WeakMap<DogeDay2026ImageCache, Set<() => void>>();
const dogePendingImageElements = new WeakMap<DogeDay2026ImageCache, Map<string, HTMLImageElement>>();
const dogeImageLoadFailureCounts = new WeakMap<DogeDay2026ImageCache, Map<string, number>>();

function getDogeDay2026PendingElements(cache: DogeDay2026ImageCache) {
  let pending = dogePendingImageElements.get(cache);
  if (!pending) {
    pending = new Map<string, HTMLImageElement>();
    dogePendingImageElements.set(cache, pending);
  }
  return pending;
}

function getDogeDay2026ImageLoadFailureCounts(cache: DogeDay2026ImageCache) {
  let failureCounts = dogeImageLoadFailureCounts.get(cache);
  if (!failureCounts) {
    failureCounts = new Map<string, number>();
    dogeImageLoadFailureCounts.set(cache, failureCounts);
  }
  return failureCounts;
}

function recordDogeDay2026ImageLoadFailure(imageCache: DogeDay2026ImageCache, imageSrc: string) {
  const failureCounts = getDogeDay2026ImageLoadFailureCounts(imageCache);
  failureCounts.set(imageSrc, (failureCounts.get(imageSrc) ?? 0) + 1);
}

function clearDogeDay2026ImageLoadFailures(imageCache: DogeDay2026ImageCache, imageSrc: string) {
  const failureCounts = getDogeDay2026ImageLoadFailureCounts(imageCache);
  failureCounts.delete(imageSrc);
}

function dogeDay2026ImageLoadTimeoutMs(imageCache: DogeDay2026ImageCache, imageSrc: string) {
  const failureCounts = getDogeDay2026ImageLoadFailureCounts(imageCache);
  const failureCount = failureCounts.get(imageSrc) ?? 0;
  return Math.min(DOGE_DAY_2026_IMAGE_LOAD_TIMEOUT_BASE_MS * 2 ** failureCount, DOGE_DAY_2026_IMAGE_LOAD_TIMEOUT_MAX_MS);
}

function getDogeDay2026ImageCacheInvalidationListeners(cache: DogeDay2026ImageCache) {
  let listeners = dogeImageCacheInvalidationListeners.get(cache);
  if (!listeners) {
    listeners = new Set<() => void>();
    dogeImageCacheInvalidationListeners.set(cache, listeners);
  }
  return listeners;
}

function getDogeDay2026CacheGeneration(cache: DogeDay2026ImageCache) {
  return dogeImageCacheGeneration.get(cache) ?? 0;
}

function setDogeDay2026CacheGeneration(cache: DogeDay2026ImageCache, generation: number) {
  dogeImageCacheGeneration.set(cache, generation);
}

function notifyDogeDay2026ImageCacheInvalidated(cache: DogeDay2026ImageCache) {
  getDogeDay2026ImageCacheInvalidationListeners(cache).forEach((listener) => {
    listener();
  });
}

export function useDogeDay2026ImageCacheGeneration(imageCache?: DogeDay2026ImageCache) {
  const [generation, setGeneration] = useState(() => (imageCache ? getDogeDay2026CacheGeneration(imageCache) : 0));

  useEffect(() => {
    if (!imageCache) {
      setGeneration(0);
      return undefined;
    }

    setGeneration(getDogeDay2026CacheGeneration(imageCache));
    const listeners = getDogeDay2026ImageCacheInvalidationListeners(imageCache);
    const handleInvalidation = () => {
      setGeneration(getDogeDay2026CacheGeneration(imageCache));
    };

    listeners.add(handleInvalidation);
    return () => {
      listeners.delete(handleInvalidation);
    };
  }, [imageCache]);

  return generation;
}

function normalizeDogeDay2026ImageSrc(imageSrc: string | undefined) {
  return String(imageSrc || '').trim();
}

function updateDogeDay2026FetchPriority(
  image: HTMLImageElement | undefined,
  priority: DogeDay2026ImagePreloadPriority,
) {
  if (!image) return;
  if (priority === 'high') {
    image.fetchPriority = 'high';
    return;
  }
  if (!image.fetchPriority) {
    image.fetchPriority = 'low';
  }
}

async function decodeDogeDay2026Image(image: HTMLImageElement) {
  if (typeof image.decode !== 'function') return image;
  try {
    await image.decode();
  } catch {
    if (!image.complete || image.naturalWidth <= 0) {
      throw new Error('Failed to decode image');
    }
  }
  return image;
}

function dogeDay2026ImageResidentReady(
  imageSrc: string | undefined,
  imageCache?: DogeDay2026ImageCache,
) {
  const normalizedImageSrc = normalizeDogeDay2026ImageSrc(imageSrc);
  if (!normalizedImageSrc) return true;
  if (!imageCache) return false;
  return imageCache.fetched.has(normalizedImageSrc) && !imageCache.pending.has(normalizedImageSrc) && imageCache.resident.has(normalizedImageSrc);
}

function areDogeDay2026ImageSourcesResidentReady(
  imageSources: readonly string[],
  imageCache?: DogeDay2026ImageCache,
) {
  if (!imageCache) return false;
  return imageSources.every((imageSrc) => dogeDay2026ImageResidentReady(imageSrc, imageCache));
}

function dogeDay2026OpeningSequenceResidentReady(
  imageCache: DogeDay2026ImageCache | undefined,
  packSequence: DogeDay2026RevealSequence,
) {
  return !imageCache || areDogeDay2026ImageSourcesResidentReady(packSequence.openingResidentFrameUrls, imageCache);
}

function dogeDay2026CurrentBoxFrameSrc(
  stage: DogeDay2026RevealStage,
  stageFrameIndex: number,
  activePunchFrameUrls: readonly string[],
  packSequence: DogeDay2026RevealSequence,
) {
  if (stage === 'punch') {
    return activePunchFrameUrls[Math.min(stageFrameIndex, activePunchFrameUrls.length - 1)] || packSequence.initialFrameUrl;
  }
  if (stage === 'segment_1_1' || stage === 'segment_1_1_hold') {
    return packSequence.segment11FrameUrls[Math.min(stageFrameIndex, packSequence.segment11FrameUrls.length - 1)]!;
  }
  if (stage === 'segment_1_2' || stage === 'segment_1_2_hold') {
    return packSequence.segment12FrameUrls[Math.min(stageFrameIndex, packSequence.segment12FrameUrls.length - 1)]!;
  }
  if (stage === 'autoplay' || stage === 'revealed') {
    return packSequence.segmentAutoplayFrameUrls[
      Math.min(stageFrameIndex, packSequence.segmentAutoplayFrameUrls.length - 1)
    ]!;
  }
  return packSequence.initialFrameUrl;
}

function dogeDay2026CurrentForegroundFrameSrc(
  stage: DogeDay2026RevealStage,
  stageFrameIndex: number,
  packSequence: DogeDay2026RevealSequence,
) {
  if (stage === 'segment_1_2' && stageFrameIndex >= packSequence.segment12FrameUrls.length - 1) {
    return packSequence.initialOvertopFrameUrl;
  }
  if (stage === 'segment_1_2_hold') {
    return packSequence.initialOvertopFrameUrl;
  }
  if (stage === 'autoplay' || stage === 'revealed') {
    return packSequence.segmentAutoplayOvertopFrameUrls[
      Math.min(stageFrameIndex, packSequence.segmentAutoplayOvertopFrameUrls.length - 1)
    ];
  }
  return undefined;
}

function dogeDay2026StageFrameDuration(stage: DogeDay2026RevealStage, autoplayDelayMs: number) {
  if (stage === 'autoplay') return autoplayDelayMs;
  if (stage === 'punch' || stage === 'segment_1_1' || stage === 'segment_1_2') {
    return DOGE_DAY_2026_PUNCH_FRAME_DURATION_MS;
  }
  return 0;
}

export function createDogeDay2026ImageCache(): DogeDay2026ImageCache {
  const cache: DogeDay2026ImageCache = {
    fetched: new Set<string>(),
    pending: new Map<string, Promise<void>>(),
    resident: new Map<string, HTMLImageElement>(),
  };
  setDogeDay2026CacheGeneration(cache, 0);
  getDogeDay2026ImageCacheInvalidationListeners(cache);
  getDogeDay2026PendingElements(cache);
  return cache;
}

export function clearDogeDay2026ImageCache(imageCache: DogeDay2026ImageCache) {
  const nextGeneration = getDogeDay2026CacheGeneration(imageCache) + 1;
  setDogeDay2026CacheGeneration(imageCache, nextGeneration);
  const pendingImages = getDogeDay2026PendingElements(imageCache);
  const failureCounts = getDogeDay2026ImageLoadFailureCounts(imageCache);
  pendingImages.forEach((image) => {
    image.src = '';
  });
  imageCache.resident.forEach((image) => {
    image.src = '';
  });
  pendingImages.clear();
  imageCache.pending.clear();
  imageCache.resident.clear();
  imageCache.fetched.clear();
  failureCounts.clear();
  notifyDogeDay2026ImageCacheInvalidated(imageCache);
}

function releaseDogeDay2026ResidentImages(
  imageSources: readonly string[],
  imageCache: DogeDay2026ImageCache,
) {
  imageSources.forEach((imageSrc) => {
    const normalizedImageSrc = normalizeDogeDay2026ImageSrc(imageSrc);
    if (!normalizedImageSrc) return;
    imageCache.resident.delete(normalizedImageSrc);
  });
}

async function preloadDogeDay2026Image(
  imageSrc: string | undefined,
  imageCache: DogeDay2026ImageCache,
  { mode = 'warm', priority = 'low' }: DogeDay2026ImagePreloadOptions = {},
): Promise<void> {
  const normalizedImageSrc = normalizeDogeDay2026ImageSrc(imageSrc);
  if (!normalizedImageSrc) {
    throw new Error('Missing Doge Day 2026 image source');
  }

  const residentImage = imageCache.resident.get(normalizedImageSrc);
  if (residentImage) {
    updateDogeDay2026FetchPriority(residentImage, priority);
    if (mode === 'resident') {
      await decodeDogeDay2026Image(residentImage);
    }
    return;
  }

  const pendingPromise = imageCache.pending.get(normalizedImageSrc);
  if (pendingPromise) {
    const pendingImages = getDogeDay2026PendingElements(imageCache);
    updateDogeDay2026FetchPriority(pendingImages.get(normalizedImageSrc), priority);
    if (mode === 'resident') {
      const generation = getDogeDay2026CacheGeneration(imageCache);
      const pendingImage = pendingImages.get(normalizedImageSrc);
      await pendingPromise;
      if (getDogeDay2026CacheGeneration(imageCache) !== generation) {
        return;
      }
      const resolvedImage = pendingImage || imageCache.resident.get(normalizedImageSrc);
      if (!resolvedImage) {
        throw new Error(`Failed to preload image: ${normalizedImageSrc}`);
      }
      await decodeDogeDay2026Image(resolvedImage);
      imageCache.resident.set(normalizedImageSrc, resolvedImage);
    }
    return;
  }

  if (mode === 'warm' && imageCache.fetched.has(normalizedImageSrc)) {
    return;
  }

  const generation = getDogeDay2026CacheGeneration(imageCache);
  const image = new Image();
  image.decoding = 'async';
  updateDogeDay2026FetchPriority(image, priority);
  const pendingImages = getDogeDay2026PendingElements(imageCache);

  const promise = new Promise<void>((resolve, reject) => {
    let settled = false;
    let loadTimeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;

    const clearLoadTimeout = () => {
      if (loadTimeoutId === null) return;
      globalThis.clearTimeout(loadTimeoutId);
      loadTimeoutId = null;
    };

    const cleanupListeners = () => {
      image.onload = null;
      image.onerror = null;
    };

    const settleError = (reason: string) => {
      if (settled) return;
      settled = true;
      clearLoadTimeout();
      cleanupListeners();
      image.src = '';
      const generationUnchanged = getDogeDay2026CacheGeneration(imageCache) === generation;
      if (generationUnchanged) {
        imageCache.pending.delete(normalizedImageSrc);
        imageCache.fetched.delete(normalizedImageSrc);
        imageCache.resident.delete(normalizedImageSrc);
        recordDogeDay2026ImageLoadFailure(imageCache, normalizedImageSrc);
      }
      pendingImages.delete(normalizedImageSrc);
      reject(new Error(reason));
    };

    const settleSuccess = async () => {
      if (settled) return;
      settled = true;
      clearLoadTimeout();
      cleanupListeners();
      try {
        if (mode === 'resident') {
          await decodeDogeDay2026Image(image);
        }
        const generationUnchanged = getDogeDay2026CacheGeneration(imageCache) === generation;
        if (generationUnchanged) {
          imageCache.fetched.add(normalizedImageSrc);
          if (mode === 'resident') {
            imageCache.resident.set(normalizedImageSrc, image);
          }
          clearDogeDay2026ImageLoadFailures(imageCache, normalizedImageSrc);
        }
        resolve();
      } catch (err) {
        if (getDogeDay2026CacheGeneration(imageCache) === generation) {
          imageCache.fetched.delete(normalizedImageSrc);
          imageCache.resident.delete(normalizedImageSrc);
        }
        reject(err instanceof Error ? err : new Error(`Failed to decode image: ${normalizedImageSrc}`));
      } finally {
        if (getDogeDay2026CacheGeneration(imageCache) === generation) {
          imageCache.pending.delete(normalizedImageSrc);
        }
        pendingImages.delete(normalizedImageSrc);
      }
    };

    image.onload = () => {
      void settleSuccess();
    };
    image.onerror = () => {
      settleError(`Failed to preload image: ${normalizedImageSrc}`);
    };
    loadTimeoutId = globalThis.setTimeout(() => {
      settleError(`Timed out preloading image: ${normalizedImageSrc}`);
    }, dogeDay2026ImageLoadTimeoutMs(imageCache, normalizedImageSrc));
  });

  imageCache.pending.set(normalizedImageSrc, promise);
  pendingImages.set(normalizedImageSrc, image);
  image.src = normalizedImageSrc;
  return promise;
}

function preloadDogeDay2026ImageSources(
  imageSources: readonly string[],
  imageCache: DogeDay2026ImageCache,
  options: DogeDay2026ImagePreloadOptions = {},
) {
  imageSources.forEach((imageSrc) => {
    void preloadDogeDay2026Image(imageSrc, imageCache, options).catch(() => {

    });
  });
}

async function waitForDogeDay2026ImageSources(
  imageSources: readonly string[],
  imageCache: DogeDay2026ImageCache,
  options: DogeDay2026ImagePreloadOptions = {},
) {
  await Promise.all(imageSources.map((imageSrc) => preloadDogeDay2026Image(imageSrc, imageCache, options)));
}

function waitForDogeDay2026ResidentImageSources(
  imageSources: readonly string[],
  imageCache: DogeDay2026ImageCache,
  signal?: AbortSignal,
) {
  return waitForDogeDay2026AssetsUntilReady(
    () => waitForDogeDay2026ImageSources(imageSources, imageCache, DOGE_DAY_2026_RESIDENT_PRELOAD_OPTIONS),
    { signal },
  );
}

function waitForDogeDay2026RetryDelay(delayMs: number, signal?: AbortSignal) {
  if (signal?.aborted) {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    const timeoutId = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort);
      resolve(true);
    }, delayMs);
    const handleAbort = () => {
      globalThis.clearTimeout(timeoutId);
      signal?.removeEventListener('abort', handleAbort);
      resolve(false);
    };
    signal?.addEventListener('abort', handleAbort, { once: true });
  });
}

function waitForDogeDay2026BackgroundTurn(signal?: AbortSignal) {
  if (signal?.aborted) {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    let animationFrameId: number | null = null;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;

    const cleanup = () => {
      if (animationFrameId !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(animationFrameId);
      }
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
      signal?.removeEventListener('abort', handleAbort);
    };

    const settle = (result: boolean) => {
      cleanup();
      resolve(result);
    };

    const handleAbort = () => {
      settle(false);
    };

    signal?.addEventListener('abort', handleAbort, { once: true });

    if (typeof window !== 'undefined') {
      animationFrameId = window.requestAnimationFrame(() => {
        animationFrameId = null;
        timeoutId = globalThis.setTimeout(() => {
          settle(true);
        }, 0);
      });
      return;
    }

    timeoutId = globalThis.setTimeout(() => {
      settle(true);
    }, 0);
  });
}

async function waitForDogeDay2026AssetsUntilReady(
  waitForAssets: () => Promise<void>,
  { signal, retryDelayMs = DOGE_DAY_2026_ASSET_RETRY_DELAY_MS }: WaitForDogeDay2026AssetsUntilReadyOptions = {},
) {
  let retryAttempt = 0;
  while (!signal?.aborted) {
    try {
      await waitForAssets();
      return true;
    } catch {
      retryAttempt += 1;
      const nextRetryDelayMs = Math.min(retryDelayMs * 2 ** Math.max(0, retryAttempt - 1), 2_880);
      const shouldRetry = await waitForDogeDay2026RetryDelay(nextRetryDelayMs, signal);
      if (!shouldRetry) {
        return false;
      }
    }
  }
  return false;
}

async function waitForDogeDay2026ResidentImageSourcesProgressively(
  imageSources: readonly string[],
  imageCache: DogeDay2026ImageCache,
  {
    signal,
    retryDelayMs,
    priority = 'high',
    shouldPause,
    pauseDelayMs = DOGE_DAY_2026_BACKGROUND_PRELOAD_PAUSE_MS,
  }: WaitForDogeDay2026ResidentImageSourcesProgressivelyOptions = {},
) {
  for (const imageSrc of imageSources) {
    const normalizedImageSrc = normalizeDogeDay2026ImageSrc(imageSrc);
    if (!normalizedImageSrc) continue;
    while (!signal?.aborted && shouldPause?.()) {
      const shouldResume = await waitForDogeDay2026RetryDelay(pauseDelayMs, signal);
      if (!shouldResume) {
        return false;
      }
    }
    if (dogeDay2026ImageResidentReady(normalizedImageSrc, imageCache)) {
      continue;
    }
    const ready = await waitForDogeDay2026AssetsUntilReady(
      () =>
        preloadDogeDay2026Image(normalizedImageSrc, imageCache, {
          mode: 'resident',
          priority,
        }),
      { signal, retryDelayMs, priority },
    );
    if (!ready) {
      return false;
    }
    const shouldContinue = await waitForDogeDay2026BackgroundTurn(signal);
    if (!shouldContinue) {
      return false;
    }
  }
  return true;
}

export function areDogeDay2026CardAssetsReady(
  card: DrifCardConfig | undefined,
  imageCache?: DogeDay2026ImageCache,
) {
  return areDogeDay2026ImageSourcesResidentReady(getDogeDay2026CardAssetSources(card), imageCache);
}

export function preloadDogeDay2026CardAssets(
  card: DrifCardConfig | undefined,
  imageCache: DogeDay2026ImageCache,
  options: DogeDay2026ImagePreloadOptions = {},
) {
  const assetSources = getDogeDay2026CardAssetSources(card);
  if (!assetSources.length) return;
  preloadDogeDay2026ImageSources(assetSources, imageCache, options);
}

export function releaseDogeDay2026CardAssets(
  card: DrifCardConfig | undefined,
  imageCache: DogeDay2026ImageCache,
) {
  const assetSources = getDogeDay2026CardAssetSources(card);
  if (!assetSources.length) return;
  releaseDogeDay2026ResidentImages(assetSources, imageCache);
}

function waitForDogeDay2026CardAssetsUntilReady(
  card: DrifCardConfig | undefined,
  imageCache: DogeDay2026ImageCache,
  signal?: AbortSignal,
  options: DogeDay2026ImagePreloadOptions = {},
) {
  const assetSources = getDogeDay2026CardAssetSources(card);
  if (!assetSources.length) return Promise.resolve(true);
  return waitForDogeDay2026ResidentImageSourcesProgressively(assetSources, imageCache, {
    signal,
    priority: options.priority ?? DOGE_DAY_2026_RESIDENT_PRELOAD_OPTIONS.priority,
  });
}

export function useDogeDay2026CardAssetsReady({
  active,
  card,
  imageCache,
  suspendResidentPreload = false,
  releaseOnCleanup = true,
}: {
  active: boolean;
  card: DrifCardConfig | undefined;
  imageCache: DogeDay2026ImageCache;
  suspendResidentPreload?: boolean;
  releaseOnCleanup?: boolean;
}) {
  const imageCacheGeneration = useDogeDay2026ImageCacheGeneration(imageCache);
  const [ready, setReady] = useState(() => active && areDogeDay2026CardAssetsReady(card, imageCache));

  useEffect(() => {
    if (!active || !card) {
      setReady(false);
      return undefined;
    }
    if (areDogeDay2026CardAssetsReady(card, imageCache)) {
      setReady(true);
      return undefined;
    }
    if (suspendResidentPreload) {
      setReady(false);
      return undefined;
    }
    const abortController = new AbortController();
    setReady(false);
    void waitForDogeDay2026CardAssetsUntilReady(
      card,
      imageCache,
      abortController.signal,
      DOGE_DAY_2026_RESIDENT_PRELOAD_OPTIONS,
    ).then((nextReady) => {
      if (abortController.signal.aborted) return;
      setReady(nextReady);
    });
    return () => {
      abortController.abort();
    };
  }, [active, card, imageCache, imageCacheGeneration, suspendResidentPreload]);

  useEffect(() => {
    if (!active || !card || !releaseOnCleanup) return undefined;
    return () => {
      releaseDogeDay2026CardAssets(card, imageCache);
    };
  }, [active, card, imageCache, releaseOnCleanup]);

  return ready;
}

function preloadDogeDay2026PunchAssets(
  imageCache: DogeDay2026ImageCache,
  options: DogeDay2026ImagePreloadOptions = {},
  packSequence = DOGE_DAY_2026_PACK_REVEAL_SEQUENCE,
) {
  preloadDogeDay2026Image(packSequence.initialFrameUrl, imageCache, options).catch(() => {

  });
  preloadDogeDay2026ImageSources(packSequence.punchFrameUrls, imageCache, options);
}

function preloadDogeDay2026SequenceAssets(
  imageCache: DogeDay2026ImageCache,
  options: DogeDay2026ImagePreloadOptions = {},
  packSequence = DOGE_DAY_2026_PACK_REVEAL_SEQUENCE,
) {
  preloadDogeDay2026ImageSources(packSequence.sequenceFrameUrls, imageCache, options);
  preloadDogeDay2026ImageSources(packSequence.segmentAutoplayOvertopFrameUrls, imageCache, options);
}

export function preloadDogeDay2026PackAssets(
  imageCache: DogeDay2026ImageCache,
  options: DogeDay2026ImagePreloadOptions = {},
  packSequence = DOGE_DAY_2026_PACK_REVEAL_SEQUENCE,
) {
  preloadDogeDay2026PunchAssets(imageCache, options, packSequence);
  preloadDogeDay2026SequenceAssets(imageCache, options, packSequence);
}

type DogeDay2026RevealVisualTarget = {
  boxFrameSrc: string;
  foregroundFrameSrc?: string;
  stageVisible: boolean;
  cardVisible: boolean;
};

export type DogeDay2026RevealPlayerViewState = {
  phase: DogeDay2026RevealPhase;
  stage: DogeDay2026RevealStage;
  note: string;
  advanceLocked: boolean;
  revealComplete: boolean;
  revealFailedOpen: boolean;
  cardInteractive: boolean;
  packDiscarded: boolean;
  stageVisible: boolean;
  cardVisible: boolean;
};

type DogeDay2026RevealHostVisual = {
  boxImage: HTMLImageElement;
  foregroundImage?: HTMLImageElement;
  stageVisible: boolean;
  cardVisible: boolean;
};

type DogeDay2026RevealPlayerHost = {
  clearVisuals: () => void;
  commitVisual: (visual: DogeDay2026RevealHostVisual) => boolean;
  onStateChange: (state: DogeDay2026RevealPlayerViewState) => void;
};

type DogeDay2026RevealPlayerConfig = {
  active: boolean;
  phase: DogeDay2026RevealPhase;
  boxLabel: string;
  cardReady: boolean;
  cardAssetsReady: boolean;
  packSequence?: DogeDay2026RevealSequence;
  imageCache?: DogeDay2026ImageCache;
  host: DogeDay2026RevealPlayerHost;
  onRequestReveal?: () => DogeDay2026RevealRequestStatus | void | Promise<DogeDay2026RevealRequestStatus | void>;
  onPlayClick?: () => void;
  onPlayReveal?: () => void;
  autoplayDelayMs?: number;
};

type DogeDay2026RevealPlayerState = {
  stage: DogeDay2026RevealStage;
  stageFrameIndex: number;
  activePunchFrameUrls: readonly string[];
  hasRevealAttempted: boolean;
  autoplayQueued: boolean;
  cardInteractionUnlocked: boolean;
  revealFailedOpen: boolean;
  revealSoundPlayed: boolean;
  requestState: 'idle' | 'pending' | 'sent';
  requestGeneration: number;
  openingFramesReady: boolean;
  autoplayFramesReady: boolean;
  cardImageReady: boolean;
  cardImageFallbackReady: boolean;
  lastCommittedVisual: DogeDay2026RevealVisualTarget | null;
};

export type DogeDay2026RevealPlayer = {
  update: (config: Partial<Omit<DogeDay2026RevealPlayerConfig, 'host'>>) => void;
  handleAdvance: () => void;
  setCardImageReady: (ready: boolean) => void;
  refreshVisuals: () => void;
  dispose: () => void;
};

type DogeDay2026TimedAdvanceResult = {
  stage: DogeDay2026RevealStage;
  stageFrameIndex: number;
};

type DogeDay2026AdvanceDecision =
  | 'noop'
  | 'request-only'
  | 'start-punch'
  | 'start-segment-1-1'
  | 'start-segment-1-2'
  | 'start-autoplay'
  | 'queue-autoplay';

function getDogeDay2026RevealVisualTarget(
  stage: DogeDay2026RevealStage,
  stageFrameIndex: number,
  activePunchFrameUrls: readonly string[],
  packSequence = DOGE_DAY_2026_PACK_REVEAL_SEQUENCE,
): DogeDay2026RevealVisualTarget {
  const boxFrameSrc = dogeDay2026CurrentBoxFrameSrc(stage, stageFrameIndex, activePunchFrameUrls, packSequence);
  const foregroundFrameSrc = dogeDay2026CurrentForegroundFrameSrc(stage, stageFrameIndex, packSequence);
  const stageVisible = Boolean(foregroundFrameSrc);
  const cardVisible = stage === 'autoplay' || stage === 'revealed';
  return {
    boxFrameSrc,
    foregroundFrameSrc,
    stageVisible,
    cardVisible,
  };
}

function canCommitDogeDay2026VisualTarget(
  target: DogeDay2026RevealVisualTarget,
  readySources: ReadonlySet<string>,
) {
  if (!readySources.has(target.boxFrameSrc)) return false;
  if (!target.stageVisible) return !target.cardVisible;
  if (!target.foregroundFrameSrc || !readySources.has(target.foregroundFrameSrc)) return false;
  return true;
}

function canEnterDogeDay2026Autoplay({
  cardReady,
  cardAssetsReady,
  cardImageReady,
  cardImageFallbackReady,
  autoplayFramesReady,
}: {
  cardReady: boolean;
  cardAssetsReady: boolean;
  cardImageReady: boolean;
  cardImageFallbackReady: boolean;
  autoplayFramesReady: boolean;
}) {
  const cardImageGateReady = cardImageReady || cardImageFallbackReady;
  return cardReady && cardAssetsReady && cardImageGateReady && autoplayFramesReady;
}

function getDogeDay2026TimedAdvanceResult({
  stage,
  stageFrameIndex,
  activePunchFrameCount,
  packSequence = DOGE_DAY_2026_PACK_REVEAL_SEQUENCE,
}: {
  stage: DogeDay2026RevealStage;
  stageFrameIndex: number;
  activePunchFrameCount: number;
  packSequence?: DogeDay2026RevealSequence;
}): DogeDay2026TimedAdvanceResult | null {
  if (stage === 'punch') {
    if (stageFrameIndex >= activePunchFrameCount - 1) {
      return { stage: 'idle', stageFrameIndex: 0 };
    }
    return { stage: 'punch', stageFrameIndex: stageFrameIndex + 1 };
  }
  if (stage === 'segment_1_1') {
    if (stageFrameIndex >= packSequence.segment11FrameUrls.length - 1) {
      return { stage: 'segment_1_1_hold', stageFrameIndex };
    }
    return { stage: 'segment_1_1', stageFrameIndex: stageFrameIndex + 1 };
  }
  if (stage === 'segment_1_2') {
    if (stageFrameIndex >= packSequence.segment12FrameUrls.length - 1) {
      return { stage: 'segment_1_2_hold', stageFrameIndex };
    }
    return { stage: 'segment_1_2', stageFrameIndex: stageFrameIndex + 1 };
  }
  if (stage === 'autoplay') {
    if (stageFrameIndex >= packSequence.segmentAutoplayFrameUrls.length - 1) {
      return { stage: 'revealed', stageFrameIndex };
    }
    return { stage: 'autoplay', stageFrameIndex: stageFrameIndex + 1 };
  }
  return null;
}

function getDogeDay2026AdvanceDecision({
  phase,
  stage,
  advanceLocked,
  cardReady,
  openingFramesReady,
  autoplayEntryReady,
}: {
  phase: DogeDay2026RevealPhase;
  stage: DogeDay2026RevealStage;
  advanceLocked: boolean;
  cardReady: boolean;
  openingFramesReady: boolean;
  autoplayEntryReady: boolean;
}): DogeDay2026AdvanceDecision {
  if (phase !== 'ready' || advanceLocked) return 'noop';
  if (stage === 'punch') return 'request-only';
  if (stage === 'segment_1_1' || stage === 'segment_1_2' || stage === 'autoplay' || stage === 'revealed') {
    return 'noop';
  }
  if (!cardReady) return 'start-punch';
  if (stage === 'idle') {

    return openingFramesReady && autoplayEntryReady ? 'start-segment-1-1' : 'start-punch';
  }
  if (stage === 'segment_1_1_hold') {
    return 'start-segment-1-2';
  }
  if (stage === 'segment_1_2_hold') {
    return autoplayEntryReady ? 'start-autoplay' : 'queue-autoplay';
  }
  return 'noop';
}

function buildDogeDay2026RevealPlayerViewState({
  phase,
  boxLabel,
  hasRevealAttempted,
  stage,
  autoplayQueued,
  cardReady,
  cardInteractionUnlocked,
  revealFailedOpen,
  lastCommittedVisual,
}: {
  phase: DogeDay2026RevealPhase;
  boxLabel: string;
  hasRevealAttempted: boolean;
  stage: DogeDay2026RevealStage;
  autoplayQueued: boolean;
  cardReady: boolean;
  cardInteractionUnlocked: boolean;
  revealFailedOpen: boolean;
  lastCommittedVisual: DogeDay2026RevealVisualTarget | null;
}): DogeDay2026RevealPlayerViewState {
  const surfacePhase =
    phase === 'preparing'
      ? 'preparing'
      : stage === 'revealed' && cardReady
        ? 'revealed'
        : 'ready';
  const advanceLocked = stage === 'autoplay' || (stage === 'segment_1_2_hold' && autoplayQueued);
  const note =
    surfacePhase === 'preparing' || surfacePhase === 'revealed'
      ? ''
      : advanceLocked
        ? 'opening...'
        : hasRevealAttempted
          ? `keep clicking the ${boxLabel}`
          : `click the ${boxLabel} to open`;
  const stageVisible = lastCommittedVisual?.stageVisible ?? false;
  const cardVisible = lastCommittedVisual?.cardVisible ?? false;
  const packDiscarded = surfacePhase === 'revealed' && stageVisible && cardVisible;
  const cardInteractive = packDiscarded && !revealFailedOpen && stage === 'revealed' && cardInteractionUnlocked;
  return {
    phase: surfacePhase,
    stage,
    note,
    advanceLocked,
    revealComplete: stage === 'revealed',
    revealFailedOpen,
    cardInteractive,
    packDiscarded,
    stageVisible,
    cardVisible,
  };
}

function selectDogeDay2026PunchFrameUrls(
  imageCache: DogeDay2026ImageCache | undefined,
  packSequence: DogeDay2026RevealSequence,
) {
  const readinessByVariant = packSequence.punchFrameUrlsByVariant.map((frameUrls) => {
    let readyFrameCount = frameUrls.length;
    if (imageCache) {
      readyFrameCount = 0;
      for (const frameSrc of frameUrls) {
        if (!dogeDay2026ImageResidentReady(frameSrc, imageCache)) break;
        readyFrameCount += 1;
      }
    }
    return {
      frameUrls,
      readyFrameCount,
    };
  });
  const fullReadyVariants = readinessByVariant.filter(({ frameUrls, readyFrameCount }) => readyFrameCount >= frameUrls.length);
  if (fullReadyVariants.length) {
    return fullReadyVariants[Math.floor(Math.random() * fullReadyVariants.length)]!.frameUrls;
  }
  const partiallyReadyVariants = readinessByVariant.filter(({ readyFrameCount }) => readyFrameCount > 0);
  if (partiallyReadyVariants.length) {
    const maxReadyFrameCount = Math.max(...partiallyReadyVariants.map(({ readyFrameCount }) => readyFrameCount));
    const bestReadyVariants = partiallyReadyVariants.filter(({ readyFrameCount }) => readyFrameCount === maxReadyFrameCount);
    const selectedVariant = bestReadyVariants[Math.floor(Math.random() * bestReadyVariants.length)]!;
    return selectedVariant.frameUrls.slice(0, selectedVariant.readyFrameCount);
  }
  return [packSequence.initialFrameUrl];
}

function shouldPrepareDogeDay2026AutoplayResidents({
  cardReady,
  stage,
}: {
  cardReady: boolean;
  stage: DogeDay2026RevealStage;
}) {
  return (
    cardReady ||
    stage === 'segment_1_2' ||
    stage === 'segment_1_2_hold' ||
    stage === 'autoplay' ||
    stage === 'revealed'
  );
}

export function createDogeDay2026RevealPlayer(initialConfig: DogeDay2026RevealPlayerConfig): DogeDay2026RevealPlayer {
  const config: DogeDay2026RevealPlayerConfig = {
    ...initialConfig,
    packSequence: initialConfig.packSequence ?? DOGE_DAY_2026_PACK_REVEAL_SEQUENCE,
    autoplayDelayMs: initialConfig.autoplayDelayMs ?? DOGE_DAY_2026_SEQUENCE_AUTOPLAY_DELAY_MS,
  };
  const state: DogeDay2026RevealPlayerState = {
    stage: 'idle',
    stageFrameIndex: 0,
    activePunchFrameUrls: config.packSequence!.punchFrameUrlsByVariant[0],
    hasRevealAttempted: false,
    autoplayQueued: false,
    cardInteractionUnlocked: false,
    revealFailedOpen: false,
    revealSoundPlayed: false,
    requestState: 'idle',
    requestGeneration: 0,
    openingFramesReady: dogeDay2026OpeningSequenceResidentReady(config.imageCache, config.packSequence!),
    autoplayFramesReady: areDogeDay2026ImageSourcesResidentReady(config.packSequence!.autoplayResidentFrameUrls, config.imageCache),
    cardImageReady: false,
    cardImageFallbackReady: false,
    lastCommittedVisual: null,
  };

  let disposed = false;
  let stageTimeoutId: number | null = null;
  let cardUnlockTimeoutId: number | null = null;
  let cardImageFallbackTimeoutId: number | null = null;
  let waitAbortController: AbortController | null = null;

  const clearStageTimeout = () => {
    if (stageTimeoutId === null || typeof window === 'undefined') return;
    window.clearTimeout(stageTimeoutId);
    stageTimeoutId = null;
  };

  const clearCardUnlockTimeout = () => {
    if (cardUnlockTimeoutId === null || typeof window === 'undefined') return;
    window.clearTimeout(cardUnlockTimeoutId);
    cardUnlockTimeoutId = null;
  };

  const clearCardImageFallbackTimeout = () => {
    if (cardImageFallbackTimeoutId === null || typeof window === 'undefined') return;
    window.clearTimeout(cardImageFallbackTimeoutId);
    cardImageFallbackTimeoutId = null;
  };

  const abortWaits = () => {
    waitAbortController?.abort();
    waitAbortController = null;
  };

  const refreshReadiness = () => {
    const packSequence = config.packSequence ?? DOGE_DAY_2026_PACK_REVEAL_SEQUENCE;
    state.openingFramesReady = dogeDay2026OpeningSequenceResidentReady(config.imageCache, packSequence);
    state.autoplayFramesReady = areDogeDay2026ImageSourcesResidentReady(
      packSequence.autoplayResidentFrameUrls,
      config.imageCache,
    );
  };

  const autoplayEntryReady = () =>
    canEnterDogeDay2026Autoplay({
      cardReady: config.cardReady,
      cardAssetsReady: config.cardAssetsReady,
      cardImageReady: state.cardImageReady,
      cardImageFallbackReady: state.cardImageFallbackReady,
      autoplayFramesReady: state.autoplayFramesReady,
    });

  const refreshCardImagePresentationGate = () => {
    if (!config.cardReady || !config.cardAssetsReady) {
      clearCardImageFallbackTimeout();
      state.cardImageFallbackReady = false;
      if (!config.cardReady) {
        state.cardImageReady = false;
      }
      return;
    }
    if (state.cardImageReady) {
      clearCardImageFallbackTimeout();
      state.cardImageFallbackReady = false;
      return;
    }
    if (state.cardImageFallbackReady || cardImageFallbackTimeoutId !== null || typeof window === 'undefined') {
      return;
    }
    cardImageFallbackTimeoutId = window.setTimeout(() => {
      cardImageFallbackTimeoutId = null;
      if (disposed || !config.active || !config.cardReady || !config.cardAssetsReady || state.cardImageReady) {
        return;
      }
      state.cardImageFallbackReady = true;
      maybeStartQueuedAutoplay();
      commitCurrentVisual();
    }, DOGE_DAY_2026_CARD_IMAGE_SETTLE_DELAY_MS);
  };

  const emitState = () => {
    if (disposed) return;
    const viewState = buildDogeDay2026RevealPlayerViewState({
      phase: config.phase,
      boxLabel: config.boxLabel,
      hasRevealAttempted: state.hasRevealAttempted,
      stage: state.stage,
      autoplayQueued: state.autoplayQueued,
      cardReady: config.cardReady,
      cardInteractionUnlocked: state.cardInteractionUnlocked,
      revealFailedOpen: state.revealFailedOpen,
      lastCommittedVisual: state.lastCommittedVisual,
    });
    const revealSoundReady = state.stage === 'autoplay' || viewState.phase === 'revealed';
    if (revealSoundReady && !state.revealSoundPlayed) {
      state.revealSoundPlayed = true;
      config.onPlayReveal?.();
    }
    config.host.onStateChange(viewState);
  };

  const resolveHostVisual = (target: DogeDay2026RevealVisualTarget): DogeDay2026RevealHostVisual | null => {
    if (disposed || !config.imageCache || state.revealFailedOpen) {
      return null;
    }
    if (target.cardVisible && !autoplayEntryReady()) {
      return null;
    }
    const readySources = new Set(config.imageCache.resident.keys());
    if (!canCommitDogeDay2026VisualTarget(target, readySources)) {
      return null;
    }
    const boxImage = config.imageCache.resident.get(target.boxFrameSrc);
    const foregroundImage = target.foregroundFrameSrc
      ? config.imageCache.resident.get(target.foregroundFrameSrc)
      : undefined;
    if (!boxImage || (target.stageVisible && !foregroundImage)) {
      return null;
    }
    return {
      boxImage,
      foregroundImage,
      stageVisible: target.stageVisible,
      cardVisible: target.cardVisible,
    };
  };

  const commitCurrentVisual = () => {
    if (disposed) {
      emitState();
      return false;
    }
    const target = getDogeDay2026RevealVisualTarget(
      state.stage,
      state.stageFrameIndex,
      state.activePunchFrameUrls,
      config.packSequence,
    );
    const visual = resolveHostVisual(target);
    if (!visual) {
      emitState();
      return false;
    }
    const committed = config.host.commitVisual(visual);
    if (!committed) return false;
    state.lastCommittedVisual = target;
    emitState();
    return true;
  };

  const scheduleStageTick = () => {
    clearStageTimeout();
    if (disposed || !config.active || config.phase !== 'ready') return;
    const frameDurationMs = dogeDay2026StageFrameDuration(state.stage, config.autoplayDelayMs ?? DOGE_DAY_2026_SEQUENCE_AUTOPLAY_DELAY_MS);
    if (!frameDurationMs || typeof window === 'undefined') return;
    stageTimeoutId = window.setTimeout(() => {
      stageTimeoutId = null;
      const next = getDogeDay2026TimedAdvanceResult({
        stage: state.stage,
        stageFrameIndex: state.stageFrameIndex,
        activePunchFrameCount: state.activePunchFrameUrls.length,
        packSequence: config.packSequence,
      });
      if (!next) {
        emitState();
        return;
      }
      state.stage = next.stage;
      state.stageFrameIndex = next.stageFrameIndex;
      if (next.stage !== 'revealed') {
        state.cardInteractionUnlocked = false;
      }
      commitCurrentVisual();
      if (state.stage === 'revealed' && !state.revealFailedOpen && typeof window !== 'undefined') {
        clearCardUnlockTimeout();
        cardUnlockTimeoutId = window.setTimeout(() => {
          cardUnlockTimeoutId = null;
          state.cardInteractionUnlocked = true;
          emitState();
        }, DOGE_DAY_2026_CARD_INTERACTION_UNLOCK_DELAY_MS);
        emitState();
      }
      scheduleStageTick();
    }, frameDurationMs);
  };

  const maybeStartQueuedAutoplay = () => {
    if (!config.active || config.phase !== 'ready') return;
    if (state.stage !== 'segment_1_2_hold' || !state.autoplayQueued || !autoplayEntryReady()) {
      emitState();
      return;
    }
    const target = getDogeDay2026RevealVisualTarget('autoplay', 0, state.activePunchFrameUrls, config.packSequence);
    const visual = resolveHostVisual(target);
    if (!visual) {
      emitState();
      return;
    }
    clearStageTimeout();
    state.autoplayQueued = false;
    state.revealFailedOpen = false;
    const committed = config.host.commitVisual(visual);
    if (!committed) {
      emitState();
      return;
    }
    state.stage = 'autoplay';
    state.stageFrameIndex = 0;
    state.cardInteractionUnlocked = false;
    state.lastCommittedVisual = target;
    emitState();
    scheduleStageTick();
  };

  const shouldPauseResidentPromotion = () =>
    state.stage === 'punch' || state.stage === 'segment_1_1' || state.stage === 'segment_1_2';

  const ensureResidentPreload = () => {
    if (!config.active || !config.imageCache) return;
    const packSequence = config.packSequence ?? DOGE_DAY_2026_PACK_REVEAL_SEQUENCE;
    preloadDogeDay2026PackAssets(config.imageCache, DOGE_DAY_2026_WARM_PRELOAD_OPTIONS, packSequence);
    const shouldPrepareAutoplayResidents = shouldPrepareDogeDay2026AutoplayResidents({
      cardReady: config.cardReady,
      stage: state.stage,
    });
    abortWaits();
    waitAbortController = new AbortController();
    const { signal } = waitAbortController;
    if (!state.openingFramesReady) {
      void waitForDogeDay2026ResidentImageSourcesProgressively(packSequence.openingResidentFrameUrls, config.imageCache, {
        signal,
        shouldPause: shouldPauseResidentPromotion,
      }).then(() => {
        if (disposed || signal.aborted) return;
        refreshReadiness();
        commitCurrentVisual();
      });
    }
    if (shouldPrepareAutoplayResidents && !state.autoplayFramesReady) {
      void waitForDogeDay2026ResidentImageSourcesProgressively(packSequence.autoplayResidentFrameUrls, config.imageCache, {
        signal,
        shouldPause: shouldPauseResidentPromotion,
      }).then(() => {
        if (disposed || signal.aborted) return;
        refreshReadiness();
        maybeStartQueuedAutoplay();
      });
    }
    if (!dogeDay2026ImageResidentReady(packSequence.initialFrameUrl, config.imageCache)) {
      void waitForDogeDay2026ResidentImageSources([packSequence.initialFrameUrl], config.imageCache, signal).then(() => {
        if (disposed || signal.aborted) return;
        refreshReadiness();
        if (!state.lastCommittedVisual) {
          commitCurrentVisual();
        }
      });
    }
  };

  const startRevealRequest = () => {
    if (!config.onRequestReveal) return;
    if (state.requestState !== 'idle') return;
    state.requestGeneration += 1;
    const requestGeneration = state.requestGeneration;
    state.requestState = 'pending';
    void Promise.resolve(config.onRequestReveal())
      .then((status) => {
        if (disposed || state.requestGeneration !== requestGeneration) return;
        state.requestState = status === 'resolved' ? 'sent' : 'idle';
      })
      .catch(() => {
        if (disposed || state.requestGeneration !== requestGeneration) return;
        state.requestState = 'idle';
      });
  };

  const update = (nextConfig: Partial<Omit<DogeDay2026RevealPlayerConfig, 'host'>>) => {
    Object.assign(config, nextConfig);
    config.packSequence = config.packSequence ?? DOGE_DAY_2026_PACK_REVEAL_SEQUENCE;
    refreshReadiness();
    refreshCardImagePresentationGate();
    ensureResidentPreload();
    commitCurrentVisual();
    maybeStartQueuedAutoplay();
    scheduleStageTick();
  };

  const handleAdvance = () => {
    refreshReadiness();
    const advanceLocked = state.stage === 'autoplay' || (state.stage === 'segment_1_2_hold' && state.autoplayQueued);
    if (config.phase !== 'ready' || advanceLocked) return;

    config.onPlayClick?.();
    state.hasRevealAttempted = true;

    const decision = getDogeDay2026AdvanceDecision({
      phase: config.phase,
      stage: state.stage,
      advanceLocked,
      cardReady: config.cardReady,
      openingFramesReady: state.openingFramesReady,
      autoplayEntryReady: autoplayEntryReady(),
    });
    if (decision === 'noop') {
      emitState();
      return;
    }

    if (decision === 'request-only') {
      startRevealRequest();
      emitState();
      return;
    }

    if (decision === 'start-punch') {
      clearStageTimeout();
      state.activePunchFrameUrls = selectDogeDay2026PunchFrameUrls(
        config.imageCache,
        config.packSequence ?? DOGE_DAY_2026_PACK_REVEAL_SEQUENCE,
      );
      state.stage = 'punch';
      state.stageFrameIndex = 0;
      state.cardInteractionUnlocked = false;
      if (!config.cardReady) {
        startRevealRequest();
      }
      commitCurrentVisual();
      scheduleStageTick();
      return;
    }

    if (decision === 'start-segment-1-1') {
      clearStageTimeout();
      state.stage = 'segment_1_1';
      state.stageFrameIndex = 0;
      state.cardInteractionUnlocked = false;
      commitCurrentVisual();
      scheduleStageTick();
      return;
    }

    if (decision === 'start-segment-1-2') {
      clearStageTimeout();
      state.stage = 'segment_1_2';
      state.stageFrameIndex = 0;
      state.cardInteractionUnlocked = false;
      commitCurrentVisual();
      scheduleStageTick();
      return;
    }

    if (decision === 'queue-autoplay') {
      state.autoplayQueued = true;
      emitState();
      return;
    }

    state.autoplayQueued = true;
    maybeStartQueuedAutoplay();
  };

  const setCardImageReady = (ready: boolean) => {
    if (!ready && state.cardImageReady) return;
    if (!ready) return;
    state.cardImageReady = true;
    state.cardImageFallbackReady = false;
    clearCardImageFallbackTimeout();
    maybeStartQueuedAutoplay();
    commitCurrentVisual();
  };

  const dispose = () => {
    disposed = true;
    clearStageTimeout();
    clearCardUnlockTimeout();
    clearCardImageFallbackTimeout();
    abortWaits();
    config.host.clearVisuals();
    if (config.imageCache) {
      releaseDogeDay2026ResidentImages(
        (config.packSequence ?? DOGE_DAY_2026_PACK_REVEAL_SEQUENCE).allPackFrameUrls,
        config.imageCache,
      );
    }
  };

  refreshCardImagePresentationGate();
  ensureResidentPreload();
  commitCurrentVisual();
  emitState();

  return {
    update,
    handleAdvance,
    setCardImageReady,
    refreshVisuals: () => {
      commitCurrentVisual();
      maybeStartQueuedAutoplay();
    },
    dispose,
  };
}
