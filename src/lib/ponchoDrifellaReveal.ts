import { useEffect, useState } from 'react';
import { getDrifCardByFigureId, type DrifCardConfig } from '../drifCards';

const PONCHO_DRIFELLA_PUNCH_VARIANT_NUMBERS = [1, 2, 3] as const;
const PONCHO_DRIFELLA_PUNCH_FRAME_NUMBERS = [1, 2, 3] as const;
const PONCHO_DRIFELLA_SEGMENT_1_1_FRAME_IDS = [13, 16, 19] as const;
const PONCHO_DRIFELLA_SEGMENT_1_2_FRAME_IDS = [30, 33, 38] as const;
const PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_FRAME_IDS = [56, 60, 64, 65, 66, 68, 70, 71, 72, 77] as const;
const PONCHO_DRIFELLA_PUNCH_SEQUENCE_BASE_URL = '/Poncho_Drifella/pack/recoverable_punches';
const PONCHO_DRIFELLA_SEQUENCE_BASE_URL = '/Poncho_Drifella/pack/final_sequence';
export const PONCHO_DRIFELLA_INITIAL_FRAME_URL = '/Poncho_Drifella/pack/initial.webp';
export const PONCHO_DRIFELLA_PUNCH_FRAME_DURATION_MS = 100;
export const PONCHO_DRIFELLA_SEQUENCE_AUTOPLAY_DELAY_MS = 50;
export const PONCHO_DRIFELLA_PACK_DISCARD_DELAY_MS = 420;
export const PONCHO_DRIFELLA_PACK_DISCARD_DURATION_MS = 380;
const PONCHO_DRIFELLA_CARD_INTERACTION_UNLOCK_DELAY_MS =
  PONCHO_DRIFELLA_PACK_DISCARD_DELAY_MS + PONCHO_DRIFELLA_PACK_DISCARD_DURATION_MS;
const PONCHO_DRIFELLA_ASSET_RETRY_DELAY_MS = 180;
const PONCHO_DRIFELLA_BACKGROUND_PRELOAD_PAUSE_MS = 48;
const PONCHO_DRIFELLA_CARD_IMAGE_SETTLE_DELAY_MS = 96;
const PONCHO_DRIFELLA_IMAGE_LOAD_TIMEOUT_BASE_MS = 12_000;
const PONCHO_DRIFELLA_IMAGE_LOAD_TIMEOUT_MAX_MS = 60_000;
const PONCHO_DRIFELLA_PUNCH_FALLBACK_FRAME_URLS = [PONCHO_DRIFELLA_INITIAL_FRAME_URL] as const;

export const PONCHO_DRIFELLA_BOX_SOUND_REVEAL_URL = '/Poncho_Drifella/sounds/crash.mp3';
export const PONCHO_DRIFELLA_BOX_SOUND_CLICK_URLS = [
  '/Poncho_Drifella/sounds/hit1.mp3',
  '/Poncho_Drifella/sounds/hit2.mp3',
  '/Poncho_Drifella/sounds/hit3.mp3',
] as const;

export type PonchoDrifellaImagePreloadMode = 'warm' | 'resident';
export type PonchoDrifellaImagePreloadPriority = 'high' | 'low';

export type PonchoDrifellaImageCache = {
  fetched: Set<string>;
  pending: Map<string, Promise<void>>;
  resident: Map<string, HTMLImageElement>;
};

type PonchoDrifellaImagePreloadOptions = {
  mode?: PonchoDrifellaImagePreloadMode;
  priority?: PonchoDrifellaImagePreloadPriority;
};

const PONCHO_DRIFELLA_WARM_PRELOAD_OPTIONS = {
  mode: 'warm',
  priority: 'low',
} as const satisfies PonchoDrifellaImagePreloadOptions;

const PONCHO_DRIFELLA_RESIDENT_PRELOAD_OPTIONS = {
  mode: 'resident',
  priority: 'high',
} as const satisfies PonchoDrifellaImagePreloadOptions;

type WaitForPonchoDrifellaAssetsUntilReadyOptions = PonchoDrifellaImagePreloadOptions & {
  signal?: AbortSignal;
  retryDelayMs?: number;
};

type WaitForPonchoDrifellaResidentImageSourcesProgressivelyOptions = {
  signal?: AbortSignal;
  retryDelayMs?: number;
  priority?: PonchoDrifellaImagePreloadPriority;
  shouldPause?: () => boolean;
  pauseDelayMs?: number;
};

export type PonchoDrifellaRevealPhase = 'preparing' | 'ready' | 'revealed';
export type PonchoDrifellaRevealRequestStatus = 'resolved' | 'retry';

type PonchoDrifellaRevealStage =
  | 'idle'
  | 'punch'
  | 'segment_1_1'
  | 'segment_1_1_hold'
  | 'segment_1_2'
  | 'segment_1_2_hold'
  | 'autoplay'
  | 'revealed';

const ponchoImageCacheGeneration = new WeakMap<PonchoDrifellaImageCache, number>();
const ponchoImageCacheInvalidationListeners = new WeakMap<PonchoDrifellaImageCache, Set<() => void>>();
const ponchoPendingImageElements = new WeakMap<PonchoDrifellaImageCache, Map<string, HTMLImageElement>>();
const ponchoImageLoadFailureCounts = new WeakMap<PonchoDrifellaImageCache, Map<string, number>>();

function getPonchoDrifellaPendingElements(cache: PonchoDrifellaImageCache) {
  let pending = ponchoPendingImageElements.get(cache);
  if (!pending) {
    pending = new Map<string, HTMLImageElement>();
    ponchoPendingImageElements.set(cache, pending);
  }
  return pending;
}

function getPonchoDrifellaImageLoadFailureCounts(cache: PonchoDrifellaImageCache) {
  let failureCounts = ponchoImageLoadFailureCounts.get(cache);
  if (!failureCounts) {
    failureCounts = new Map<string, number>();
    ponchoImageLoadFailureCounts.set(cache, failureCounts);
  }
  return failureCounts;
}

function recordPonchoDrifellaImageLoadFailure(imageCache: PonchoDrifellaImageCache, imageSrc: string) {
  const failureCounts = getPonchoDrifellaImageLoadFailureCounts(imageCache);
  failureCounts.set(imageSrc, (failureCounts.get(imageSrc) ?? 0) + 1);
}

function clearPonchoDrifellaImageLoadFailures(imageCache: PonchoDrifellaImageCache, imageSrc: string) {
  const failureCounts = getPonchoDrifellaImageLoadFailureCounts(imageCache);
  failureCounts.delete(imageSrc);
}

function ponchoDrifellaImageLoadTimeoutMs(imageCache: PonchoDrifellaImageCache, imageSrc: string) {
  const failureCounts = getPonchoDrifellaImageLoadFailureCounts(imageCache);
  const failureCount = failureCounts.get(imageSrc) ?? 0;
  return Math.min(PONCHO_DRIFELLA_IMAGE_LOAD_TIMEOUT_BASE_MS * 2 ** failureCount, PONCHO_DRIFELLA_IMAGE_LOAD_TIMEOUT_MAX_MS);
}

function getPonchoDrifellaImageCacheInvalidationListeners(cache: PonchoDrifellaImageCache) {
  let listeners = ponchoImageCacheInvalidationListeners.get(cache);
  if (!listeners) {
    listeners = new Set<() => void>();
    ponchoImageCacheInvalidationListeners.set(cache, listeners);
  }
  return listeners;
}

function getPonchoDrifellaCacheGeneration(cache: PonchoDrifellaImageCache) {
  return ponchoImageCacheGeneration.get(cache) ?? 0;
}

function setPonchoDrifellaCacheGeneration(cache: PonchoDrifellaImageCache, generation: number) {
  ponchoImageCacheGeneration.set(cache, generation);
}

function notifyPonchoDrifellaImageCacheInvalidated(cache: PonchoDrifellaImageCache) {
  getPonchoDrifellaImageCacheInvalidationListeners(cache).forEach((listener) => {
    listener();
  });
}

export function usePonchoDrifellaImageCacheGeneration(imageCache?: PonchoDrifellaImageCache) {
  const [generation, setGeneration] = useState(() => (imageCache ? getPonchoDrifellaCacheGeneration(imageCache) : 0));

  useEffect(() => {
    if (!imageCache) {
      setGeneration(0);
      return undefined;
    }

    setGeneration(getPonchoDrifellaCacheGeneration(imageCache));
    const listeners = getPonchoDrifellaImageCacheInvalidationListeners(imageCache);
    const handleInvalidation = () => {
      setGeneration(getPonchoDrifellaCacheGeneration(imageCache));
    };

    listeners.add(handleInvalidation);
    return () => {
      listeners.delete(handleInvalidation);
    };
  }, [imageCache]);

  return generation;
}

function buildPonchoDrifellaNumberedFrameUrls(baseUrl: string, frameCount: number) {
  return Array.from({ length: frameCount }, (_, index) => `${baseUrl}/${index + 1}.webp`);
}

export const PONCHO_DRIFELLA_PUNCH_FRAME_URLS_BY_VARIANT = PONCHO_DRIFELLA_PUNCH_VARIANT_NUMBERS.map((variantNumber) =>
  buildPonchoDrifellaNumberedFrameUrls(
    `${PONCHO_DRIFELLA_PUNCH_SEQUENCE_BASE_URL}/${variantNumber}`,
    PONCHO_DRIFELLA_PUNCH_FRAME_NUMBERS.length,
  ),
);
export const PONCHO_DRIFELLA_SEGMENT_1_1_FRAME_URLS = buildPonchoDrifellaNumberedFrameUrls(
  `${PONCHO_DRIFELLA_SEQUENCE_BASE_URL}/1`,
  PONCHO_DRIFELLA_SEGMENT_1_1_FRAME_IDS.length,
);
export const PONCHO_DRIFELLA_SEGMENT_1_2_FRAME_URLS = buildPonchoDrifellaNumberedFrameUrls(
  `${PONCHO_DRIFELLA_SEQUENCE_BASE_URL}/2`,
  PONCHO_DRIFELLA_SEGMENT_1_2_FRAME_IDS.length,
);
export const PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_FRAME_URLS = buildPonchoDrifellaNumberedFrameUrls(
  `${PONCHO_DRIFELLA_SEQUENCE_BASE_URL}/autoplay`,
  PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_FRAME_IDS.length,
);
export const PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_OVERTOP_FRAME_URLS = buildPonchoDrifellaNumberedFrameUrls(
  `${PONCHO_DRIFELLA_SEQUENCE_BASE_URL}/autoplay/overtop`,
  PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_FRAME_IDS.length,
);
const PONCHO_DRIFELLA_INITIAL_OVERTOP_FRAME_URL =
  PONCHO_DRIFELLA_SEGMENT_1_2_FRAME_URLS[PONCHO_DRIFELLA_SEGMENT_1_2_FRAME_URLS.length - 1]!;

const PONCHO_DRIFELLA_PUNCH_FRAME_URLS = PONCHO_DRIFELLA_PUNCH_FRAME_URLS_BY_VARIANT.flat();
const PONCHO_DRIFELLA_MANUAL_SEQUENCE_FRAME_URLS = [
  ...PONCHO_DRIFELLA_SEGMENT_1_1_FRAME_URLS,
  ...PONCHO_DRIFELLA_SEGMENT_1_2_FRAME_URLS,
];
const PONCHO_DRIFELLA_SEQUENCE_FRAME_URLS = [
  ...PONCHO_DRIFELLA_MANUAL_SEQUENCE_FRAME_URLS,
  ...PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_FRAME_URLS,
];
const PONCHO_DRIFELLA_ALL_PACK_FRAME_URLS = [
  PONCHO_DRIFELLA_INITIAL_FRAME_URL,
  ...PONCHO_DRIFELLA_PUNCH_FRAME_URLS,
  ...PONCHO_DRIFELLA_SEQUENCE_FRAME_URLS,
  ...PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_OVERTOP_FRAME_URLS,
];
const PONCHO_DRIFELLA_OPENING_RESIDENT_FRAME_URLS = [
  PONCHO_DRIFELLA_INITIAL_FRAME_URL,
  ...PONCHO_DRIFELLA_PUNCH_FRAME_URLS,
  ...PONCHO_DRIFELLA_MANUAL_SEQUENCE_FRAME_URLS,
];

export const PONCHO_DRIFELLA_REVEAL_FRAME_SEQUENCE = Object.freeze({
  frames: [...PONCHO_DRIFELLA_SEQUENCE_FRAME_URLS],
  frameCount: PONCHO_DRIFELLA_SEQUENCE_FRAME_URLS.length,
  clickMax: PONCHO_DRIFELLA_MANUAL_SEQUENCE_FRAME_URLS.length,
  autoplayStart: PONCHO_DRIFELLA_MANUAL_SEQUENCE_FRAME_URLS.length + 1,
  mediaStart: PONCHO_DRIFELLA_SEQUENCE_FRAME_URLS.length,
});

function normalizePonchoDrifellaImageSrc(imageSrc: string | undefined) {
  return String(imageSrc || '').trim();
}

function updatePonchoDrifellaFetchPriority(
  image: HTMLImageElement | undefined,
  priority: PonchoDrifellaImagePreloadPriority,
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

async function decodePonchoDrifellaImage(image: HTMLImageElement) {
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

function ponchoDrifellaCardAssetSources(card: DrifCardConfig | undefined) {
  if (!card) return [];
  return Array.from(
    new Set(
      [card.imageSrc, card.textureSrc, card.foilSrc]
        .map((imageSrc) => normalizePonchoDrifellaImageSrc(imageSrc))
        .filter((imageSrc): imageSrc is string => Boolean(imageSrc)),
    ),
  );
}

function ponchoDrifellaImageResidentReady(
  imageSrc: string | undefined,
  imageCache?: PonchoDrifellaImageCache,
) {
  const normalizedImageSrc = normalizePonchoDrifellaImageSrc(imageSrc);
  if (!normalizedImageSrc) return true;
  if (!imageCache) return false;
  return imageCache.fetched.has(normalizedImageSrc) && !imageCache.pending.has(normalizedImageSrc) && imageCache.resident.has(normalizedImageSrc);
}

function arePonchoDrifellaImageSourcesResidentReady(
  imageSources: readonly string[],
  imageCache?: PonchoDrifellaImageCache,
) {
  if (!imageCache) return false;
  return imageSources.every((imageSrc) => ponchoDrifellaImageResidentReady(imageSrc, imageCache));
}

function ponchoDrifellaOpeningSequenceResidentReady(imageCache?: PonchoDrifellaImageCache) {
  return !imageCache || arePonchoDrifellaImageSourcesResidentReady(PONCHO_DRIFELLA_OPENING_RESIDENT_FRAME_URLS, imageCache);
}

function ponchoDrifellaCurrentBoxFrameSrc(
  stage: PonchoDrifellaRevealStage,
  stageFrameIndex: number,
  activePunchFrameUrls: readonly string[],
) {
  if (stage === 'punch') {
    return activePunchFrameUrls[Math.min(stageFrameIndex, activePunchFrameUrls.length - 1)] || PONCHO_DRIFELLA_INITIAL_FRAME_URL;
  }
  if (stage === 'segment_1_1' || stage === 'segment_1_1_hold') {
    return PONCHO_DRIFELLA_SEGMENT_1_1_FRAME_URLS[Math.min(stageFrameIndex, PONCHO_DRIFELLA_SEGMENT_1_1_FRAME_URLS.length - 1)]!;
  }
  if (stage === 'segment_1_2' || stage === 'segment_1_2_hold') {
    return PONCHO_DRIFELLA_SEGMENT_1_2_FRAME_URLS[Math.min(stageFrameIndex, PONCHO_DRIFELLA_SEGMENT_1_2_FRAME_URLS.length - 1)]!;
  }
  if (stage === 'autoplay' || stage === 'revealed') {
    return PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_FRAME_URLS[
      Math.min(stageFrameIndex, PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_FRAME_URLS.length - 1)
    ]!;
  }
  return PONCHO_DRIFELLA_INITIAL_FRAME_URL;
}

function ponchoDrifellaCurrentForegroundFrameSrc(
  stage: PonchoDrifellaRevealStage,
  stageFrameIndex: number,
) {
  if (stage === 'segment_1_2' && stageFrameIndex >= PONCHO_DRIFELLA_SEGMENT_1_2_FRAME_URLS.length - 1) {
    return PONCHO_DRIFELLA_INITIAL_OVERTOP_FRAME_URL;
  }
  if (stage === 'segment_1_2_hold') {
    return PONCHO_DRIFELLA_INITIAL_OVERTOP_FRAME_URL;
  }
  if (stage === 'autoplay' || stage === 'revealed') {
    return PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_OVERTOP_FRAME_URLS[
      Math.min(stageFrameIndex, PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_OVERTOP_FRAME_URLS.length - 1)
    ];
  }
  return undefined;
}

function ponchoDrifellaStageFrameDuration(stage: PonchoDrifellaRevealStage, autoplayDelayMs: number) {
  if (stage === 'autoplay') return autoplayDelayMs;
  if (stage === 'punch' || stage === 'segment_1_1' || stage === 'segment_1_2') {
    return PONCHO_DRIFELLA_PUNCH_FRAME_DURATION_MS;
  }
  return 0;
}

export function createPonchoDrifellaImageCache(): PonchoDrifellaImageCache {
  const cache: PonchoDrifellaImageCache = {
    fetched: new Set<string>(),
    pending: new Map<string, Promise<void>>(),
    resident: new Map<string, HTMLImageElement>(),
  };
  setPonchoDrifellaCacheGeneration(cache, 0);
  getPonchoDrifellaImageCacheInvalidationListeners(cache);
  getPonchoDrifellaPendingElements(cache);
  return cache;
}

export function clearPonchoDrifellaImageCache(imageCache: PonchoDrifellaImageCache) {
  const nextGeneration = getPonchoDrifellaCacheGeneration(imageCache) + 1;
  setPonchoDrifellaCacheGeneration(imageCache, nextGeneration);
  const pendingImages = getPonchoDrifellaPendingElements(imageCache);
  const failureCounts = getPonchoDrifellaImageLoadFailureCounts(imageCache);
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
  notifyPonchoDrifellaImageCacheInvalidated(imageCache);
}

export function releasePonchoDrifellaResidentImages(
  imageSources: readonly string[],
  imageCache: PonchoDrifellaImageCache,
) {
  imageSources.forEach((imageSrc) => {
    const normalizedImageSrc = normalizePonchoDrifellaImageSrc(imageSrc);
    if (!normalizedImageSrc) return;
    imageCache.resident.delete(normalizedImageSrc);
  });
}

export async function preloadPonchoDrifellaImage(
  imageSrc: string | undefined,
  imageCache: PonchoDrifellaImageCache,
  { mode = 'warm', priority = 'low' }: PonchoDrifellaImagePreloadOptions = {},
): Promise<void> {
  const normalizedImageSrc = normalizePonchoDrifellaImageSrc(imageSrc);
  if (!normalizedImageSrc) {
    throw new Error('Missing Poncho Drifella image source');
  }

  const residentImage = imageCache.resident.get(normalizedImageSrc);
  if (residentImage) {
    updatePonchoDrifellaFetchPriority(residentImage, priority);
    if (mode === 'resident') {
      await decodePonchoDrifellaImage(residentImage);
    }
    return;
  }

  const pendingPromise = imageCache.pending.get(normalizedImageSrc);
  if (pendingPromise) {
    const pendingImages = getPonchoDrifellaPendingElements(imageCache);
    updatePonchoDrifellaFetchPriority(pendingImages.get(normalizedImageSrc), priority);
    if (mode === 'resident') {
      const generation = getPonchoDrifellaCacheGeneration(imageCache);
      const pendingImage = pendingImages.get(normalizedImageSrc);
      await pendingPromise;
      if (getPonchoDrifellaCacheGeneration(imageCache) !== generation) {
        return;
      }
      const resolvedImage = pendingImage || imageCache.resident.get(normalizedImageSrc);
      if (!resolvedImage) {
        throw new Error(`Failed to preload image: ${normalizedImageSrc}`);
      }
      await decodePonchoDrifellaImage(resolvedImage);
      imageCache.resident.set(normalizedImageSrc, resolvedImage);
    }
    return;
  }

  // Warm preloads only need one successful fetch per cache generation.
  if (mode === 'warm' && imageCache.fetched.has(normalizedImageSrc)) {
    return;
  }

  const generation = getPonchoDrifellaCacheGeneration(imageCache);
  const image = new Image();
  image.decoding = 'async';
  updatePonchoDrifellaFetchPriority(image, priority);
  const pendingImages = getPonchoDrifellaPendingElements(imageCache);

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
      const generationUnchanged = getPonchoDrifellaCacheGeneration(imageCache) === generation;
      if (generationUnchanged) {
        imageCache.pending.delete(normalizedImageSrc);
        imageCache.fetched.delete(normalizedImageSrc);
        imageCache.resident.delete(normalizedImageSrc);
        recordPonchoDrifellaImageLoadFailure(imageCache, normalizedImageSrc);
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
          await decodePonchoDrifellaImage(image);
        }
        const generationUnchanged = getPonchoDrifellaCacheGeneration(imageCache) === generation;
        if (generationUnchanged) {
          imageCache.fetched.add(normalizedImageSrc);
          if (mode === 'resident') {
            imageCache.resident.set(normalizedImageSrc, image);
          }
          clearPonchoDrifellaImageLoadFailures(imageCache, normalizedImageSrc);
        }
        resolve();
      } catch (err) {
        if (getPonchoDrifellaCacheGeneration(imageCache) === generation) {
          imageCache.fetched.delete(normalizedImageSrc);
          imageCache.resident.delete(normalizedImageSrc);
        }
        reject(err instanceof Error ? err : new Error(`Failed to decode image: ${normalizedImageSrc}`));
      } finally {
        if (getPonchoDrifellaCacheGeneration(imageCache) === generation) {
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
    }, ponchoDrifellaImageLoadTimeoutMs(imageCache, normalizedImageSrc));
  });

  imageCache.pending.set(normalizedImageSrc, promise);
  pendingImages.set(normalizedImageSrc, image);
  image.src = normalizedImageSrc;
  return promise;
}

function preloadPonchoDrifellaImageSources(
  imageSources: readonly string[],
  imageCache: PonchoDrifellaImageCache,
  options: PonchoDrifellaImagePreloadOptions = {},
) {
  imageSources.forEach((imageSrc) => {
    void preloadPonchoDrifellaImage(imageSrc, imageCache, options).catch(() => {
      // Allow readiness loops to retry failed images.
    });
  });
}

async function waitForPonchoDrifellaImageSources(
  imageSources: readonly string[],
  imageCache: PonchoDrifellaImageCache,
  options: PonchoDrifellaImagePreloadOptions = {},
) {
  await Promise.all(imageSources.map((imageSrc) => preloadPonchoDrifellaImage(imageSrc, imageCache, options)));
}

function waitForPonchoDrifellaResidentImageSources(
  imageSources: readonly string[],
  imageCache: PonchoDrifellaImageCache,
  signal?: AbortSignal,
) {
  return waitForPonchoDrifellaAssetsUntilReady(
    () => waitForPonchoDrifellaImageSources(imageSources, imageCache, PONCHO_DRIFELLA_RESIDENT_PRELOAD_OPTIONS),
    { signal },
  );
}

function waitForPonchoDrifellaRetryDelay(delayMs: number, signal?: AbortSignal) {
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

function waitForPonchoDrifellaBackgroundTurn(signal?: AbortSignal) {
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

async function waitForPonchoDrifellaAssetsUntilReady(
  waitForAssets: () => Promise<void>,
  { signal, retryDelayMs = PONCHO_DRIFELLA_ASSET_RETRY_DELAY_MS }: WaitForPonchoDrifellaAssetsUntilReadyOptions = {},
) {
  let retryAttempt = 0;
  while (!signal?.aborted) {
    try {
      await waitForAssets();
      return true;
    } catch {
      retryAttempt += 1;
      const nextRetryDelayMs = Math.min(retryDelayMs * 2 ** Math.max(0, retryAttempt - 1), 2_880);
      const shouldRetry = await waitForPonchoDrifellaRetryDelay(nextRetryDelayMs, signal);
      if (!shouldRetry) {
        return false;
      }
    }
  }
  return false;
}

async function waitForPonchoDrifellaResidentImageSourcesProgressively(
  imageSources: readonly string[],
  imageCache: PonchoDrifellaImageCache,
  {
    signal,
    retryDelayMs,
    priority = 'high',
    shouldPause,
    pauseDelayMs = PONCHO_DRIFELLA_BACKGROUND_PRELOAD_PAUSE_MS,
  }: WaitForPonchoDrifellaResidentImageSourcesProgressivelyOptions = {},
) {
  for (const imageSrc of imageSources) {
    const normalizedImageSrc = normalizePonchoDrifellaImageSrc(imageSrc);
    if (!normalizedImageSrc) continue;
    while (!signal?.aborted && shouldPause?.()) {
      const shouldResume = await waitForPonchoDrifellaRetryDelay(pauseDelayMs, signal);
      if (!shouldResume) {
        return false;
      }
    }
    if (ponchoDrifellaImageResidentReady(normalizedImageSrc, imageCache)) {
      continue;
    }
    const ready = await waitForPonchoDrifellaAssetsUntilReady(
      () =>
        preloadPonchoDrifellaImage(normalizedImageSrc, imageCache, {
          mode: 'resident',
          priority,
        }),
      { signal, retryDelayMs, priority },
    );
    if (!ready) {
      return false;
    }
    const shouldContinue = await waitForPonchoDrifellaBackgroundTurn(signal);
    if (!shouldContinue) {
      return false;
    }
  }
  return true;
}

export function getRandomPonchoDrifellaBoxClickSoundUrl() {
  return (
    PONCHO_DRIFELLA_BOX_SOUND_CLICK_URLS[
      Math.floor(Math.random() * PONCHO_DRIFELLA_BOX_SOUND_CLICK_URLS.length)
    ] || PONCHO_DRIFELLA_BOX_SOUND_CLICK_URLS[0]
  );
}

export function getPonchoDrifellaCardByFigureId(figureId: number): DrifCardConfig | undefined {
  return getDrifCardByFigureId(figureId);
}

export function arePonchoDrifellaCardAssetsReady(
  card: DrifCardConfig | undefined,
  imageCache?: PonchoDrifellaImageCache,
) {
  return arePonchoDrifellaImageSourcesResidentReady(ponchoDrifellaCardAssetSources(card), imageCache);
}

export function preloadPonchoDrifellaCardAssets(
  card: DrifCardConfig | undefined,
  imageCache: PonchoDrifellaImageCache,
  options: PonchoDrifellaImagePreloadOptions = {},
) {
  const assetSources = ponchoDrifellaCardAssetSources(card);
  if (!assetSources.length) return;
  preloadPonchoDrifellaImageSources(assetSources, imageCache, options);
}

export function releasePonchoDrifellaCardAssets(
  card: DrifCardConfig | undefined,
  imageCache: PonchoDrifellaImageCache,
) {
  const assetSources = ponchoDrifellaCardAssetSources(card);
  if (!assetSources.length) return;
  releasePonchoDrifellaResidentImages(assetSources, imageCache);
}

export function waitForPonchoDrifellaCardAssetsUntilReady(
  card: DrifCardConfig | undefined,
  imageCache: PonchoDrifellaImageCache,
  signal?: AbortSignal,
  options: PonchoDrifellaImagePreloadOptions = {},
) {
  const assetSources = ponchoDrifellaCardAssetSources(card);
  if (!assetSources.length) return Promise.resolve(true);
  return waitForPonchoDrifellaResidentImageSourcesProgressively(assetSources, imageCache, {
    signal,
    priority: options.priority ?? PONCHO_DRIFELLA_RESIDENT_PRELOAD_OPTIONS.priority,
  });
}

export function usePonchoDrifellaCardAssetsReady({
  active,
  card,
  imageCache,
  suspendResidentPreload = false,
}: {
  active: boolean;
  card: DrifCardConfig | undefined;
  imageCache: PonchoDrifellaImageCache;
  suspendResidentPreload?: boolean;
}) {
  const imageCacheGeneration = usePonchoDrifellaImageCacheGeneration(imageCache);
  const [ready, setReady] = useState(() => active && arePonchoDrifellaCardAssetsReady(card, imageCache));

  useEffect(() => {
    if (!active || !card) {
      setReady(false);
      return undefined;
    }
    if (arePonchoDrifellaCardAssetsReady(card, imageCache)) {
      setReady(true);
      return undefined;
    }
    if (suspendResidentPreload) {
      setReady(false);
      return undefined;
    }
    const abortController = new AbortController();
    setReady(false);
    void waitForPonchoDrifellaCardAssetsUntilReady(
      card,
      imageCache,
      abortController.signal,
      PONCHO_DRIFELLA_RESIDENT_PRELOAD_OPTIONS,
    ).then((nextReady) => {
      if (abortController.signal.aborted) return;
      setReady(nextReady);
    });
    return () => {
      abortController.abort();
    };
  }, [active, card, imageCache, imageCacheGeneration, suspendResidentPreload]);

  useEffect(() => {
    if (!active || !card) return undefined;
    return () => {
      releasePonchoDrifellaCardAssets(card, imageCache);
    };
  }, [active, card, imageCache]);

  return ready;
}

export function preloadPonchoDrifellaPunchAssets(
  imageCache: PonchoDrifellaImageCache,
  options: PonchoDrifellaImagePreloadOptions = {},
) {
  preloadPonchoDrifellaImage(PONCHO_DRIFELLA_INITIAL_FRAME_URL, imageCache, options).catch(() => {
    // Allow later retries.
  });
  preloadPonchoDrifellaImageSources(PONCHO_DRIFELLA_PUNCH_FRAME_URLS, imageCache, options);
}

export function preloadPonchoDrifellaSequenceAssets(
  imageCache: PonchoDrifellaImageCache,
  options: PonchoDrifellaImagePreloadOptions = {},
) {
  preloadPonchoDrifellaImageSources(PONCHO_DRIFELLA_SEQUENCE_FRAME_URLS, imageCache, options);
  preloadPonchoDrifellaImageSources(PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_OVERTOP_FRAME_URLS, imageCache, options);
}

export function preloadPonchoDrifellaPackAssets(
  imageCache: PonchoDrifellaImageCache,
  options: PonchoDrifellaImagePreloadOptions = {},
) {
  preloadPonchoDrifellaPunchAssets(imageCache, options);
  preloadPonchoDrifellaSequenceAssets(imageCache, options);
}

const PONCHO_DRIFELLA_AUTOPLAY_RESIDENT_FRAME_URLS = [
  ...PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_FRAME_URLS,
  ...PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_OVERTOP_FRAME_URLS,
];

export type PonchoDrifellaRevealVisualTarget = {
  boxFrameSrc: string;
  foregroundFrameSrc?: string;
  stageVisible: boolean;
  cardVisible: boolean;
};

export type PonchoDrifellaRevealPlayerViewState = {
  phase: PonchoDrifellaRevealPhase;
  stage: PonchoDrifellaRevealStage;
  note: string;
  advanceLocked: boolean;
  revealComplete: boolean;
  revealFailedOpen: boolean;
  cardInteractive: boolean;
  packDiscarded: boolean;
  stageVisible: boolean;
  cardVisible: boolean;
};

export type PonchoDrifellaRevealHostVisual = {
  boxImage: HTMLImageElement;
  foregroundImage?: HTMLImageElement;
  stageVisible: boolean;
  cardVisible: boolean;
};

export type PonchoDrifellaRevealPlayerHost = {
  clearVisuals: () => void;
  commitVisual: (visual: PonchoDrifellaRevealHostVisual) => boolean;
  onStateChange: (state: PonchoDrifellaRevealPlayerViewState) => void;
};

type PonchoDrifellaRevealPlayerConfig = {
  active: boolean;
  phase: PonchoDrifellaRevealPhase;
  boxLabel: string;
  cardReady: boolean;
  cardAssetsReady: boolean;
  imageCache?: PonchoDrifellaImageCache;
  host: PonchoDrifellaRevealPlayerHost;
  onRequestReveal?: () => PonchoDrifellaRevealRequestStatus | void | Promise<PonchoDrifellaRevealRequestStatus | void>;
  onPlayClick?: () => void;
  onPlayReveal?: () => void;
  autoplayDelayMs?: number;
};

type PonchoDrifellaRevealPlayerState = {
  stage: PonchoDrifellaRevealStage;
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
  lastCommittedVisual: PonchoDrifellaRevealVisualTarget | null;
};

export type PonchoDrifellaRevealPlayer = {
  update: (config: Partial<Omit<PonchoDrifellaRevealPlayerConfig, 'host'>>) => void;
  handleAdvance: () => void;
  setCardImageReady: (ready: boolean) => void;
  refreshVisuals: () => void;
  dispose: () => void;
};

export type PonchoDrifellaTimedAdvanceResult = {
  stage: PonchoDrifellaRevealStage;
  stageFrameIndex: number;
};

export type PonchoDrifellaAdvanceDecision =
  | 'noop'
  | 'request-only'
  | 'start-punch'
  | 'start-segment-1-1'
  | 'start-segment-1-2'
  | 'start-autoplay'
  | 'queue-autoplay';

export function getPonchoDrifellaRevealVisualTarget(
  stage: PonchoDrifellaRevealStage,
  stageFrameIndex: number,
  activePunchFrameUrls: readonly string[],
): PonchoDrifellaRevealVisualTarget {
  const boxFrameSrc = ponchoDrifellaCurrentBoxFrameSrc(stage, stageFrameIndex, activePunchFrameUrls);
  const foregroundFrameSrc = ponchoDrifellaCurrentForegroundFrameSrc(stage, stageFrameIndex);
  const stageVisible = Boolean(foregroundFrameSrc);
  const cardVisible = stage === 'autoplay' || stage === 'revealed';
  return {
    boxFrameSrc,
    foregroundFrameSrc,
    stageVisible,
    cardVisible,
  };
}

export function canCommitPonchoDrifellaVisualTarget(
  target: PonchoDrifellaRevealVisualTarget,
  readySources: ReadonlySet<string>,
) {
  if (!readySources.has(target.boxFrameSrc)) return false;
  if (!target.stageVisible) return !target.cardVisible;
  if (!target.foregroundFrameSrc || !readySources.has(target.foregroundFrameSrc)) return false;
  return true;
}

export function canEnterPonchoDrifellaAutoplay({
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

export function getPonchoDrifellaTimedAdvanceResult({
  stage,
  stageFrameIndex,
  activePunchFrameCount,
}: {
  stage: PonchoDrifellaRevealStage;
  stageFrameIndex: number;
  activePunchFrameCount: number;
}): PonchoDrifellaTimedAdvanceResult | null {
  if (stage === 'punch') {
    if (stageFrameIndex >= activePunchFrameCount - 1) {
      return { stage: 'idle', stageFrameIndex: 0 };
    }
    return { stage: 'punch', stageFrameIndex: stageFrameIndex + 1 };
  }
  if (stage === 'segment_1_1') {
    if (stageFrameIndex >= PONCHO_DRIFELLA_SEGMENT_1_1_FRAME_URLS.length - 1) {
      return { stage: 'segment_1_1_hold', stageFrameIndex };
    }
    return { stage: 'segment_1_1', stageFrameIndex: stageFrameIndex + 1 };
  }
  if (stage === 'segment_1_2') {
    if (stageFrameIndex >= PONCHO_DRIFELLA_SEGMENT_1_2_FRAME_URLS.length - 1) {
      return { stage: 'segment_1_2_hold', stageFrameIndex };
    }
    return { stage: 'segment_1_2', stageFrameIndex: stageFrameIndex + 1 };
  }
  if (stage === 'autoplay') {
    if (stageFrameIndex >= PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_FRAME_URLS.length - 1) {
      return { stage: 'revealed', stageFrameIndex };
    }
    return { stage: 'autoplay', stageFrameIndex: stageFrameIndex + 1 };
  }
  return null;
}

export function getPonchoDrifellaAdvanceDecision({
  phase,
  stage,
  advanceLocked,
  cardReady,
  openingFramesReady,
  autoplayEntryReady,
}: {
  phase: PonchoDrifellaRevealPhase;
  stage: PonchoDrifellaRevealStage;
  advanceLocked: boolean;
  cardReady: boolean;
  openingFramesReady: boolean;
  autoplayEntryReady: boolean;
}): PonchoDrifellaAdvanceDecision {
  if (phase !== 'ready' || advanceLocked) return 'noop';
  if (stage === 'punch') return 'request-only';
  if (stage === 'segment_1_1' || stage === 'segment_1_2' || stage === 'autoplay' || stage === 'revealed') {
    return 'noop';
  }
  if (!cardReady) return 'start-punch';
  if (stage === 'idle') {
    // The extracted player advances autoplay on a fixed timer, so only leave idle once the full entry path is ready.
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

export function buildPonchoDrifellaRevealPlayerViewState({
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
  phase: PonchoDrifellaRevealPhase;
  boxLabel: string;
  hasRevealAttempted: boolean;
  stage: PonchoDrifellaRevealStage;
  autoplayQueued: boolean;
  cardReady: boolean;
  cardInteractionUnlocked: boolean;
  revealFailedOpen: boolean;
  lastCommittedVisual: PonchoDrifellaRevealVisualTarget | null;
}): PonchoDrifellaRevealPlayerViewState {
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

function selectPonchoDrifellaPunchFrameUrls(imageCache?: PonchoDrifellaImageCache) {
  const readinessByVariant = PONCHO_DRIFELLA_PUNCH_FRAME_URLS_BY_VARIANT.map((frameUrls) => {
    let readyFrameCount = frameUrls.length;
    if (imageCache) {
      readyFrameCount = 0;
      for (const frameSrc of frameUrls) {
        if (!ponchoDrifellaImageResidentReady(frameSrc, imageCache)) break;
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
  return PONCHO_DRIFELLA_PUNCH_FALLBACK_FRAME_URLS;
}

function shouldPreparePonchoDrifellaAutoplayResidents({
  cardReady,
  stage,
}: {
  cardReady: boolean;
  stage: PonchoDrifellaRevealStage;
}) {
  return (
    cardReady ||
    stage === 'segment_1_2' ||
    stage === 'segment_1_2_hold' ||
    stage === 'autoplay' ||
    stage === 'revealed'
  );
}

export function createPonchoDrifellaRevealPlayer(initialConfig: PonchoDrifellaRevealPlayerConfig): PonchoDrifellaRevealPlayer {
  const config: PonchoDrifellaRevealPlayerConfig = {
    ...initialConfig,
    autoplayDelayMs: initialConfig.autoplayDelayMs ?? PONCHO_DRIFELLA_SEQUENCE_AUTOPLAY_DELAY_MS,
  };
  const state: PonchoDrifellaRevealPlayerState = {
    stage: 'idle',
    stageFrameIndex: 0,
    activePunchFrameUrls: PONCHO_DRIFELLA_PUNCH_FRAME_URLS_BY_VARIANT[0],
    hasRevealAttempted: false,
    autoplayQueued: false,
    cardInteractionUnlocked: false,
    revealFailedOpen: false,
    revealSoundPlayed: false,
    requestState: 'idle',
    requestGeneration: 0,
    openingFramesReady: ponchoDrifellaOpeningSequenceResidentReady(config.imageCache),
    autoplayFramesReady: arePonchoDrifellaImageSourcesResidentReady(PONCHO_DRIFELLA_AUTOPLAY_RESIDENT_FRAME_URLS, config.imageCache),
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
    state.openingFramesReady = ponchoDrifellaOpeningSequenceResidentReady(config.imageCache);
    state.autoplayFramesReady = arePonchoDrifellaImageSourcesResidentReady(
      PONCHO_DRIFELLA_AUTOPLAY_RESIDENT_FRAME_URLS,
      config.imageCache,
    );
  };

  const autoplayEntryReady = () =>
    canEnterPonchoDrifellaAutoplay({
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
    }, PONCHO_DRIFELLA_CARD_IMAGE_SETTLE_DELAY_MS);
  };

  const emitState = () => {
    if (disposed) return;
    const viewState = buildPonchoDrifellaRevealPlayerViewState({
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

  const resolveHostVisual = (target: PonchoDrifellaRevealVisualTarget): PonchoDrifellaRevealHostVisual | null => {
    if (disposed || !config.imageCache || state.revealFailedOpen) {
      return null;
    }
    if (target.cardVisible && !autoplayEntryReady()) {
      return null;
    }
    const readySources = new Set(config.imageCache.resident.keys());
    if (!canCommitPonchoDrifellaVisualTarget(target, readySources)) {
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
    const target = getPonchoDrifellaRevealVisualTarget(state.stage, state.stageFrameIndex, state.activePunchFrameUrls);
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
    const frameDurationMs = ponchoDrifellaStageFrameDuration(state.stage, config.autoplayDelayMs ?? PONCHO_DRIFELLA_SEQUENCE_AUTOPLAY_DELAY_MS);
    if (!frameDurationMs || typeof window === 'undefined') return;
    stageTimeoutId = window.setTimeout(() => {
      stageTimeoutId = null;
      const next = getPonchoDrifellaTimedAdvanceResult({
        stage: state.stage,
        stageFrameIndex: state.stageFrameIndex,
        activePunchFrameCount: state.activePunchFrameUrls.length,
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
        }, PONCHO_DRIFELLA_CARD_INTERACTION_UNLOCK_DELAY_MS);
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
    const target = getPonchoDrifellaRevealVisualTarget('autoplay', 0, state.activePunchFrameUrls);
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
    preloadPonchoDrifellaPackAssets(config.imageCache, PONCHO_DRIFELLA_WARM_PRELOAD_OPTIONS);
    const shouldPrepareAutoplayResidents = shouldPreparePonchoDrifellaAutoplayResidents({
      cardReady: config.cardReady,
      stage: state.stage,
    });
    abortWaits();
    waitAbortController = new AbortController();
    const { signal } = waitAbortController;
    if (!state.openingFramesReady) {
      void waitForPonchoDrifellaResidentImageSourcesProgressively(PONCHO_DRIFELLA_OPENING_RESIDENT_FRAME_URLS, config.imageCache, {
        signal,
        shouldPause: shouldPauseResidentPromotion,
      }).then(() => {
        if (disposed || signal.aborted) return;
        refreshReadiness();
        commitCurrentVisual();
      });
    }
    if (shouldPrepareAutoplayResidents && !state.autoplayFramesReady) {
      void waitForPonchoDrifellaResidentImageSourcesProgressively(PONCHO_DRIFELLA_AUTOPLAY_RESIDENT_FRAME_URLS, config.imageCache, {
        signal,
        shouldPause: shouldPauseResidentPromotion,
      }).then(() => {
        if (disposed || signal.aborted) return;
        refreshReadiness();
        maybeStartQueuedAutoplay();
      });
    }
    if (!ponchoDrifellaImageResidentReady(PONCHO_DRIFELLA_INITIAL_FRAME_URL, config.imageCache)) {
      void waitForPonchoDrifellaResidentImageSources([PONCHO_DRIFELLA_INITIAL_FRAME_URL], config.imageCache, signal).then(() => {
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

  const update = (nextConfig: Partial<Omit<PonchoDrifellaRevealPlayerConfig, 'host'>>) => {
    Object.assign(config, nextConfig);
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

    const decision = getPonchoDrifellaAdvanceDecision({
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
      state.activePunchFrameUrls = selectPonchoDrifellaPunchFrameUrls(config.imageCache);
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
      releasePonchoDrifellaResidentImages(PONCHO_DRIFELLA_ALL_PACK_FRAME_URLS, config.imageCache);
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
