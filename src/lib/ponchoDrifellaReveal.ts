import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getDrifCardByFigureId, type DrifCardConfig } from '../drifCards';

const PONCHO_DRIFELLA_PUNCH_VARIANT_NUMBERS = [1, 2, 3] as const;
const PONCHO_DRIFELLA_PUNCH_FRAME_NUMBERS = [1, 2, 3] as const;
const PONCHO_DRIFELLA_SEGMENT_1_1_FRAME_IDS = [13, 16, 19] as const;
const PONCHO_DRIFELLA_SEGMENT_1_2_FRAME_IDS = [30, 33, 38] as const;
const PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_FRAME_IDS = [56, 60, 64, 65, 66, 68, 70, 71, 72, 77] as const;
const PONCHO_DRIFELLA_PUNCH_SEQUENCE_BASE_URL = '/Poncho_Drifella/pack/recoverable_punches';
const PONCHO_DRIFELLA_SEQUENCE_BASE_URL = '/Poncho_Drifella/pack/final_sequences';
export const PONCHO_DRIFELLA_INITIAL_FRAME_URL = '/Poncho_Drifella/pack/initial.webp';
export const PONCHO_DRIFELLA_PUNCH_FRAME_DURATION_MS = 100;
export const PONCHO_DRIFELLA_SEQUENCE_AUTOPLAY_DELAY_MS = 50;
export const PONCHO_DRIFELLA_PACK_DISCARD_DELAY_MS = 420;
export const PONCHO_DRIFELLA_PACK_DISCARD_DURATION_MS = 380;
const PONCHO_DRIFELLA_CARD_INTERACTION_UNLOCK_DELAY_MS =
  PONCHO_DRIFELLA_PACK_DISCARD_DELAY_MS + Math.round(PONCHO_DRIFELLA_PACK_DISCARD_DURATION_MS / 2);
const PONCHO_DRIFELLA_ASSET_RETRY_DELAY_MS = 180;
const PONCHO_DRIFELLA_AUTOPLAY_FRAME_WAIT_MAX_MS = 9_000;
const PONCHO_DRIFELLA_AUTOPLAY_WINDOW_SIZE = 4;
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

type UsePonchoDrifellaRevealControllerOptions = {
  active: boolean;
  phase: PonchoDrifellaRevealPhase;
  boxLabel: string;
  cardReady: boolean;
  cardDisplayReady?: boolean;
  imageCache?: PonchoDrifellaImageCache;
  resetKey: string | number;
  onRequestReveal?: () => PonchoDrifellaRevealRequestStatus | void | Promise<PonchoDrifellaRevealRequestStatus | void>;
  onPlayClick?: () => void;
  onPlayReveal?: () => void;
  autoplayDelayMs?: number;
};

type PonchoDrifellaRevealControllerState = {
  phase: PonchoDrifellaRevealPhase;
  advanceLocked: boolean;
  stage: PonchoDrifellaRevealStage;
  boxFrameSrc: string;
  foregroundFrameSrc?: string;
  foregroundVisible: boolean;
  cardVisible: boolean;
  cardInteractive: boolean;
  note: string;
  revealComplete: boolean;
  revealFailedOpen: boolean;
  handleAdvance: () => void;
};

const ponchoImageCacheGeneration = new WeakMap<PonchoDrifellaImageCache, number>();
const ponchoImageCacheInvalidationListeners = new WeakMap<PonchoDrifellaImageCache, Set<() => void>>();
const ponchoPendingImageElements = new WeakMap<PonchoDrifellaImageCache, Map<string, HTMLImageElement>>();

function getPonchoDrifellaPendingElements(cache: PonchoDrifellaImageCache) {
  let pending = ponchoPendingImageElements.get(cache);
  if (!pending) {
    pending = new Map<string, HTMLImageElement>();
    ponchoPendingImageElements.set(cache, pending);
  }
  return pending;
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
  `${PONCHO_DRIFELLA_SEQUENCE_BASE_URL}/1/1`,
  PONCHO_DRIFELLA_SEGMENT_1_1_FRAME_IDS.length,
);
export const PONCHO_DRIFELLA_SEGMENT_1_2_FRAME_URLS = buildPonchoDrifellaNumberedFrameUrls(
  `${PONCHO_DRIFELLA_SEQUENCE_BASE_URL}/1/2`,
  PONCHO_DRIFELLA_SEGMENT_1_2_FRAME_IDS.length,
);
export const PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_FRAME_URLS = buildPonchoDrifellaNumberedFrameUrls(
  `${PONCHO_DRIFELLA_SEQUENCE_BASE_URL}/1/autoplay`,
  PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_FRAME_IDS.length,
);
export const PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_OVERTOP_FRAME_URLS = buildPonchoDrifellaNumberedFrameUrls(
  `${PONCHO_DRIFELLA_SEQUENCE_BASE_URL}/1/autoplay/overtop`,
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

function ponchoDrifellaAutoplayWindowSources(
  startIndex = 0,
  windowSize = PONCHO_DRIFELLA_AUTOPLAY_WINDOW_SIZE,
) {
  const safeStart = Math.max(0, Math.min(startIndex, PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_FRAME_URLS.length - 1));
  const safeEnd = Math.min(PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_FRAME_URLS.length, safeStart + Math.max(1, windowSize));
  const boxSources = PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_FRAME_URLS.slice(safeStart, safeEnd);
  const foregroundSources = PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_OVERTOP_FRAME_URLS.slice(safeStart, safeEnd);
  return {
    boxSources,
    foregroundSources,
    allSources: [...boxSources, ...foregroundSources],
  };
}

const PONCHO_DRIFELLA_INITIAL_AUTOPLAY_WINDOW_SOURCES = ponchoDrifellaAutoplayWindowSources(0).allSources;
const PONCHO_DRIFELLA_INITIAL_AUTOPLAY_FRAME_SOURCES = ponchoDrifellaAutoplayFrameSources(0);

function ponchoDrifellaOpeningSequenceResidentReady(imageCache?: PonchoDrifellaImageCache) {
  return !imageCache || arePonchoDrifellaImageSourcesResidentReady(PONCHO_DRIFELLA_OPENING_RESIDENT_FRAME_URLS, imageCache);
}

function ponchoDrifellaInitialAutoplayWindowResidentReady(imageCache?: PonchoDrifellaImageCache) {
  return !imageCache || arePonchoDrifellaImageSourcesResidentReady(PONCHO_DRIFELLA_INITIAL_AUTOPLAY_WINDOW_SOURCES, imageCache);
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

function ponchoDrifellaAutoplayFrameReady(
  frameIndex: number,
  imageCache?: PonchoDrifellaImageCache,
) {
  return arePonchoDrifellaImageSourcesResidentReady(ponchoDrifellaAutoplayFrameSources(frameIndex), imageCache);
}

function ponchoDrifellaAutoplayFrameSources(frameIndex: number) {
  const boxFrameSrc = PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_FRAME_URLS[frameIndex];
  const foregroundFrameSrc = PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_OVERTOP_FRAME_URLS[frameIndex];
  return [boxFrameSrc, foregroundFrameSrc].filter((frameSrc): frameSrc is string => Boolean(frameSrc));
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
    const settleSuccess = async () => {
      try {
        if (mode === 'resident') {
          await decodePonchoDrifellaImage(image);
        }
        if (getPonchoDrifellaCacheGeneration(imageCache) === generation) {
          imageCache.fetched.add(normalizedImageSrc);
          if (mode === 'resident') {
            imageCache.resident.set(normalizedImageSrc, image);
          }
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

    const settleError = () => {
      if (getPonchoDrifellaCacheGeneration(imageCache) === generation) {
        imageCache.pending.delete(normalizedImageSrc);
        imageCache.fetched.delete(normalizedImageSrc);
        imageCache.resident.delete(normalizedImageSrc);
      }
      pendingImages.delete(normalizedImageSrc);
      reject(new Error(`Failed to preload image: ${normalizedImageSrc}`));
    };

    image.onload = () => {
      void settleSuccess();
    };
    image.onerror = () => {
      settleError();
    };
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

function preloadPonchoDrifellaResidentImageSources(
  imageSources: readonly string[],
  imageCache: PonchoDrifellaImageCache,
) {
  preloadPonchoDrifellaImageSources(imageSources, imageCache, PONCHO_DRIFELLA_RESIDENT_PRELOAD_OPTIONS);
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
  return waitForPonchoDrifellaAssetsUntilReady(
    () =>
      waitForPonchoDrifellaImageSources(assetSources, imageCache, {
        ...PONCHO_DRIFELLA_RESIDENT_PRELOAD_OPTIONS,
        ...options,
      }),
    { signal, ...options },
  );
}

export function usePonchoDrifellaCardAssetsReady({
  active,
  card,
  imageCache,
}: {
  active: boolean;
  card: DrifCardConfig | undefined;
  imageCache: PonchoDrifellaImageCache;
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
      return () => {
        releasePonchoDrifellaCardAssets(card, imageCache);
      };
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
      releasePonchoDrifellaCardAssets(card, imageCache);
    };
  }, [active, card, imageCache, imageCacheGeneration]);

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

function ponchoDrifellaReleasePackResidentsForStage(
  stage: PonchoDrifellaRevealStage,
  stageFrameIndex: number,
  imageCache: PonchoDrifellaImageCache,
  previousKeepSources?: ReadonlySet<string> | null,
) {
  if (stage === 'autoplay' || stage === 'revealed') {
    const keepSources = new Set(ponchoDrifellaAutoplayWindowSources(stageFrameIndex).allSources);
    ponchoDrifellaAutoplayFrameSources(stageFrameIndex).forEach((frameSrc) => {
      keepSources.add(frameSrc);
    });
    const releaseSources = previousKeepSources
      ? Array.from(previousKeepSources).filter((frameSrc) => !keepSources.has(frameSrc))
      : PONCHO_DRIFELLA_ALL_PACK_FRAME_URLS.filter((frameSrc) => !keepSources.has(frameSrc));
    if (releaseSources.length) {
      releasePonchoDrifellaResidentImages(releaseSources, imageCache);
    }
    return keepSources;
  }

  if (stage === 'segment_1_1' || stage === 'segment_1_1_hold' || stage === 'segment_1_2' || stage === 'segment_1_2_hold') {
    releasePonchoDrifellaResidentImages(PONCHO_DRIFELLA_PUNCH_FRAME_URLS, imageCache);
  }

  return null;
}

export function usePonchoDrifellaRevealController({
  active,
  phase,
  boxLabel,
  cardReady,
  cardDisplayReady = true,
  imageCache,
  resetKey,
  onRequestReveal,
  onPlayClick,
  onPlayReveal,
  autoplayDelayMs = PONCHO_DRIFELLA_SEQUENCE_AUTOPLAY_DELAY_MS,
}: UsePonchoDrifellaRevealControllerOptions): PonchoDrifellaRevealControllerState {
  const imageCacheGeneration = usePonchoDrifellaImageCacheGeneration(imageCache);
  const [stage, setStage] = useState<PonchoDrifellaRevealStage>('idle');
  const [stageFrameIndex, setStageFrameIndex] = useState(0);
  const [activePunchFrameUrls, setActivePunchFrameUrls] = useState<readonly string[]>(
    PONCHO_DRIFELLA_PUNCH_FRAME_URLS_BY_VARIANT[0],
  );
  const [hasRevealAttempted, setHasRevealAttempted] = useState(false);
  const [autoplayQueued, setAutoplayQueued] = useState(false);
  const [cardInteractionUnlocked, setCardInteractionUnlocked] = useState(false);
  const [revealFailedOpen, setRevealFailedOpen] = useState(false);
  const [manualSequenceReady, setManualSequenceReady] = useState(() =>
    ponchoDrifellaOpeningSequenceResidentReady(imageCache),
  );
  const [autoplayWindowReady, setAutoplayWindowReady] = useState(() =>
    ponchoDrifellaInitialAutoplayWindowResidentReady(imageCache),
  );
  const revealSoundPlayedRef = useRef(false);
  const requestStateRef = useRef<'idle' | 'pending' | 'sent'>('idle');
  const requestGenerationRef = useRef(0);
  const stageRef = useRef<PonchoDrifellaRevealStage>('idle');
  const residentReleasePolicyKeyRef = useRef<string | null>(null);
  const residentKeepSourcesRef = useRef<Set<string> | null>(null);

  const selectPunchFrameUrls = useCallback(() => {
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
  }, [imageCache]);

  const resetRequestState = useCallback(() => {
    requestGenerationRef.current += 1;
    requestStateRef.current = 'idle';
  }, []);

  const resetRevealState = useCallback(() => {
    setStage('idle');
    setStageFrameIndex(0);
    setActivePunchFrameUrls(PONCHO_DRIFELLA_PUNCH_FRAME_URLS_BY_VARIANT[0]);
    setHasRevealAttempted(false);
    setAutoplayQueued(false);
    setCardInteractionUnlocked(false);
    setRevealFailedOpen(false);
    setManualSequenceReady(ponchoDrifellaOpeningSequenceResidentReady(imageCache));
    setAutoplayWindowReady(ponchoDrifellaInitialAutoplayWindowResidentReady(imageCache));
    revealSoundPlayedRef.current = false;
    resetRequestState();
  }, [imageCache, resetRequestState]);

  const startRevealRequest = useCallback(() => {
    if (!onRequestReveal) return;
    if (requestStateRef.current !== 'idle') return;
    requestGenerationRef.current += 1;
    const requestGeneration = requestGenerationRef.current;
    requestStateRef.current = 'pending';
    void Promise.resolve(onRequestReveal())
      .then((status) => {
        if (requestGenerationRef.current !== requestGeneration) return;
        const nextState = status === 'resolved' ? 'sent' : 'idle';
        requestStateRef.current = nextState;
      })
      .catch(() => {
        if (requestGenerationRef.current !== requestGeneration) return;
        requestStateRef.current = 'idle';
      });
  }, [onRequestReveal]);

  const failOpenReveal = useCallback(() => {
    setRevealFailedOpen(true);
    setAutoplayQueued(false);
    setStage('revealed');
  }, []);

  useEffect(() => {
    stageRef.current = stage;
  }, [stage]);

  useEffect(() => {
    resetRevealState();
  }, [imageCacheGeneration, resetKey, resetRevealState]);

  useEffect(() => {
    if (active) return;
    resetRevealState();
  }, [active, resetRevealState]);

  useEffect(() => {
    residentReleasePolicyKeyRef.current = null;
    residentKeepSourcesRef.current = null;
  }, [imageCacheGeneration, resetKey]);

  useEffect(() => {
    if (!active || !imageCache) {
      setManualSequenceReady(!imageCache);
      return undefined;
    }
    setManualSequenceReady(ponchoDrifellaOpeningSequenceResidentReady(imageCache));
    preloadPonchoDrifellaPackAssets(imageCache, PONCHO_DRIFELLA_WARM_PRELOAD_OPTIONS);
    const abortController = new AbortController();
    void waitForPonchoDrifellaResidentImageSources(
      PONCHO_DRIFELLA_OPENING_RESIDENT_FRAME_URLS,
      imageCache,
      abortController.signal,
    ).then((ready) => {
      if (abortController.signal.aborted) return;
      setManualSequenceReady(ready);
    });
    return () => {
      abortController.abort();
    };
  }, [active, imageCache, imageCacheGeneration, resetKey]);

  useEffect(() => {
    if (!active || !imageCache) return;
    preloadPonchoDrifellaResidentImageSources(PONCHO_DRIFELLA_INITIAL_AUTOPLAY_FRAME_SOURCES, imageCache);
  }, [active, imageCache, imageCacheGeneration, resetKey]);

  useEffect(() => {
    if (!active || !imageCache) {
      setAutoplayWindowReady(!imageCache);
      return undefined;
    }
    const shouldPrepareAutoplayWindow =
      cardReady ||
      stage === 'segment_1_2' ||
      stage === 'segment_1_2_hold' ||
      stage === 'autoplay' ||
      stage === 'revealed';
    if (!shouldPrepareAutoplayWindow) {
      setAutoplayWindowReady(ponchoDrifellaInitialAutoplayWindowResidentReady(imageCache));
      return undefined;
    }
    const requiredSources = PONCHO_DRIFELLA_INITIAL_AUTOPLAY_WINDOW_SOURCES;
    setAutoplayWindowReady(arePonchoDrifellaImageSourcesResidentReady(requiredSources, imageCache));
    const abortController = new AbortController();
    void waitForPonchoDrifellaResidentImageSources(requiredSources, imageCache, abortController.signal).then((ready) => {
      if (abortController.signal.aborted) return;
      setAutoplayWindowReady(ready);
    });
    return () => {
      abortController.abort();
    };
  }, [active, cardReady, imageCache, imageCacheGeneration, stage]);

  useEffect(() => {
    if (!active || !imageCache) return;
    const nextPolicyKey =
      stage === 'autoplay' || stage === 'revealed'
        ? `${stage}:${stageFrameIndex}`
        : stage === 'segment_1_1' || stage === 'segment_1_1_hold' || stage === 'segment_1_2' || stage === 'segment_1_2_hold'
          ? 'manual-segments'
          : null;
    if (residentReleasePolicyKeyRef.current === nextPolicyKey) {
      return;
    }
    residentReleasePolicyKeyRef.current = nextPolicyKey;
    residentKeepSourcesRef.current = ponchoDrifellaReleasePackResidentsForStage(
      stage,
      stageFrameIndex,
      imageCache,
      residentKeepSourcesRef.current,
    );
    if (nextPolicyKey === null) {
      residentKeepSourcesRef.current = null;
    }
  }, [active, imageCache, imageCacheGeneration, stage, stageFrameIndex]);

  useEffect(() => {
    if (!active || !imageCache) return;
    if (stage !== 'autoplay' && stage !== 'revealed') return;
    preloadPonchoDrifellaResidentImageSources(ponchoDrifellaAutoplayWindowSources(stageFrameIndex).allSources, imageCache);
  }, [active, imageCache, stage, stageFrameIndex]);

  useEffect(() => {
    if (!active || stage !== 'autoplay' || !imageCache) {
      return undefined;
    }
    const nextFrameIndex = stageFrameIndex + 1;
    if (nextFrameIndex >= PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_FRAME_URLS.length) {
      return undefined;
    }
    const requiredSources = ponchoDrifellaAutoplayFrameSources(nextFrameIndex);
    if (arePonchoDrifellaImageSourcesResidentReady(requiredSources, imageCache)) {
      return undefined;
    }
    const abortController = new AbortController();
    // Retry only the blocked next frame instead of restarting a full rolling-window loop every frame tick.
    void waitForPonchoDrifellaResidentImageSources(requiredSources, imageCache, abortController.signal);
    return () => {
      abortController.abort();
    };
  }, [active, imageCache, imageCacheGeneration, stage, stageFrameIndex]);

  useEffect(() => {
    if (!active || phase !== 'ready') return undefined;
    const frameDurationMs = ponchoDrifellaStageFrameDuration(stage, autoplayDelayMs);
    if (!frameDurationMs || typeof window === 'undefined') return undefined;

    const currentStage = stage;
    const currentFrameIndex = stageFrameIndex;
    let frameStart = performance.now();
    let animationFrameId = 0;
    let waitingForAutoplayFrameSince: number | null = null;

    const tick = (now: number) => {
      if (stageRef.current !== currentStage) return;
      if (now - frameStart < frameDurationMs) {
        animationFrameId = window.requestAnimationFrame(tick);
        return;
      }

      const advanceFrame = () => {
        frameStart = now;
        setStageFrameIndex((prevFrameIndex) => prevFrameIndex + 1);
      };

      if (currentStage === 'punch') {
        if (currentFrameIndex >= activePunchFrameUrls.length - 1) {
          setStage('idle');
          setStageFrameIndex(0);
          return;
        }
        advanceFrame();
        return;
      }

      if (currentStage === 'segment_1_1') {
        if (currentFrameIndex >= PONCHO_DRIFELLA_SEGMENT_1_1_FRAME_URLS.length - 1) {
          setStage('segment_1_1_hold');
          return;
        }
        advanceFrame();
        return;
      }

      if (currentStage === 'segment_1_2') {
        if (currentFrameIndex >= PONCHO_DRIFELLA_SEGMENT_1_2_FRAME_URLS.length - 1) {
          setStage('segment_1_2_hold');
          return;
        }
        advanceFrame();
        return;
      }

      if (currentStage === 'autoplay') {
        const nextFrameIndex = currentFrameIndex + 1;
        if (nextFrameIndex >= PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_FRAME_URLS.length) {
          setStage('revealed');
          return;
        }
        if (!ponchoDrifellaAutoplayFrameReady(nextFrameIndex, imageCache)) {
          if (waitingForAutoplayFrameSince === null) {
            waitingForAutoplayFrameSince = now;
          } else if (now - waitingForAutoplayFrameSince >= PONCHO_DRIFELLA_AUTOPLAY_FRAME_WAIT_MAX_MS) {
            // Fail open instead of indefinitely freezing the overlay when a frame cannot be recovered.
            failOpenReveal();
            return;
          }
          animationFrameId = window.requestAnimationFrame(tick);
          return;
        }
        waitingForAutoplayFrameSince = null;
        advanceFrame();
        return;
      }
    };

    animationFrameId = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [active, activePunchFrameUrls.length, autoplayDelayMs, failOpenReveal, imageCache, phase, stage, stageFrameIndex]);

  useEffect(() => {
    if (!active || stage !== 'revealed' || typeof window === 'undefined') {
      setCardInteractionUnlocked(false);
      return undefined;
    }
    setCardInteractionUnlocked(false);
    const timeoutId = window.setTimeout(() => {
      setCardInteractionUnlocked(true);
    }, PONCHO_DRIFELLA_CARD_INTERACTION_UNLOCK_DELAY_MS);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [active, stage]);

  const revealPhase = useMemo<PonchoDrifellaRevealPhase>(() => {
    if (phase === 'preparing') return 'preparing';
    if (stage === 'revealed' && cardReady) return 'revealed';
    return 'ready';
  }, [cardReady, phase, stage]);

  useEffect(() => {
    const revealSoundReady = stage === 'autoplay' || revealPhase === 'revealed';
    if (!revealSoundReady || revealSoundPlayedRef.current) return;
    revealSoundPlayedRef.current = true;
    onPlayReveal?.();
  }, [onPlayReveal, revealPhase, stage]);

  const animating = stage === 'punch' || stage === 'segment_1_1' || stage === 'segment_1_2' || stage === 'autoplay';
  const autoOpening = stage === 'autoplay';
  const revealResolved = cardReady;
  const fixedSequenceReady = revealResolved && cardDisplayReady && autoplayWindowReady;
  const revealSequenceReady = manualSequenceReady && fixedSequenceReady;
  const awaitingAutoplayReady = stage === 'segment_1_2_hold' && autoplayQueued && !fixedSequenceReady;
  const advanceLocked = autoOpening || awaitingAutoplayReady;
  const currentForegroundFrameSrc = ponchoDrifellaCurrentForegroundFrameSrc(stage, stageFrameIndex);
  const foregroundFrameSrc = ponchoDrifellaImageResidentReady(currentForegroundFrameSrc, imageCache)
    ? currentForegroundFrameSrc
    : undefined;
  const initialForegroundVisible =
    fixedSequenceReady &&
    ((stage === 'segment_1_2' && stageFrameIndex >= PONCHO_DRIFELLA_SEGMENT_1_2_FRAME_URLS.length - 1) ||
      stage === 'segment_1_2_hold');
  const autoplayForegroundVisible = fixedSequenceReady && (stage === 'autoplay' || stage === 'revealed');
  const autoplayVisualsVisible = autoplayForegroundVisible && Boolean(foregroundFrameSrc);
  const foregroundVisible = initialForegroundVisible || autoplayForegroundVisible;

  const boxFrameSrc = useMemo(
    () => ponchoDrifellaCurrentBoxFrameSrc(stage, stageFrameIndex, activePunchFrameUrls),
    [activePunchFrameUrls, stage, stageFrameIndex],
  );

  const note = useMemo(() => {
    if (revealPhase === 'preparing') return '';
    if (revealPhase === 'revealed') return '';
    if (advanceLocked) return 'opening...';
    return hasRevealAttempted ? `keep clicking the ${boxLabel}` : `click the ${boxLabel} to open`;
  }, [advanceLocked, boxLabel, hasRevealAttempted, revealPhase]);

  const cardVisible = autoplayVisualsVisible;
  const cardInteractive = stage === 'revealed' && cardInteractionUnlocked;

  const startPunch = useCallback(() => {
    setActivePunchFrameUrls(selectPunchFrameUrls());
    setStage('punch');
    setStageFrameIndex(0);
  }, [selectPunchFrameUrls]);

  const startSegment_1_1 = useCallback(() => {
    setStage('segment_1_1');
    setStageFrameIndex(0);
  }, []);

  const startSegment_1_2 = useCallback(() => {
    setStage('segment_1_2');
    setStageFrameIndex(0);
  }, []);

  const startAutoplay = useCallback(() => {
    setAutoplayQueued(false);
    setStage('autoplay');
    setStageFrameIndex(0);
  }, []);

  useEffect(() => {
    if (!active || phase !== 'ready' || stage !== 'segment_1_2_hold' || !autoplayQueued || !fixedSequenceReady) {
      return;
    }
    startAutoplay();
  }, [active, autoplayQueued, fixedSequenceReady, phase, stage, startAutoplay]);

  useEffect(() => {
    if (!active || phase !== 'ready' || !awaitingAutoplayReady || typeof window === 'undefined') {
      return undefined;
    }
    const timeoutId = window.setTimeout(() => {
      // Fail open rather than trapping the interaction in segment_1_2_hold.
      failOpenReveal();
    }, PONCHO_DRIFELLA_AUTOPLAY_FRAME_WAIT_MAX_MS);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [active, awaitingAutoplayReady, failOpenReveal, phase]);

  const handleAdvance = useCallback(() => {
    if (!active || phase !== 'ready' || advanceLocked) return;

    onPlayClick?.();
    setHasRevealAttempted(true);

    if (animating) {
      if (stageRef.current === 'punch') {
        startRevealRequest();
      }
      return;
    }

    if (!revealResolved) {
      startPunch();
      startRevealRequest();
      return;
    }

    if (stageRef.current === 'idle') {
      if (!revealSequenceReady) {
        startPunch();
        return;
      }
      startSegment_1_1();
      return;
    }
    if (stageRef.current === 'segment_1_1_hold') {
      startSegment_1_2();
      return;
    }
    if (stageRef.current === 'segment_1_2_hold') {
      if (!fixedSequenceReady) {
        setAutoplayQueued(true);
        return;
      }
      startAutoplay();
    }
  }, [
    active,
    advanceLocked,
    animating,
    fixedSequenceReady,
    revealSequenceReady,
    onPlayClick,
    phase,
    revealResolved,
    startAutoplay,
    startPunch,
    startRevealRequest,
    startSegment_1_1,
    startSegment_1_2,
  ]);

  return {
    phase: revealPhase,
    advanceLocked,
    stage,
    boxFrameSrc,
    foregroundFrameSrc,
    foregroundVisible,
    cardVisible,
    cardInteractive,
    note,
    revealComplete: stage === 'revealed',
    revealFailedOpen,
    handleAdvance,
  };
}
